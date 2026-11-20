import { Router } from 'express';
import { ensureConversation } from '../services/conversations';
import { z } from 'zod';
import { env } from '../config/env';
import { db, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { pct, uuid } from '../lib/common';
import { issueOtp, verifyOtp } from '../lib/otp';
import { sendSms } from '../lib/sms';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { createPayment } from '../services/payments';
import { isWebUrl } from '../lib/webAuth';
import { confirmPayment } from '../services/paymentProcessor';
import { paystack } from '../lib/paystack';
import { refundEscrow, releaseEscrow } from '../services/escrow';
import { notify } from '../services/notify';

const r = Router();
r.use(authenticate);

const SELECT = '*, properties(id, title, address, area, price_kobo, property_media(url, position)), tenant:profiles!bookings_tenant_id_fkey(id, first_name, last_name, avatar_url), host:profiles!bookings_host_id_fkey(id, first_name, last_name, avatar_url)';

async function getBooking(id: string, userId: string) {
  const { data } = await db.from('bookings').select(SELECT).eq('id', id).maybeSingle();
  if (!data) throw notFound('Booking not found');
  if (![data.tenant_id, data.host_id].includes(userId)) throw forbidden();
  return data as any;
}

/** Step 5–6: create booking + start Paystack payment. Requires NIN verification. */
r.post('/', requireRole('tenant'), requireVerified, async (req, res) => {
  const { propertyId, scheduledAt, mode, callbackUrl } = z.object({
    propertyId: uuid, scheduledAt: z.coerce.date(), mode: z.enum(['in_person', 'virtual']).default('in_person'),
    callbackUrl: z.string().max(500).refine(isWebUrl, 'Unsupported callback URL').optional(), // website checkout
  }).parse(req.body);
  if (scheduledAt.getTime() < Date.now() + 2 * 3600 * 1000) throw badRequest('Choose a time at least 2 hours from now', 'BAD_DATE');

  const { data: p } = await db.from('properties').select('*').eq('id', propertyId).eq('status', 'approved').maybeSingle();
  if (!p) throw notFound('Property not available');
  if (p.owner_id === req.user.id) throw badRequest('You cannot book your own property');

  const { data: active } = await db.from('bookings').select('id, status').eq('tenant_id', req.user.id).eq('property_id', propertyId)
    .in('status', ['pending_payment', 'paid', 'confirmed']).maybeSingle();
  if (active) throw conflict('You already have an active booking for this property', 'BOOKING_EXISTS');

  const amount = Number(p.inspection_fee_kobo ?? env.INSPECTION_FEE_KOBO);
  const booking = unwrap(await db.from('bookings').insert({
    property_id: propertyId, tenant_id: req.user.id, host_id: p.owner_id, scheduled_at: scheduledAt.toISOString(),
    amount_kobo: amount, fee_kobo: pct(amount, env.INSPECTION_PLATFORM_FEE_PCT),
    ...(mode === 'virtual' ? { mode } : {}), // only sent when used, so in-person booking works before migration 022
  }).select().single());
  const payment = await createPayment(req.user, 'inspection', amount, { booking_id: booking.id }, { callbackUrl });
  res.status(201).json({ booking, payment });
});

r.get('/', async (req, res) => {
  const { status } = z.object({ status: z.string().optional() }).parse(req.query);
  let q = db.from('bookings').select(SELECT).or(`tenant_id.eq.${req.user.id},host_id.eq.${req.user.id}`).order('scheduled_at', { ascending: false });
  if (status) q = q.in('status', status.split(','));
  res.json({ bookings: (await q).data });
});

r.get('/:id', async (req, res) => res.json({ booking: await getBooking(String(req.params.id), req.user.id) }));

/**
 * Pay for a booking that is still waiting for payment (from My Bookings or the property page).
 * Reuses the booking's open Paystack checkout so the tenant can never pay twice for one booking; if Paystack says it
 * was already paid, settles it now. A new checkout is only started when the previous one failed outright.
 */
r.post('/:id/pay', requireRole('tenant'), async (req, res) => {
  const b = await getBooking(String(req.params.id), req.user.id);
  if (b.tenant_id !== req.user.id) throw forbidden();
  if (b.status === 'expired') throw badRequest('This booking expired before it was paid. Please book a new inspection time.', 'BOOKING_EXPIRED');
  if (b.status !== 'pending_payment') throw badRequest('This booking is already paid', 'ALREADY_PAID');
  const { data: last } = await db.from('payments').select('id, reference, access_code, status, amount_kobo')
    .eq('booking_id', b.id).eq('purpose', 'inspection').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (last?.status === 'success') { await confirmPayment(last.reference); return res.json({ status: 'paid' }); }
  if (last?.status === 'pending' && last.access_code) {
    let tx: { status: string } | null = null;
    try { tx = await paystack.verify(last.reference); } catch { /* not reachable / never opened: reuse the checkout */ }
    if (tx?.status === 'success') { await confirmPayment(last.reference); return res.json({ status: 'paid' }); }
    if (tx?.status !== 'failed' && tx?.status !== 'reversed')
      return res.json({ payment: { paymentId: last.id, reference: last.reference, authorizationUrl: `https://checkout.paystack.com/${last.access_code}`, accessCode: last.access_code, amountKobo: Number(last.amount_kobo) } });
    await db.from('payments').update({ status: 'failed' }).eq('id', last.id).eq('status', 'pending');
  }
  const payment = await createPayment(req.user, 'inspection', Number(b.amount_kobo), { booking_id: b.id });
  res.json({ payment });
});

/** Step 7: tenant enters OTP (sent to tenant + host) → booking confirmed, chat unlocked. */
r.post('/:id/confirm', async (req, res) => {
  const { code } = z.object({ code: z.string().length(6) }).parse(req.body);
  const b = await getBooking(String(req.params.id), req.user.id);
  if (b.tenant_id !== req.user.id) throw forbidden();
  if (b.status !== 'paid') throw badRequest('Booking is not awaiting confirmation', 'BAD_STATE');
  await verifyOtp({ purpose: 'booking_confirm', bookingId: b.id }, code);

  await db.from('bookings').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', b.id);
  await ensureConversation('booking', b.id, b.tenant_id, b.host_id);

  // Second code, used at the property: tenant shows it to the host who validates it (Agent "OTP Validation for Inspection").
  const inspectionCode = await issueOtp({ purpose: 'booking_inspection', bookingId: b.id });
  const { data: t } = await db.from('profiles').select('phone').eq('id', b.tenant_id).single();
  if (t?.phone) await sendSms(t.phone, `RentCreeb: your inspection code is ${inspectionCode}. Give it to the agent ONLY when you are at the property.`);
  await notify(b.host_id, 'booking_confirmed', 'Inspection confirmed', `${b.properties.title} — ${new Date(b.scheduled_at).toDateString()}`, { bookingId: b.id });
  res.json({ status: 'confirmed', message: 'Booking confirmed. Your inspection code was sent by SMS.' });
});

r.post('/:id/resend-otp', async (req, res) => {
  const b = await getBooking(String(req.params.id), req.user.id);
  if (b.tenant_id !== req.user.id || b.status !== 'paid') throw badRequest('Nothing to resend', 'BAD_STATE');
  const code = await issueOtp({ purpose: 'booking_confirm', bookingId: b.id });
  if (req.user.phone) await sendSms(req.user.phone, `RentCreeb: your booking code is ${code}.`);
  res.json({ message: 'Code resent' });
});

/**
 * Tenant "Show OTP" (Figma "Inspection OTP" 4502:1914): issues a fresh 15-minute inspection code and returns it to the
 * signed-in tenant to show the agent at the property. Replaces any earlier inspection code (incl. the SMS one).
 */
const SHOW_CODE_MIN = 15;
r.post('/:id/inspection-code', async (req, res) => {
  const b = await getBooking(String(req.params.id), req.user.id);
  if (b.tenant_id !== req.user.id) throw forbidden();
  if (b.status !== 'confirmed') throw badRequest('Your inspection code is available once the booking is confirmed', 'BAD_STATE');
  const code = await issueOtp({ purpose: 'booking_inspection', bookingId: b.id, ttlMin: SHOW_CODE_MIN, skipCooldown: true });
  res.json({ code, expiresAt: new Date(Date.now() + SHOW_CODE_MIN * 60000).toISOString() });
});

/** Host validates the tenant's inspection code at the property → escrow released to host wallet. */
r.post('/:id/validate-inspection', requireRole('agent', 'landlord', 'estate_manager'), async (req, res) => {
  const { code } = z.object({ code: z.string().length(6) }).parse(req.body);
  const b = await getBooking(String(req.params.id), req.user.id);
  if (b.host_id !== req.user.id) throw forbidden();
  if (b.status !== 'confirmed') throw badRequest('Booking is not confirmed', 'BAD_STATE');
  await verifyOtp({ purpose: 'booking_inspection', bookingId: b.id }, code);

  await db.from('bookings').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', b.id);
  const { data: e } = await db.from('escrows').select('id').eq('booking_id', b.id).eq('kind', 'inspection').maybeSingle();
  if (e) await releaseEscrow(e.id);
  await notify(b.tenant_id, 'inspection_done', 'Inspection complete', 'How was it? Leave a review or report an issue.', { bookingId: b.id, propertyId: b.property_id });
  res.json({ status: 'completed' });
});

/**
 * Virtual inspection done (a live video walkthrough instead of a visit; there is no OTP at a property).
 * The tenant can confirm it any time after it starts. The host can complete it only after a video call in this
 * booking's chat that was answered and lasted at least 3 minutes. Either way the fee is released to the host.
 */
const MIN_VIRTUAL_SECONDS = 180;
r.post('/:id/complete-virtual', async (req, res) => {
  const b = await getBooking(String(req.params.id), req.user.id);
  if (b.mode !== 'virtual') throw badRequest('This is an in-person inspection: use the inspection code at the property', 'NOT_VIRTUAL');
  if (b.status !== 'confirmed') throw badRequest('Booking is not confirmed', 'BAD_STATE');
  if (new Date(b.scheduled_at).getTime() - Date.now() > 30 * 60_000) throw badRequest('The virtual inspection has not started yet', 'TOO_EARLY');
  if (req.user.id === b.host_id) {
    const { data: conv } = await db.from('conversations').select('id').eq('context_type', 'booking').eq('context_id', b.id).limit(1).maybeSingle();
    const { data: calls } = conv ? await db.from('calls').select('answered_at, ended_at').eq('conversation_id', conv.id).eq('kind', 'video').not('answered_at', 'is', null) : { data: [] as any[] };
    const longest = Math.max(0, ...(calls ?? []).map((c: any) => (Date.parse(c.ended_at ?? new Date().toISOString()) - Date.parse(c.answered_at)) / 1000));
    if (longest < MIN_VIRTUAL_SECONDS) throw badRequest('Do the video walkthrough first: a video call of at least 3 minutes in this booking\'s chat. Or ask the tenant to confirm.', 'NO_CALL');
  }
  await db.from('bookings').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', b.id);
  const { data: e } = await db.from('escrows').select('id').eq('booking_id', b.id).eq('kind', 'inspection').maybeSingle();
  if (e) await releaseEscrow(e.id);
  await notify(b.tenant_id, 'inspection_done', 'Virtual inspection complete', 'How was it? Leave a review or report an issue.', { bookingId: b.id, propertyId: b.property_id });
  if (req.user.id === b.tenant_id) await notify(b.host_id, 'inspection_done', 'Virtual inspection confirmed', `${b.properties?.title ?? 'Inspection'}: the fee is on its way to your wallet.`, { bookingId: b.id });
  res.json({ status: 'completed' });
});

/** Tenant cancels: free before the cutoff window, otherwise a charge is withheld. Host decline = full refund. */
async function cancel(b: any, by: 'tenant' | 'host', reason?: string) {
  if (b.status === 'pending_payment') {
    await db.from('bookings').update({ status: by === 'host' ? 'declined' : 'cancelled', cancelled_reason: reason }).eq('id', b.id);
    return { refundKobo: 0 };
  }
  if (!['paid', 'confirmed'].includes(b.status)) throw badRequest('Booking can no longer be cancelled', 'BAD_STATE');
  const hoursLeft = (new Date(b.scheduled_at).getTime() - Date.now()) / 3600000;
  const charge = by === 'tenant' && hoursLeft < env.BOOKING_FREE_CANCEL_HOURS ? pct(b.amount_kobo, env.BOOKING_CANCEL_CHARGE_PCT) : 0;
  const { data: e } = await db.from('escrows').select('id').eq('booking_id', b.id).eq('kind', 'inspection').eq('status', 'held').maybeSingle();
  let refund = 0;
  if (e) {
    refund = b.amount_kobo - charge;
    await refundEscrow(e.id, refund);
  }
  await db.from('bookings').update({ status: 'refunded', refund_kobo: refund, cancelled_reason: reason }).eq('id', b.id);
  const other = by === 'tenant' ? b.host_id : b.tenant_id;
  await notify(other, 'booking_cancelled', 'Booking cancelled', b.properties?.title ?? '', { bookingId: b.id });
  return { refundKobo: refund, chargeKobo: charge };
}

r.post('/:id/cancel', requireRole('tenant'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
  const b = await getBooking(String(req.params.id), req.user.id);
  if (b.tenant_id !== req.user.id) throw forbidden();
  res.json(await cancel(b, 'tenant', reason));
});

r.post('/:id/decline', requireRole('agent', 'landlord', 'estate_manager'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
  const b = await getBooking(String(req.params.id), req.user.id);
  if (b.host_id !== req.user.id) throw forbidden();
  res.json(await cancel(b, 'host', reason));
});

export default r;
