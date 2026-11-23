import { db } from '../lib/supabase';
import { paystack } from '../lib/paystack';
import { logger } from '../lib/logger';
import { addDays, pct } from '../lib/common';
import { env } from '../config/env';
import { issueOtp } from '../lib/otp';
import { sendSms } from '../lib/sms';
import { notify } from './notify';
import { settleRent } from './rent';
import { logForJob } from './maintenance';
import { ensureConversation } from './conversations';
import { settleBillPayment } from '../routes/bills.routes';
import { tellParties } from './jobOrders';
import { onUtilityPayment } from './utilities';

/**
 * Single entry point for confirming a Paystack payment (webhook AND client-side verify).
 * Idempotent: the pending->success transition happens exactly once.
 */
export async function confirmPayment(reference: string) {
  const tx = await paystack.verify(reference);
  const { data: existing } = await db.from('payments').select('*').eq('reference', reference).maybeSingle();
  if (!existing) return { status: 'unknown' as const };
  if (existing.status !== 'pending') return { status: existing.status as string, payment: existing };

  if (tx.status !== 'success') {
    if (['failed', 'abandoned', 'reversed'].includes(tx.status))
      await db.from('payments').update({ status: 'failed' }).eq('id', existing.id).eq('status', 'pending');
    return { status: tx.status, payment: existing };
  }
  // Never trust the amount, currency or reference blindly: the payment row is the source of truth.
  if (tx.amount !== Number(existing.amount_kobo) || (tx.currency && tx.currency !== 'NGN') || (tx.reference && tx.reference !== reference)) {
    logger.error({ reference, paid: tx.amount, currency: tx.currency, txRef: tx.reference, expected: existing.amount_kobo }, 'PAYMENT MISMATCH');
    await db.from('payments').update({ status: 'failed' }).eq('id', existing.id).eq('status', 'pending');
    return { status: 'failed', payment: existing };
  }

  const { data: payment } = await db.from('payments')
    .update({ status: 'success', paid_at: new Date().toISOString(), channel: tx.channel })
    .eq('id', existing.id).eq('status', 'pending').select().maybeSingle();
  if (!payment) return { status: 'success', payment: existing }; // another worker won the race

  const handlers: Record<string, (p: any) => Promise<void>> = {
    inspection: onInspection, subscription: onSubscription, rent: onRent, rentsave: onRentSave, job_escrow: onJobEscrow, job_topup: onJobTopup, bill: settleBillPayment, utility: onUtilityPayment, wallet_topup: onWalletTopup,
  };
  try { await handlers[payment.purpose](payment); }
  catch (err) { logger.error({ err, reference }, 'post-payment handler failed'); }
  return { status: 'success', payment };
}

async function onInspection(p: any) {
  const { data: b } = await db.from('bookings').select('*, properties(title), tenant:profiles!bookings_tenant_id_fkey(phone), host:profiles!bookings_host_id_fkey(phone)')
    .eq('id', p.booking_id).single();
  if (!b) return;
  await db.from('bookings').update({ status: 'paid' }).eq('id', b.id);
  await db.from('escrows').insert({
    kind: 'inspection', payment_id: p.id, booking_id: b.id, payer_id: b.tenant_id, payee_id: b.host_id,
    amount_kobo: b.amount_kobo, fee_kobo: b.fee_kobo,
  });
  // OTP goes to BOTH tenant and host; tenant enters it in-app to confirm the booking.
  const code = await issueOtp({ purpose: 'booking_confirm', bookingId: b.id });
  const msg = `RentCreeb: your booking code is ${code}. Never share it outside the app.`;
  if (b.tenant?.phone) await sendSms(b.tenant.phone, msg);
  if (b.host?.phone) await sendSms(b.host.phone, `RentCreeb: booking code for ${b.properties?.title} is ${code}.`);
  await notify(b.tenant_id, 'payment_success', 'Payment received', 'Enter the OTP sent to your phone to confirm your inspection.', { bookingId: b.id });
  await notify(b.host_id, 'booking_request', 'New inspection booking', `${b.properties?.title}`, { bookingId: b.id });
}

async function onSubscription(p: any) {
  const { data: sub } = await db.from('subscriptions').select('*, billing_cycle, subscription_plans(interval_days)').eq('id', p.subscription_id).single();
  if (!sub) return;
  const now = new Date();
  await db.from('subscriptions').update({ status: 'expired' }).eq('agent_id', sub.agent_id).eq('status', 'active');
  await db.from('subscriptions').update({
    status: 'active', starts_at: now.toISOString(),
    expires_at: addDays(now, (sub as any).billing_cycle === 'yearly' ? 365 : (sub as any).subscription_plans.interval_days).toISOString(),
  }).eq('id', sub.id);
  await notify(sub.agent_id, 'subscription_active', 'Plan activated', 'Your subscription is active. You can now list properties.');
}

