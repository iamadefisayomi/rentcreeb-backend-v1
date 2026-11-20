import { env } from '../config/env';
import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { db } from '../lib/supabase';
import { paystack } from '../lib/paystack';
import { logger } from '../lib/logger';
import { forbidden, notFound } from '../lib/errors';
import { fullName, paginate } from '../lib/common';
import { authenticate } from '../middleware/auth';
import { confirmPayment } from '../services/paymentProcessor';

export const webhookRouter = Router();
const r = Router();

/** Paystack webhook. Mounted BEFORE auth; verified by HMAC signature over the raw body. */
webhookRouter.post('/paystack', async (req, res) => {
  if (!paystack.validWebhook(req.rawBody, req.headers['x-paystack-signature'] as string | undefined)) return res.status(401).end();
  res.sendStatus(200); // ack fast, process after
  const { event, data } = req.body ?? {};
  try {
    if (event === 'charge.success') await confirmPayment(data.reference);
    if (event === 'transfer.success') await db.from('withdrawals').update({ status: 'success' }).eq('reference', data.reference);
    if (event === 'transfer.failed' || event === 'transfer.reversed') {
      const { data: w } = await db.from('withdrawals').update({ status: event === 'transfer.failed' ? 'failed' : 'reversed' })
        .eq('reference', data.reference).eq('status', 'pending').select().maybeSingle();
      if (w) await db.rpc('wallet_credit', { p_user: w.user_id, p_amount: w.amount_kobo, p_kind: 'withdrawal_reversal', p_desc: 'Withdrawal reversed', p_ref: `wd-rev:${w.id}` });
    }
  } catch (err) { logger.error({ err, event }, 'webhook processing failed'); }
});

r.use(authenticate);

/** Client calls this after the Paystack sheet closes, as a fallback to the webhook. */
r.get('/verify/:reference', async (req, res) => {
  const { data: p } = await db.from('payments').select('user_id').eq('reference', req.params.reference).maybeSingle();
  if (!p) throw notFound('Payment not found');
  if (p.user_id !== req.user.id) throw forbidden();
  const result = await confirmPayment(req.params.reference);
  res.json({ status: result.status });
});

