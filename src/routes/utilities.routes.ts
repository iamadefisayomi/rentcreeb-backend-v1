import { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors';
import { uuid } from '../lib/common';
import { authenticate } from '../middleware/auth';
import { moneyLimit } from '../middleware/moneyLimit';
import { env } from '../config/env';
import { createPayment } from '../services/payments';
import { requestId, vtpassReady } from '../lib/vtpass';
import { catalog, feeFor, normalizePhone, plans, provider, requeryOrder, startDelivery, verifyCustomer } from '../services/utilities';

/**
 * Utility payments for tenants (and any signed-in user): airtime, data, electricity, cable TV, internet, exam PINs.
 * Rules and the money flow are in services/utilities.ts.
 */
const r = Router();
r.use(authenticate, moneyLimit);

const ORDER_COLS = 'id, category, service_id, provider_name, customer_id, customer_name, meter_type, variation_code, variation_name, phone, amount_kobo, fee_kobo, total_kobo, pay_method, status, token, units, error, provider_ref, payment_id, created_at, delivered_at';
const ready = () => { if (!vtpassReady()) throw new HttpError(503, 'Bill payments are coming soon', 'UTILITIES_UNAVAILABLE'); };
const prov = (serviceId: string) => { const p = provider(serviceId); if (!p) throw badRequest('Unknown service'); return p; };

/** What can be bought, plus the buyer's wallet balance (to offer "Pay from wallet"). */
r.get('/catalog', async (req, res) => {
  const { data: w } = await db.from('wallets').select('available_kobo').eq('user_id', req.user.id).maybeSingle();
  res.json({ ...catalog(), walletKobo: Number(w?.available_kobo ?? 0) });
});

/** Data plans, TV bouquets, internet bundles, exam PIN types. */
r.get('/plans', async (req, res) => {
  ready();
  const { serviceId } = z.object({ serviceId: z.string() }).parse(req.query);
  const p = prov(serviceId);
  if (p.pricing !== 'plan') throw badRequest('This service has no plans');
  res.json({ plans: await plans(serviceId) });
});

/** Look up the meter / smartcard / profile owner before paying. */
r.post('/verify', async (req, res) => {
  ready();
  const b = z.object({ serviceId: z.string(), customerId: z.string().trim().min(4).max(40), meterType: z.enum(['prepaid', 'postpaid']).optional(), planCode: z.string().optional() }).parse(req.body);
  const p = prov(b.serviceId);
  if (!p.verify) throw badRequest('This service does not need a check');
  if (p.category === 'electricity' && !b.meterType) throw badRequest('Choose prepaid or postpaid');
  const out = await verifyCustomer(p, b.customerId.replace(/\s/g, ''), b.meterType, b.planCode);
  if (!out.ok) throw badRequest(out.message, 'CUSTOMER_NOT_FOUND');
  res.json(out);
});

/**
 * Buy. payWith=wallet debits the wallet and delivers straight away; payWith=card returns a Paystack checkout and
 * delivery starts when the payment is confirmed.
 */
r.post('/orders', async (req, res) => {
  ready();
  const b = z.object({
    serviceId: z.string(), customerId: z.string().trim().min(4).max(60), amountKobo: z.number().int().positive().optional(),
    planCode: z.string().max(80).optional(), meterType: z.enum(['prepaid', 'postpaid']).optional(), phone: z.string().max(20).optional(),
    payWith: z.enum(['card', 'wallet']).default('card'),
  }).parse(req.body);
  const p = prov(b.serviceId);
  let customerId = b.customerId.replace(/\s/g, '');
  if (p.customer.kind === 'phone') { const n = normalizePhone(customerId); if (!n) throw badRequest('Enter a valid Nigerian phone number'); customerId = n; }
  const phone = normalizePhone(b.phone ?? '') ?? normalizePhone(req.user.phone ?? '') ?? (p.customer.kind === 'phone' ? customerId : null);
  if (!phone) throw badRequest('Add a phone number so the provider can reach you');

  // Price comes from the server: the plan's price, or the typed amount checked against the limits.
  let amountKobo: number; let plan: { code: string; name: string } | null = null;
  if (p.pricing === 'plan') {
    if (!b.planCode) throw badRequest('Choose a plan');
    const found = (await plans(p.serviceId)).find((x) => x.code === b.planCode);
    if (!found) throw badRequest('That plan is no longer available. Pick another one.');
    amountKobo = found.amountKobo; plan = found;
  } else {
    if (!b.amountKobo) throw badRequest('Enter an amount');
    if (b.amountKobo % 100) throw badRequest('Enter a whole naira amount');
    if (p.minKobo && b.amountKobo < p.minKobo) throw badRequest(`The minimum is ₦${(p.minKobo / 100).toLocaleString('en-NG')}`);
    if (p.maxKobo && b.amountKobo > p.maxKobo) throw badRequest(`The maximum is ₦${(p.maxKobo / 100).toLocaleString('en-NG')}`);
    amountKobo = b.amountKobo;
  }
  if (p.category === 'electricity' && !b.meterType) throw badRequest('Choose prepaid or postpaid');

  // Re-check the account on the server so money never goes to a mistyped meter or smartcard.
  let customerName: string | null = null;
  if (p.verify) {
    const v = await verifyCustomer(p, customerId, b.meterType, plan?.code);
    if (!v.ok) throw badRequest(v.message, 'CUSTOMER_NOT_FOUND');
    if (v.minimumKobo && amountKobo < v.minimumKobo) throw badRequest(`This meter needs at least ₦${(v.minimumKobo / 100).toLocaleString('en-NG')}`);
    customerName = v.customerName;
  }

  const fee = feeFor(p.category);
  // Unverified accounts can buy small amounts only (stolen cards are typically burnt on airtime / tokens).
  if (req.user.verification_status !== 'verified') {
    const { data: today } = await db.from('utility_orders').select('total_kobo').eq('user_id', req.user.id).in('status', ['awaiting_payment', 'processing', 'delivered'])
      .gte('created_at', new Date(Date.now() - 864e5).toISOString());
    const spent = (today ?? []).reduce((s, o: any) => s + Number(o.total_kobo), 0);
    if (spent + amountKobo + fee > env.UTILITY_UNVERIFIED_DAILY_KOBO)
      throw forbidden(`Verify your identity to spend more than ₦${(env.UTILITY_UNVERIFIED_DAILY_KOBO / 100).toLocaleString('en-NG')} a day on bills`, 'VERIFICATION_REQUIRED');
  }
  const order = unwrap(await db.from('utility_orders').insert({
    user_id: req.user.id, category: p.category, service_id: p.serviceId, provider_name: p.name, customer_id: customerId, customer_name: customerName,
    meter_type: p.category === 'electricity' ? b.meterType : null, variation_code: plan?.code ?? null, variation_name: plan?.name ?? null, phone,
    amount_kobo: amountKobo, fee_kobo: fee, total_kobo: amountKobo + fee, pay_method: b.payWith, request_id: requestId(),
  }).select(ORDER_COLS).single());

  if (b.payWith === 'wallet') {
    const { error } = await db.rpc('wallet_debit', { p_user: req.user.id, p_amount: amountKobo + fee, p_kind: 'utility', p_desc: [p.name, plan?.name].filter(Boolean).join(' · '), p_ref: `util:${order.id}` });
    if (error) {
      await db.from('utility_orders').update({ status: 'cancelled', error: 'Wallet payment failed' }).eq('id', order.id);
      throw error.message.includes('INSUFFICIENT_FUNDS') ? forbidden('Not enough money in your wallet. Pay by card instead.', 'INSUFFICIENT_FUNDS') : new HttpError(500, error.message);
    }
    await startDelivery(order.id);
    const { data: fresh } = await db.from('utility_orders').select(ORDER_COLS).eq('id', order.id).single();
    return res.status(201).json({ order: fresh });
  }
  const payment = await createPayment(req.user, 'utility', amountKobo + fee, { utility_order_id: order.id });
  await db.from('utility_orders').update({ payment_id: payment.paymentId }).eq('id', order.id);
  res.status(201).json({ order, payment });
});

/** My purchases, newest first. */
r.get('/orders', async (req, res) => {
  const { category } = z.object({ category: z.string().optional() }).parse(req.query);
  let q = db.from('utility_orders').select(ORDER_COLS).eq('user_id', req.user.id).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(100);
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  if (error) throw dbError(error);
  // A card order whose checkout was abandoned stays "awaiting_payment": hide those after a day.
  const stale = Date.now() - 864e5;
  res.json({ orders: (data ?? []).filter((o: any) => o.status !== 'awaiting_payment' || Date.parse(o.created_at) > stale) });
});

/** One purchase. While it's processing, ask VTpass again (at most every 20 s) so the receipt screen updates. */
r.get('/orders/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { data: o } = await db.from('utility_orders').select('*').eq('id', id).eq('user_id', req.user.id).maybeSingle();
  if (!o) throw notFound('Purchase not found');
  if (o.status === 'processing' && vtpassReady() && Date.now() - Date.parse(o.updated_at) > 20_000) await requeryOrder(o);
  const { data } = await db.from('utility_orders').select(ORDER_COLS).eq('id', id).single();
  res.json({ order: data });
});

export default r;