/** Money added to the wallet by card / transfer. The wallet reference makes it credit exactly once. */
async function onWalletTopup(p: any) {
  await db.from('wallets').upsert({ user_id: p.user_id }, { onConflict: 'user_id', ignoreDuplicates: true });
  const { data: credited } = await db.rpc('wallet_credit', { p_user: p.user_id, p_amount: Number(p.amount_kobo), p_kind: 'topup', p_desc: 'Wallet top-up', p_ref: `topup:${p.id}` });
  if (credited) await notify(p.user_id, 'payment_success', 'Wallet funded 💰', `₦${(Number(p.amount_kobo) / 100).toLocaleString('en-NG')} was added to your RentCreeb wallet.`, { wallet: true });
}

async function onRent(p: any) {
  await settleRent(p.rent_payment_id, p.id);
}

async function onRentSave(p: any) {
  await db.rpc('rentsave_add', { p_plan: p.rentsave_plan_id, p_amount: p.amount_kobo });
  await notify(p.user_id, 'rentsave', 'Savings added', 'Your RentSave balance has been updated.', { planId: p.rentsave_plan_id });
}

async function onJobEscrow(p: any) {
  const { data: q } = await db.from('job_quotes').select('*, jobs(*)').eq('id', p.quote_id).single();
  if (!q) return;
  const job = (q as any).jobs;
  await db.from('escrows').insert({
    kind: 'job', payment_id: p.id, job_id: job.id, payer_id: p.user_id, payee_id: q.artisan_id,
    amount_kobo: q.amount_kobo, fee_kobo: pct(q.amount_kobo, env.JOB_PLATFORM_FEE_PCT),
  });
  await db.from('job_quotes').update({ status: 'accepted' }).eq('id', q.id);
  await db.from('job_quotes').update({ status: 'declined' }).eq('job_id', job.id).neq('id', q.id).eq('status', 'pending');
  await db.from('jobs').update({ status: 'assigned', artisan_id: q.artisan_id, accepted_quote_id: q.id }).eq('id', job.id);
  if (job.maintenance_request_id) await db.from('maintenance_requests').update({ status: 'in_progress' }).eq('id', job.maintenance_request_id);
  await logForJob(job, null, 'assigned', 'Artisan assigned — escrow funded');
  await ensureConversation('job', job.id, job.landlord_id, q.artisan_id);
  // A repair the tenant asked for: they approve the work, so they get their own chat with the artisan.
  if (job.tenant_id) await ensureConversation('job', job.id, job.tenant_id, q.artisan_id);
  await notify(q.artisan_id, 'quote_accepted', 'Your quote was accepted! 🎉', `${job.title} — payment is held in escrow.`, { jobId: job.id });
  // Tenant and landlord both follow every job order.
  const { data: a } = await db.from('profiles').select('first_name, last_name').eq('id', q.artisan_id).maybeSingle();
  const who = [a?.first_name, a?.last_name].filter(Boolean).join(' ') || 'An artisan';
  await tellParties(job, null, 'maintenance_update', 'Artisan assigned', `${job.title}: ${who} was hired and ₦${(Number(q.amount_kobo) / 100).toLocaleString('en-NG')} is held in escrow.`, { jobId: job.id });
}

/** The payer paid the extra amount for an approved higher final price: grow the escrow. */
async function onJobTopup(p: any) {
  // Compare-and-set so two top-ups confirmed at the same moment can't overwrite each other.
  let e: any = null;
  for (let i = 0; i < 5; i++) {
    const { data: cur } = await db.from('escrows').select('*').eq('job_id', p.job_id).eq('kind', 'job').eq('status', 'held').maybeSingle();
    if (!cur) { logger.error({ payment: p.id }, 'TOP-UP PAID BUT NO HELD ESCROW - needs manual refund'); return; }
    const newAmount = Number(cur.amount_kobo) + Number(p.amount_kobo);
    const { data: ok } = await db.from('escrows').update({ amount_kobo: newAmount, fee_kobo: pct(newAmount, env.JOB_PLATFORM_FEE_PCT) }).eq('id', cur.id).eq('amount_kobo', cur.amount_kobo).select('id').maybeSingle();
    if (ok) { e = cur; break; }
  }
  if (!e) { logger.error({ payment: p.id }, 'TOP-UP ESCROW UPDATE KEPT CONFLICTING'); return; }
  await db.from('jobs').update({ revision_status: 'approved' }).eq('id', p.job_id);
  await notify(e.payee_id, 'revision_approved', 'Revised amount approved', 'Your updated final cost was approved and paid into escrow.', { jobId: p.job_id });
  const { data: job } = await db.from('jobs').select('id, title, landlord_id, tenant_id').eq('id', p.job_id).maybeSingle();
  if (job) await tellParties(job, p.user_id, 'maintenance_update', 'Higher final price approved', `${job.title}: the difference was paid into escrow.`, { jobId: job.id });
}
