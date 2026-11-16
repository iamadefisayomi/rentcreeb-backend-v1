import type { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap, unwrapMaybe } from '../../lib/supabase';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { paginate, uuid } from '../../lib/common';
import { logger } from '../../lib/logger';
import { notify } from '../../services/notify';
import { confirmPayment } from '../../services/paymentProcessor';
import { refundEscrow, releaseEscrow } from '../../services/escrow';
import { PERSON, audit, dailySeries, isUuid, like, notesFor, sendCsv, sumKobo } from './shared';

const PAY_COLS = `id, purpose, reference, amount_kobo, status, channel, paid_at, created_at, booking_id, subscription_id, job_id, tenancy_id, rentsave_plan_id, user:profiles!payments_user_id_fkey(${PERSON})`;
const BOOKING_COLS = `id, status, scheduled_at, amount_kobo, fee_kobo, refund_kobo, cancelled_reason, confirmed_at, completed_at, created_at,
  properties(id, title, area), tenant:profiles!bookings_tenant_id_fkey(id, first_name, last_name, phone), host:profiles!bookings_host_id_fkey(id, first_name, last_name, phone)`;
const naira = (k: number) => `₦${(k / 100).toLocaleString()}`;

function paymentQuery(f: { status?: string; purpose?: string; q?: string; from?: string; to?: string }, cols = PAY_COLS, countIt = true) {
  let q: any = db.from('payments').select(cols, countIt ? { count: 'exact' } : undefined).order('created_at', { ascending: false });
  if (f.status) q = q.eq('status', f.status);
  if (f.purpose) q = q.eq('purpose', f.purpose);
  if (f.from) q = q.gte('created_at', f.from);
  if (f.to) q = q.lte('created_at', f.to + 'T23:59:59');
  if (f.q?.trim()) q = isUuid(f.q.trim()) ? q.or(`id.eq.${f.q.trim()},user_id.eq.${f.q.trim()}`) : q.ilike('reference', like(f.q));
  return q;
}
const payFilters = (query: unknown) => z.object({ status: z.string().optional(), purpose: z.string().optional(), q: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)) }).parse(query);