/** Transaction history. ?purpose=inspection,subscription,... */
/** Transaction History (Figma 4508:8120): a page of payments with a context line, plus (page 1) spend summary tiles. */
r.get('/', async (req, res) => {
  const { page, limit, from, to } = paginate(req.query);
  const purpose = typeof req.query.purpose === 'string' ? req.query.purpose.split(',') : null;
  let q = db.from('payments').select('id, purpose, reference, amount_kobo, status, channel, paid_at, created_at, booking_id, tenancy_id, job_id, rentsave_plan_id, bookings(properties(title), host:profiles!bookings_host_id_fkey(first_name, last_name))', { count: 'exact' })
    .eq('user_id', req.user.id).order('created_at', { ascending: false }).range(from, to);
  if (purpose) q = q.in('purpose', purpose);
  const { data, count } = await q;
  const rows = (data ?? []) as any[];

  // One context line per row: the property (booking / tenancy) or the job title.
  const tenancyIds = [...new Set(rows.map((p) => p.tenancy_id).filter(Boolean))];
  const jobIds = [...new Set(rows.map((p) => p.job_id).filter(Boolean))];
  const [ten, jobs] = await Promise.all([
    tenancyIds.length ? db.from('tenancies').select('id, properties(title)').in('id', tenancyIds) : Promise.resolve({ data: [] as any[] }),
    jobIds.length ? db.from('jobs').select('id, title').in('id', jobIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  const tenTitle = new Map((ten.data ?? []).map((t: any) => [t.id, t.properties?.title]));
  const jobTitle = new Map((jobs.data ?? []).map((j: any) => [j.id, j.title]));
  const payments = rows.map(({ bookings, ...p }) => ({
    ...p,
    // Who the payment went to (the agent for an inspection), for the website's transaction cards.
    counterparty: bookings?.host ? `${bookings.host.first_name ?? ''} ${bookings.host.last_name ?? ''}`.trim() || null : null,
    subtitle: bookings?.properties?.title ?? (p.tenancy_id ? tenTitle.get(p.tenancy_id) : null) ?? (p.job_id ? jobTitle.get(p.job_id) : null) ?? (p.purpose === 'rentsave' ? 'RentSave wallet' : null),
  }));

  let summary: { totalSpentKobo: number; thisMonthKobo: number; pendingKobo: number } | undefined;
  if (page === 1) {
    const { data: all } = await db.from('payments').select('amount_kobo, status, paid_at, created_at').eq('user_id', req.user.id).in('status', ['success', 'pending']);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const ok = (all ?? []).filter((p) => p.status === 'success');
    summary = {
      totalSpentKobo: ok.reduce((s, p) => s + Number(p.amount_kobo), 0),
      thisMonthKobo: ok.filter((p) => new Date(p.paid_at ?? p.created_at) >= monthStart).reduce((s, p) => s + Number(p.amount_kobo), 0),
      // Abandoned Paystack checkouts stay 'pending' forever — only count recent ones.
      pendingKobo: (all ?? []).filter((p) => p.status === 'pending' && Date.now() - new Date(p.created_at).getTime() < 864e5).reduce((s, p) => s + Number(p.amount_kobo), 0),
    };
  }
  res.json({ payments, summary, page, hasMore: (count ?? 0) > page * limit });
});

async function ownPayment(id: string, userId: string) {
  const { data } = await db.from('payments').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (!data) throw notFound('Receipt not found');
  return data;
}

const who = (x: any) => (x ? `${x.first_name ?? ''} ${x.last_name ?? ''}`.trim() || null : null);
const PURPOSE: Record<string, string> = { inspection: 'Inspection fee', rent: 'Rent payment', rentsave: 'RentSave deposit', job_escrow: 'Repair payment', job_topup: 'Repair top-up', subscription: 'Subscription', bill: 'Service charge / utility bill' };

/** What the payment was for, who it went to, and whether the money is still held in escrow (Figma Transaction Detail 4508:9319). */
async function receiptContext(p: any) {
  const ctx: { title: string; description: string | null; counterparty: string | null; counterpartyRole: string | null; property: { id: string; title: string; address: string } | null;
    escrow: { status: string; feeKobo: number; netKobo: number; releasedAt: string | null } | null; links: Record<string, string>; bookingStatus?: string } = {
    title: PURPOSE[p.purpose] ?? p.purpose, description: null, counterparty: null, counterpartyRole: null, property: null, escrow: null, links: {} };
  if (p.booking_id) {
    const { data: b } = await db.from('bookings').select('id, status, scheduled_at, properties(id, title, address), host:profiles!bookings_host_id_fkey(first_name, last_name)').eq('id', p.booking_id).maybeSingle();
    if (b) { const x: any = b; ctx.bookingStatus = x.status; ctx.property = x.properties; ctx.counterparty = who(x.host); ctx.counterpartyRole = 'Agent'; ctx.description = `Inspection on ${new Date(x.scheduled_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}`; ctx.links.bookingId = b.id; }
  }
  if (p.tenancy_id) {
    const { data: t } = await db.from('tenancies').select('id, unit_label, properties(id, title, address), landlord:profiles!tenancies_landlord_id_fkey(first_name, last_name)').eq('id', p.tenancy_id).maybeSingle();
    if (t) { const x: any = t; ctx.property = x.properties; ctx.counterparty = who(x.landlord); ctx.counterpartyRole = 'Landlord'; ctx.description = x.unit_label ? `Unit ${x.unit_label}` : null; ctx.links.tenancyId = t.id; }
  }
  if (p.rent_payment_id) {
    const { data: rp } = await db.from('rent_payments').select('due_date').eq('id', p.rent_payment_id).maybeSingle();
    if (rp) ctx.description = [ctx.description, `Due ${new Date(`${rp.due_date}T00:00:00Z`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}`].filter(Boolean).join(' · ');
  }
  if (p.job_id) {
    const { data: j } = await db.from('jobs').select('id, title, properties(id, title, address), artisan:profiles!jobs_artisan_id_fkey(first_name, last_name)').eq('id', p.job_id).maybeSingle();
    if (j) { const x: any = j; ctx.property = x.properties; ctx.counterparty = who(x.artisan); ctx.counterpartyRole = 'Artisan'; ctx.description = x.title; ctx.links.jobId = j.id; }
  }
  if (p.bill_item_id) {
    const { data: it } = await db.from('bill_items').select('unit_label, bill:bills(title, period_label, property:properties(id, title, address), landlord:profiles!bills_landlord_id_fkey(first_name, last_name))').eq('id', p.bill_item_id).maybeSingle();
    const x: any = it?.bill; if (x) { ctx.property = x.property; ctx.counterparty = who(x.landlord); ctx.counterpartyRole = 'Landlord'; ctx.description = [x.title, x.period_label, it?.unit_label].filter(Boolean).join(' · '); }
  }
  if (p.rentsave_plan_id) {
    const { data: r } = await db.from('rentsave_plans').select('id, name').eq('id', p.rentsave_plan_id).maybeSingle();
    if (r) { ctx.description = r.name; ctx.links.planId = r.id; }
  }
  if (p.subscription_id) {
    const { data: sub } = await db.from('subscriptions').select('starts_at, expires_at, subscription_plans(name)').eq('id', p.subscription_id).maybeSingle();
    if (sub) { const x: any = sub; ctx.description = `${x.subscription_plans?.name ?? 'Plan'} · until ${new Date(x.expires_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}`; }
  }
  const { data: e } = await db.from('escrows').select('status, amount_kobo, fee_kobo, released_at').eq('payment_id', p.id).maybeSingle();
  if (e) ctx.escrow = { status: e.status, feeKobo: Number(e.fee_kobo), netKobo: Number(e.amount_kobo) - Number(e.fee_kobo), releasedAt: e.released_at };
  return ctx;
}

r.get('/:id/receipt', async (req, res) => {
  const p = await ownPayment(String(req.params.id), req.user.id);
  res.json({ receipt: p, context: await receiptContext(p) });
});

r.get('/:id/receipt.pdf', async (req, res) => {
  const p = await ownPayment(String(req.params.id), req.user.id);
  if (p.status === 'pending') throw notFound('No receipt for an unpaid transaction');
  const ctx = await receiptContext(p);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${p.reference}.pdf"`);
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);
  doc.fontSize(22).text('RentCreeb', { align: 'left' }).moveDown(0.2);
  doc.fontSize(12).fillColor('#666').text('Payment receipt').moveDown(1.5).fillColor('#000');
  const rows: [string, string][] = [
    ['Reference', p.reference], ['Customer', fullName(req.user)], ['Purpose', ctx.title],
    ...(ctx.description ? [['Details', ctx.description] as [string, string]] : []),
    ...(ctx.property ? [['Property', `${ctx.property.title}, ${ctx.property.address}`] as [string, string]] : []),
    ...(ctx.counterparty ? [[ctx.counterpartyRole ?? 'Paid to', ctx.counterparty] as [string, string]] : []),
    ['Amount', `NGN ${(Number(p.amount_kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
    // VAT is included in RentCreeb's own service fees (residential rent is VAT-exempt).
    ...(env.VAT_PCT > 0 && ['inspection', 'subscription'].includes(p.purpose)
      ? [[`VAT (${env.VAT_PCT}%, included)`, `NGN ${((Number(p.amount_kobo) - Number(p.amount_kobo) / (1 + env.VAT_PCT / 100)) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`] as [string, string]]
      : []),
    ['Status', p.status], ['Channel', p.channel ?? '-'], ['Date', new Date(p.paid_at ?? p.created_at).toLocaleString('en-NG')],
  ];
  rows.forEach(([k, v]) => doc.fontSize(11).fillColor('#666').text(k, { continued: true }).fillColor('#000').text(`   ${v}`).moveDown(0.4));
  doc.end();
});

export default r;
