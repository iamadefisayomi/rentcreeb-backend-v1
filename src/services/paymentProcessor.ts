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
  if (tx.amount !== Number(existing.amount_kobo)) {
    logger.error({ reference, paid: tx.amount, expected: existing.amount_kobo }, 'AMOUNT MISMATCH');
    await db.from('payments').update({ status: 'failed' }).eq('id', existing.id).eq('status', 'pending');
    return { status: 'failed', payment: existing };
  }

  const { data: payment } = await db.from('payments')
    .update({ status: 'success', paid_at: new Date().toISOString(), channel: tx.channel })
    .eq('id', existing.id).eq('status', 'pending').select().maybeSingle();
  if (!payment) return { status: 'success', payment: existing }; // another worker won the race

  const handlers: Record<string, (p: any) => Promise<void>> = {
    inspection: onInspection, subscription: onSubscription, rent: onRent, rentsave: onRentSave, job_escrow: onJobEscrow, job_topup: onJobTopup,
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
  const { data: sub } = await db.from('subscriptions').select('*, subscription_plans(interval_days)').eq('id', p.subscription_id).single();
  if (!sub) return;
  const now = new Date();
  await db.from('subscriptions').update({ status: 'expired' }).eq('agent_id', sub.agent_id).eq('status', 'active');
  await db.from('subscriptions').update({
    status: 'active', starts_at: now.toISOString(),
    expires_at: addDays(now, (sub as any).subscription_plans.interval_days).toISOString(),
  }).eq('id', sub.id);
  await notify(sub.agent_id, 'subscription_active', 'Plan activated', 'Your subscription is active. You can now list properties.');
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
  await db.from('conversations').upsert(
    { context_type: 'job', context_id: job.id, participant_a: job.landlord_id, participant_b: q.artisan_id },
    { onConflict: 'context_type,context_id' });
  await notify(q.artisan_id, 'quote_accepted', 'Your quote was accepted! 🎉', `${job.title} — payment is held in escrow.`, { jobId: job.id });
}

/** Landlord paid the extra amount for an approved higher final price: grow the escrow. */
async function onJobTopup(p: any) {
  const { data: e } = await db.from('escrows').select('*').eq('job_id', p.job_id).eq('kind', 'job').eq('status', 'held').single();
  if (!e) return;
  const newAmount = Number(e.amount_kobo) + Number(p.amount_kobo);
  await db.from('escrows').update({ amount_kobo: newAmount, fee_kobo: pct(newAmount, env.JOB_PLATFORM_FEE_PCT) }).eq('id', e.id);
  await db.from('jobs').update({ revision_status: 'approved' }).eq('id', p.job_id);
  await notify(e.payee_id, 'revision_approved', 'Revised amount approved', 'The landlord approved your updated final cost.', { jobId: p.job_id });
}