export function mountMoney(r: Router) {
  // ───────── Finance summary ─────────
  r.get('/finance', async (req, res) => {
    const { days } = z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }).parse(req.query);
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const [pays, released, held, wallets, pendingWd, failedPays] = await Promise.all([
      db.from('payments').select('purpose, amount_kobo, paid_at, created_at').eq('status', 'success').gte('created_at', since).limit(20000),
      db.from('escrows').select('fee_kobo, amount_kobo').eq('status', 'released').gte('released_at', since).limit(20000),
      db.from('escrows').select('amount_kobo').eq('status', 'held').limit(20000),
      db.from('wallets').select('available_kobo').gt('available_kobo', 0).limit(20000),
      db.from('withdrawals').select('amount_kobo').eq('status', 'pending').limit(5000),
      db.from('payments').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', since),
    ]);
    const byPurpose: Record<string, number> = {};
    for (const p of pays.data ?? []) byPurpose[p.purpose] = (byPurpose[p.purpose] ?? 0) + Number(p.amount_kobo);
    const subs = byPurpose.subscription ?? 0;
    res.json({
      days, grossKobo: sumKobo(pays.data), byPurpose, failedPayments: failedPays.count ?? 0,
      revenue: { subscriptionsKobo: subs, escrowFeesKobo: sumKobo(released.data, 'fee_kobo'), totalKobo: subs + sumKobo(released.data, 'fee_kobo') },
      liabilities: { escrowHeldKobo: sumKobo(held.data), walletBalancesKobo: (wallets.data ?? []).reduce((t, w: any) => t + Number(w.available_kobo), 0), pendingWithdrawalsKobo: sumKobo(pendingWd.data) },
      daily: dailySeries(pays.data ?? [], Math.min(days, 90), (p) => Number(p.amount_kobo)),
    });
  });

  // ───────── Payments ─────────
  r.get('/payments', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { data, count: total, error } = await paymentQuery(payFilters(req.query)).range(from, to);
    if (error) throw dbError(error);
    res.json({ payments: data, total: total ?? 0 });
  });
  r.get('/payments/export', async (req, res) => {
    const f = payFilters(req.query);
    const { data, error } = await paymentQuery(f, PAY_COLS, false).limit(20000);
    if (error) throw dbError(error);
    await audit(req, 'export.payments', 'export', null, { filters: f, rows: data?.length ?? 0 });
    sendCsv(res, `rentcreeb-payments-${new Date().toISOString().slice(0, 10)}.csv`, data ?? [], [
      ['created_at', 'Created'], ['paid_at', 'Paid'], ['reference', 'Reference'], ['purpose', 'Purpose'], ['status', 'Status'], ['channel', 'Channel'],
      ['amount_kobo', 'Amount (kobo)'], ['user.first_name', 'First name'], ['user.last_name', 'Last name'], ['user.email', 'Email'], ['user.phone', 'Phone'], ['id', 'Payment ID'],
    ]);
  });
  r.get('/payments/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: p } = await db.from('payments').select(PAY_COLS).eq('id', id).maybeSingle();
    if (!p) throw notFound('Payment not found');
    const [escrows, notes] = await Promise.all([db.from('escrows').select('*').eq('payment_id', id), notesFor('payment', id)]);
    res.json({ payment: p, escrows: escrows.data ?? [], notes });
  });
  /** Ask Paystack again (safe and idempotent): fixes payments stuck at "pending" when a webhook was missed. */
  r.post('/payments/:id/recheck', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: p } = await db.from('payments').select('reference, status').eq('id', id).maybeSingle();
    if (!p) throw notFound('Payment not found');
    const result = await confirmPayment(p.reference);
    await audit(req, 'payment.recheck', 'payment', id, { before: p.status, after: result.status });
    res.json({ before: p.status, status: result.status });
  });

  // ───────── Bookings (inspections) ─────────
  r.get('/bookings', async (req, res) => {
    const { from, to } = paginate(req.query);
    const f = z.object({ status: z.string().optional(), q: z.string().optional(), userId: z.string().uuid().optional() }).parse(req.query);
    let q = db.from('bookings').select(BOOKING_COLS, { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
    if (f.status) q = q.eq('status', f.status);
    if (f.userId) q = q.or(`tenant_id.eq.${f.userId},host_id.eq.${f.userId}`);
    if (f.q?.trim() && isUuid(f.q.trim())) q = q.or(`id.eq.${f.q.trim()},property_id.eq.${f.q.trim()}`);
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    res.json({ bookings: data, total: total ?? 0 });
  });
  r.get('/bookings/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: b } = await db.from('bookings').select(BOOKING_COLS).eq('id', id).maybeSingle();
    if (!b) throw notFound('Booking not found');
    const [payments, escrows, conv, reports, notes] = await Promise.all([
      db.from('payments').select('id, reference, amount_kobo, status, channel, paid_at, created_at').eq('booking_id', id),
      db.from('escrows').select('*').eq('booking_id', id),
      db.from('conversations').select('id').eq('context_type', 'booking').eq('context_id', id).maybeSingle(),
      db.from('reports').select('id, reason, status, created_at').eq('booking_id', id),
      notesFor('booking', id),
    ]);
    res.json({ booking: b, payments: payments.data ?? [], escrows: escrows.data ?? [], conversationId: conv.data?.id ?? null, reports: reports.data ?? [], notes });
  });
  /** Admin cancel: unpaid → cancelled; paid → refund the tenant (full by default) from escrow. */
  r.post('/bookings/:id/cancel', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ reason: z.string().min(3).max(300), refundKobo: z.number().int().min(0).optional() }).parse(req.body);
    const { data: bk } = await db.from('bookings').select('*, properties(title)').eq('id', id).maybeSingle();
    if (!bk) throw notFound('Booking not found');
    let refund = 0;
    if (bk.status === 'pending_payment') await db.from('bookings').update({ status: 'cancelled', cancelled_reason: b.reason }).eq('id', id);
    else if (['paid', 'confirmed'].includes(bk.status)) {
      const { data: e } = await db.from('escrows').select('id, amount_kobo').eq('booking_id', id).eq('status', 'held').maybeSingle();
      refund = Math.min(b.refundKobo ?? Number(bk.amount_kobo), Number(e?.amount_kobo ?? bk.amount_kobo));
      if (e && refund > 0) await refundEscrow(e.id, refund);
      await db.from('bookings').update({ status: refund > 0 ? 'refunded' : 'cancelled', refund_kobo: refund, cancelled_reason: b.reason }).eq('id', id);
    } else throw badRequest(`A ${bk.status.replace('_', ' ')} booking can't be cancelled`, 'BAD_STATE');
    const msg = `${(bk as any).properties?.title ?? 'Your inspection'} was cancelled by RentCreeb: ${b.reason}${refund ? ` Refund: ${naira(refund)}.` : ''}`;
    await notify(bk.tenant_id, 'booking_cancelled', 'Booking cancelled', msg, { bookingId: id });
    await notify(bk.host_id, 'booking_cancelled', 'Booking cancelled', msg, { bookingId: id });
    await audit(req, 'booking.cancel', 'booking', id, { reason: b.reason, refundKobo: refund, from: bk.status });
    res.json({ refundKobo: refund });
  });
  /** Mark an inspection done and pay the host (e.g. the tenant forgot to confirm). */
  r.post('/bookings/:id/complete', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);
    const { data: bk } = await db.from('bookings').select('id, status, host_id').eq('id', id).maybeSingle();
    if (!bk) throw notFound('Booking not found');
    if (!['paid', 'confirmed'].includes(bk.status)) throw badRequest('Only paid or confirmed bookings can be completed', 'BAD_STATE');
    const { data: e } = await db.from('escrows').select('id').eq('booking_id', id).eq('status', 'held').maybeSingle();
    if (e) await releaseEscrow(e.id);
    await db.from('bookings').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', id);
    await notify(bk.host_id, 'escrow_released', 'Inspection fee released', 'The inspection fee has been added to your wallet.', { bookingId: id });
    await audit(req, 'booking.complete', 'booking', id, { reason, escrowId: e?.id });
    res.status(204).end();
  });

  // ───────── Escrow ─────────
  r.get('/escrows', async (req, res) => {
    const { from, to } = paginate(req.query);
    const f = z.object({ status: z.enum(['held', 'released', 'refunded']).default('held'), kind: z.enum(['inspection', 'job']).optional() }).parse(req.query);
    let q = db.from('escrows').select('*, payer:profiles!escrows_payer_id_fkey(id, first_name, last_name), payee:profiles!escrows_payee_id_fkey(id, first_name, last_name), payments(reference)', { count: 'exact' })
      .eq('status', f.status).order('created_at', { ascending: f.status === 'held' }).range(from, to);
    if (f.kind) q = q.eq('kind', f.kind);
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    res.json({ escrows: data, total: total ?? 0 });
  });
  r.post('/escrows/:id/release', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);
    const e = await releaseEscrow(id);
    if (!e) throw conflict('This escrow is no longer held');
    await notify(e.payee_id, 'escrow_released', 'Payment released', `${naira(Number(e.amount_kobo) - Number(e.fee_kobo))} was added to your wallet.`);
    await audit(req, 'escrow.release', 'escrow', id, { reason, amountKobo: e.amount_kobo });
    res.status(204).end();
  });
  r.post('/escrows/:id/refund', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ reason: z.string().min(3).max(300), amountKobo: z.number().int().positive().optional() }).parse(req.body);
    const { data: held } = await db.from('escrows').select('amount_kobo, payer_id, booking_id').eq('id', id).eq('status', 'held').maybeSingle();
    if (!held) throw conflict('This escrow is no longer held');
    if (b.amountKobo && b.amountKobo > Number(held.amount_kobo)) throw badRequest('Refund cannot be more than the amount held');
    let result;
    try { result = await refundEscrow(id, b.amountKobo); }
    catch (err) { logger.error({ err, id }, 'admin escrow refund failed'); throw badRequest('Paystack refused the refund. Nothing was changed; check the Paystack dashboard.', 'REFUND_FAILED'); }
    if (held.booking_id) await db.from('bookings').update({ status: 'refunded', refund_kobo: result?.refunded ?? 0, cancelled_reason: b.reason }).eq('id', held.booking_id).in('status', ['paid', 'confirmed']);
    await notify(held.payer_id, 'refund', 'Refund on its way', `${naira(result?.refunded ?? 0)} is being refunded to your card or bank. ${b.reason}`);
    await audit(req, 'escrow.refund', 'escrow', id, { reason: b.reason, amountKobo: result?.refunded });
    res.json({ refundedKobo: result?.refunded ?? 0 });
  });

  // ───────── Withdrawals ─────────
  r.get('/withdrawals', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    let q = db.from('withdrawals').select(`*, user:profiles!withdrawals_user_id_fkey(${PERSON})`, { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
    if (status) q = q.eq('status', status);
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    const ids = [...new Set((data ?? []).map((w: any) => w.user_id))];
    const { data: banks } = ids.length ? await db.from('bank_accounts').select('user_id, bank_name, account_number, account_name').in('user_id', ids) : { data: [] as any[] };
    const bank = Object.fromEntries((banks ?? []).map((b: any) => [b.user_id, { bank_name: b.bank_name, account_name: b.account_name, account_number: '••••' + String(b.account_number).slice(-4) }]));
    res.json({ withdrawals: (data ?? []).map((w: any) => ({ ...w, bank: bank[w.user_id] ?? null })), total: total ?? 0 });
  });
  /** Resolve a withdrawal stuck at "pending" (Paystack webhook missed). "failed" puts the money back in the wallet. */
  r.post('/withdrawals/:id/resolve', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ outcome: z.enum(['success', 'failed']), reason: z.string().min(3).max(300) }).parse(req.body);
    const w = unwrapMaybe(await db.from('withdrawals').update({ status: b.outcome }).eq('id', id).eq('status', 'pending').select().maybeSingle());
    if (!w) throw conflict('Only pending withdrawals can be resolved');
    if (b.outcome === 'failed') await db.rpc('wallet_credit', { p_user: w.user_id, p_amount: w.amount_kobo, p_kind: 'withdrawal_reversal', p_desc: 'Withdrawal failed', p_ref: `wd-rev:${w.id}` });
    await notify(w.user_id, 'withdrawal_update', b.outcome === 'success' ? 'Withdrawal sent' : 'Withdrawal failed', b.outcome === 'success' ? `${naira(w.amount_kobo)} has been sent to your bank.` : `${naira(w.amount_kobo)} is back in your wallet. ${b.reason}`);
    await audit(req, `withdrawal.${b.outcome}`, 'withdrawal', id, { reason: b.reason, amountKobo: w.amount_kobo, userId: w.user_id });
    res.status(204).end();
  });

  // ───────── Subscriptions & plans ─────────
  r.get('/subscriptions', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    let q = db.from('subscriptions').select(`*, subscription_plans(name, price_kobo), agent:profiles!subscriptions_agent_id_fkey(${PERSON})`, { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
    if (status) q = q.eq('status', status);
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    res.json({ subscriptions: data, total: total ?? 0 });
  });
  /** Give someone a plan without payment (partners, compensation). Ends any current active plan first. */
  r.post('/subscriptions/grant', async (req, res) => {
    const b = z.object({ userId: z.string().uuid(), planId: z.string().uuid(), days: z.number().int().min(1).max(730), reason: z.string().min(3).max(300) }).parse(req.body);
    const { data: plan } = await db.from('subscription_plans').select('name').eq('id', b.planId).maybeSingle();
    if (!plan) throw notFound('Plan not found');
    await db.from('subscriptions').update({ status: 'cancelled' }).eq('agent_id', b.userId).eq('status', 'active');
    const now = new Date();
    const s = unwrap(await db.from('subscriptions').insert({ agent_id: b.userId, plan_id: b.planId, status: 'active', starts_at: now.toISOString(), expires_at: new Date(now.getTime() + b.days * 864e5).toISOString() }).select().single());
    await notify(b.userId, 'subscription_active', `${plan.name} plan activated`, `RentCreeb has given you ${b.days} days of ${plan.name}.`);
    await audit(req, 'subscription.grant', 'user', b.userId, { planId: b.planId, plan: plan.name, days: b.days, reason: b.reason, subscriptionId: s.id });
    res.status(201).json({ subscription: s });
  });
  r.post('/subscriptions/:id/extend', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ days: z.number().int().min(1).max(730), reason: z.string().min(3).max(300) }).parse(req.body);
    const { data: s } = await db.from('subscriptions').select('*').eq('id', id).maybeSingle();
    if (!s) throw notFound('Subscription not found');
    const base = Math.max(Date.now(), s.expires_at ? Date.parse(s.expires_at) : 0);
    const expires = new Date(base + b.days * 864e5).toISOString();
    await db.from('subscriptions').update({ expires_at: expires, status: 'active', starts_at: s.starts_at ?? new Date().toISOString() }).eq('id', id);
    await notify(s.agent_id, 'subscription_active', 'Subscription extended', `Your plan now runs until ${expires.slice(0, 10)}.`);
    await audit(req, 'subscription.extend', 'subscription', id, { days: b.days, reason: b.reason, expires });
    res.status(204).end();
  });
  r.post('/subscriptions/:id/cancel', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);
    const s = unwrapMaybe(await db.from('subscriptions').update({ status: 'cancelled' }).eq('id', id).in('status', ['active', 'pending']).select().maybeSingle());
    if (!s) throw conflict('Only active or pending subscriptions can be cancelled');
    await notify(s.agent_id, 'subscription_expired', 'Subscription cancelled', reason);
    await audit(req, 'subscription.cancel', 'subscription', id, { reason });
    res.status(204).end();
  });
  r.get('/plans', async (_req, res) => {
    const { data, error } = await db.from('subscription_plans').select('*').order('price_kobo');
    if (error) throw dbError(error);
    const counts = await Promise.all((data ?? []).map(async (p: any) => (await db.from('subscriptions').select('id', { count: 'exact', head: true }).eq('plan_id', p.id).eq('status', 'active')).count ?? 0));
    res.json({ plans: (data ?? []).map((p: any, i: number) => ({ ...p, activeSubscribers: counts[i] })) });
  });
  const planBody = z.object({ name: z.string().trim().min(2).max(40), priceKobo: z.number().int().min(0), intervalDays: z.number().int().min(1).max(730), listingLimit: z.number().int().min(0).nullable(), active: z.boolean().default(true) });
  r.post('/plans', async (req, res) => {
    const b = planBody.parse(req.body);
    const p = unwrap(await db.from('subscription_plans').insert({ name: b.name, price_kobo: b.priceKobo, interval_days: b.intervalDays, listing_limit: b.listingLimit, active: b.active }).select().single());
    await audit(req, 'plan.create', 'plan', p.id, b);
    res.status(201).json({ plan: p });
  });
  r.patch('/plans/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = planBody.partial().parse(req.body);
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.priceKobo !== undefined) patch.price_kobo = b.priceKobo;
    if (b.intervalDays !== undefined) patch.interval_days = b.intervalDays;
    if (b.listingLimit !== undefined) patch.listing_limit = b.listingLimit;
    if (b.active !== undefined) patch.active = b.active;
    const p = unwrap(await db.from('subscription_plans').update(patch).eq('id', id).select().single());
    await audit(req, 'plan.edit', 'plan', id, b);
    res.json({ plan: p });
  });

  // ───────── Tenancies / RentSave / jobs (oversight) ─────────
  r.get('/tenancies', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    let q = db.from('tenancies').select('id, status, rent_kobo, frequency, lease_start, lease_end, next_due_date, unit_label, invite_email, invite_phone, created_at, properties(id, title), landlord:profiles!tenancies_landlord_id_fkey(id, first_name, last_name), tenant:profiles!tenancies_tenant_id_fkey(id, first_name, last_name)', { count: 'exact' })
      .order('created_at', { ascending: false }).range(from, to);
    if (status) q = q.eq('status', status);
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    const ids = (data ?? []).map((t: any) => t.id);
    const { data: overdue } = ids.length ? await db.from('rent_payments').select('tenancy_id, amount_kobo').in('tenancy_id', ids).eq('status', 'overdue') : { data: [] as any[] };
    const od: Record<string, number> = {};
    for (const o of overdue ?? []) od[o.tenancy_id] = (od[o.tenancy_id] ?? 0) + Number(o.amount_kobo);
    res.json({ tenancies: (data ?? []).map((t: any) => ({ ...t, overdueKobo: od[t.id] ?? 0 })), total: total ?? 0 });
  });
  r.get('/tenancies/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: t } = await db.from('tenancies').select('*, properties(id, title, address), landlord:profiles!tenancies_landlord_id_fkey(id, first_name, last_name, phone, email), tenant:profiles!tenancies_tenant_id_fkey(id, first_name, last_name, phone, email)').eq('id', id).maybeSingle();
    if (!t) throw notFound('Tenancy not found');
    const [rent, maint, notes] = await Promise.all([
      db.from('rent_payments').select('*').eq('tenancy_id', id).order('due_date', { ascending: false }).limit(50),
      db.from('maintenance_requests').select('id, category, status, urgency, created_at').eq('tenancy_id', id).order('created_at', { ascending: false }).limit(30),
      notesFor('tenancy', id),
    ]);
    res.json({ tenancy: t, rentPayments: rent.data ?? [], maintenance: maint.data ?? [], notes });
  });
  r.get('/rentsave', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    let q = db.from('rentsave_plans').select(`*, tenant:profiles!rentsave_plans_tenant_id_fkey(${PERSON})`, { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
    if (status) q = q.eq('status', status);
    const [{ data, count: total, error }, all] = await Promise.all([q, db.from('rentsave_plans').select('saved_kobo, status').limit(20000)]);
    if (error) throw dbError(error);
    res.json({ plans: data, total: total ?? 0, summary: { savedKobo: (all.data ?? []).reduce((t: number, p: any) => t + Number(p.saved_kobo), 0), active: (all.data ?? []).filter((p: any) => p.status === 'active').length } });
  });
  r.get('/jobs', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    let q = db.from('jobs').select('id, title, category, status, urgency, budget_min_kobo, budget_max_kobo, created_at, completed_at, properties(id, title), landlord:profiles!jobs_landlord_id_fkey(id, first_name, last_name), artisan:profiles!jobs_artisan_id_fkey(id, first_name, last_name)', { count: 'exact' })
      .order('created_at', { ascending: false }).range(from, to);
    if (status) q = q.eq('status', status);
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    res.json({ jobs: data, total: total ?? 0 });
  });
  r.get('/jobs/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: j } = await db.from('jobs').select('*, properties(id, title, address), landlord:profiles!jobs_landlord_id_fkey(id, first_name, last_name, phone), artisan:profiles!jobs_artisan_id_fkey(id, first_name, last_name, phone)').eq('id', id).maybeSingle();
    if (!j) throw notFound('Job not found');
    const [quotes, escrows, media, conv, notes] = await Promise.all([
      db.from('job_quotes').select('id, amount_kobo, status, eta, notes, created_at, artisan:profiles!job_quotes_artisan_id_fkey(id, first_name, last_name)').eq('job_id', id),
      db.from('escrows').select('*').eq('job_id', id),
      db.from('job_media').select('kind, url').eq('job_id', id),
      db.from('conversations').select('id').eq('context_type', 'job').eq('context_id', id).maybeSingle(),
      notesFor('job', id),
    ]);
    res.json({ job: j, quotes: quotes.data ?? [], escrows: escrows.data ?? [], media: media.data ?? [], conversationId: conv.data?.id ?? null, notes });
  });
}
