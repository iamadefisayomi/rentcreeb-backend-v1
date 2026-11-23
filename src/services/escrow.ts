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
  const net = Number(e.amount_kobo) - Number(e.fee_kobo);
  if (net > 0) {
    const { error } = await db.rpc('wallet_credit', {
      p_user: e.payee_id, p_amount: net, p_kind: 'escrow_release',
      p_desc: e.kind === 'job' ? 'Job payment released' : 'Inspection fee released', p_ref: `escrow:${e.id}`,
    });
    if (error) {
      // Put it back on hold so it can be retried; never mark money released that nobody received.
      await db.from('escrows').update({ status: 'held', released_at: null }).eq('id', e.id).eq('status', 'released');
      logger.error({ err: error.message, escrowId }, 'ESCROW RELEASE CREDIT FAILED - escrow put back on hold');
      throw new Error('Could not release the payment right now. Please try again.');
    }
  }
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
  if (diff <= 0 || newAmountKobo <= 0) return;
  // Claim the change first (only one request can move it off the old amount), then refund. Stops double refunds.
  const { data: claimed } = await db.from('escrows').update({ amount_kobo: newAmountKobo, fee_kobo: pct(newAmountKobo, env.JOB_PLATFORM_FEE_PCT) })
    .eq('id', escrowId).eq('status', 'held').eq('amount_kobo', e.amount_kobo).select('id').maybeSingle();
  if (!claimed) return;
  try { await paystack.refund((e as any).payments.reference, diff); }
  catch (err) {
    await db.from('escrows').update({ amount_kobo: e.amount_kobo, fee_kobo: e.fee_kobo }).eq('id', escrowId).eq('amount_kobo', newAmountKobo);
    logger.error({ err, escrowId }, 'PARTIAL REFUND FAILED - escrow amount restored');
    throw err;
  }
}
