import { db } from '../lib/supabase';
import { addInterval } from '../lib/common';
import { notify } from './notify';

export type RentMethod = 'paystack' | 'bank_transfer' | 'cash' | 'cheque' | 'escrow' | 'rentsave';

/**
 * Marks a rent instalment paid and schedules the next one. Idempotent (a paid instalment is never re-settled).
 * - Paystack / RentSave money flowed through RentCreeb, so the landlord's wallet is credited.
 * - Manually recorded payments (bank transfer, cash, cheque, escrow) were paid to the landlord directly: no wallet credit.
 * - `amountKobo` below the instalment records a part-payment: the paid part is settled and the rest stays due.
 */
export async function settleRent(
  rentPaymentId: string,
  paymentId: string | null,
  opts: { method?: RentMethod; amountKobo?: number; paidAt?: string; reference?: string | null; notes?: string | null; recordedBy?: string | null } = {},
) {
  const method = opts.method ?? (paymentId ? 'paystack' : 'rentsave');
  const { data: current } = await db.from('rent_payments').select('*').eq('id', rentPaymentId).neq('status', 'paid').maybeSingle();
  if (!current) return false;

  const full = Number(current.amount_kobo);
  const paid = Math.min(opts.amountKobo ?? full, full);
  if (paid <= 0) return false;
  if (paid < full) {
    // Split: shrink this instalment to what was paid, carry the remainder as a new instalment with the same due date.
    await db.from('rent_payments').insert({ tenancy_id: current.tenancy_id, amount_kobo: full - paid, due_date: current.due_date, status: current.status });
  }

  const { data: rp } = await db.from('rent_payments')
    .update({
      status: 'paid', amount_kobo: paid, paid_at: opts.paidAt ?? new Date().toISOString(), payment_id: paymentId,
      method, reference: opts.reference ?? null, notes: opts.notes ?? null, recorded_by: opts.recordedBy ?? null,
    })
    .eq('id', rentPaymentId).neq('status', 'paid').select('*, tenancies(*)').maybeSingle();
  if (!rp) return false;
  const t = (rp as any).tenancies;

  if (method === 'paystack' || method === 'rentsave') {
    await db.rpc('wallet_credit', { p_user: t.landlord_id, p_amount: paid, p_kind: 'rent', p_desc: 'Rent payment', p_ref: `rent:${rp.id}` });
  }

  // Schedule the next instalment once nothing remains for this due date.
  const { count: stillDue } = await db.from('rent_payments').select('id', { count: 'exact', head: true })
    .eq('tenancy_id', t.id).eq('due_date', rp.due_date).neq('status', 'paid');
  if (!stillDue) {
    const next = addInterval(new Date(rp.due_date), t.frequency);
    const { count: exists } = await db.from('rent_payments').select('id', { count: 'exact', head: true }).eq('tenancy_id', t.id).gt('due_date', rp.due_date);
    if (!exists && (!t.lease_end || next <= new Date(t.lease_end)) && !t.terminates_on) {
      const nextDue = next.toISOString().slice(0, 10);
      await db.from('tenancies').update({ next_due_date: nextDue }).eq('id', t.id);
      await db.from('rent_payments').insert({ tenancy_id: t.id, amount_kobo: t.rent_kobo, due_date: nextDue });
    }
  }

  const naira = `₦${(paid / 100).toLocaleString('en-NG')}`;
  if (method === 'paystack' || method === 'rentsave') {
    await notify(t.landlord_id, 'rent_paid', 'Rent received', `A tenant paid ${naira} rent.`, { tenancyId: t.id });
  }
  if (t.tenant_id) {
    await notify(t.tenant_id, 'rent_paid', method === 'paystack' || method === 'rentsave' ? 'Rent payment successful' : 'Rent payment recorded',
      method === 'paystack' || method === 'rentsave' ? 'Your receipt is available in Transactions.' : `Your landlord recorded a ${naira} payment (${method.replace('_', ' ')}).`,
      { tenancyId: t.id });
  }
  return true;
}
