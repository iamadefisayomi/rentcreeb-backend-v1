import { db } from '../lib/supabase';
import { paystack } from '../lib/paystack';
import { logger } from '../lib/logger';
import { pct } from '../lib/common';
import { env } from '../config/env';

/** Releases a held escrow to the payee's wallet (net of fee). Idempotent. */
export async function releaseEscrow(escrowId: string) {
  const { data: e } = await db.from('escrows')
    .update({ status: 'released', released_at: new Date().toISOString() })
    .eq('id', escrowId).eq('status', 'held').select().maybeSingle();
  if (!e) return null; // already released/refunded
  await db.rpc('wallet_credit', {
    p_user: e.payee_id, p_amount: e.amount_kobo - e.fee_kobo, p_kind: 'escrow_release',
    p_desc: e.kind === 'job' ? 'Job payment released' : 'Inspection fee released', p_ref: `escrow:${e.id}`,
  });
  return e;
}

/** Refunds a held escrow back to the payer via Paystack. */
export async function refundEscrow(escrowId: string, refundKobo?: number) {
  const { data: e } = await db.from('escrows')
    .update({ status: 'refunded', released_at: new Date().toISOString() })
    .eq('id', escrowId).eq('status', 'held').select('*, payments(reference)').maybeSingle();
  if (!e) return null;
  const amount = refundKobo ?? e.amount_kobo;
  try {
    await paystack.refund((e as any).payments.reference, amount);
    await db.from('payments').update({ status: 'refunded' }).eq('id', e.payment_id);
  } catch (err) {
    logger.error({ err, escrowId }, 'REFUND FAILED - needs manual handling');
    await db.from('escrows').update({ status: 'held', released_at: null }).eq('id', escrowId); // roll back
    throw err;
  }
  return { escrow: e, refunded: amount };
}

/** Lowers a held job escrow (approved lower final price) and refunds the difference to the payer. */
export async function reduceEscrow(escrowId: string, newAmountKobo: number) {
  const { data: e } = await db.from('escrows').select('*, payments(reference)').eq('id', escrowId).eq('status', 'held').single();
  if (!e) return;
  const diff = Number(e.amount_kobo) - newAmountKobo;
  if (diff <= 0) return;
  await paystack.refund((e as any).payments.reference, diff);
  await db.from('escrows').update({ amount_kobo: newAmountKobo, fee_kobo: pct(newAmountKobo, env.JOB_PLATFORM_FEE_PCT) }).eq('id', escrowId);
}
