import { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { uuid } from '../lib/common';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { moneyLimit } from '../middleware/moneyLimit';
import { createPayment } from '../services/payments';
import { notify } from '../services/notify';
import { logger } from '../lib/logger';

/**
 * Service charge & utility bills: a landlord splits an estate cost (service charge, diesel, water, security, waste…)
 * across a property's active tenancies, equally or by custom amounts. Tenants pay their share in the app (Paystack →
 * landlord's wallet) or the landlord records a cash/transfer payment or waives it.
 */
const r = Router();
r.use(authenticate, moneyLimit);
const MANAGERS = ['landlord', 'estate_manager'] as const;
export const BILL_CATEGORIES = ['service_charge', 'electricity', 'diesel', 'water', 'security', 'waste', 'maintenance', 'other'] as const;
const naira = (k: number | string) => `₦${(Number(k) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const ITEM_SELECT = 'id, bill_id, tenancy_id, tenant_id, unit_label, amount_kobo, status, method, paid_at, tenant:profiles!bill_items_tenant_id_fkey(id, first_name, last_name), tenancy:tenancies(invite_name)';

/** Landlord: active tenancies of a property, to preview a split. */
r.get('/split-preview', requireRole(...MANAGERS), async (req, res) => {
  const { propertyId } = z.object({ propertyId: uuid }).parse(req.query);
  const { data: p } = await db.from('properties').select('id, owner_id').eq('id', propertyId).maybeSingle();
  if (!p || p.owner_id !== req.user.id) throw notFound('Property not found');
  const { data } = await db.from('tenancies').select('id, unit_label, tenant_id, invite_name, tenant:profiles!tenancies_tenant_id_fkey(first_name, last_name)').eq('property_id', propertyId).eq('status', 'active');
  res.json({ tenancies: data ?? [] });
});

r.post('/', requireRole(...MANAGERS), requireVerified, async (req, res) => {
  const b = z.object({
    propertyId: uuid, title: z.string().trim().min(2).max(120), category: z.enum(BILL_CATEGORIES).default('service_charge'),
    periodLabel: z.string().trim().max(60).optional(), totalKobo: z.number().int().positive().optional(), split: z.enum(['equal', 'custom']).default('equal'),
    dueDate: z.string().date(), notes: z.string().trim().max(1000).optional(),
    tenancyIds: z.array(uuid).max(500).optional(), // equal split: who shares it (default: every active tenancy)
    items: z.array(z.object({ tenancyId: uuid, amountKobo: z.number().int().positive() })).max(500).optional(), // custom split
  }).parse(req.body);
  const { data: p } = await db.from('properties').select('id, owner_id, title').eq('id', b.propertyId).maybeSingle();
  if (!p || p.owner_id !== req.user.id) throw notFound('Property not found');
  const { data: active } = await db.from('tenancies').select('id, unit_label, tenant_id').eq('property_id', p.id).eq('status', 'active');
  const byId = new Map((active ?? []).map((t: any) => [t.id, t]));
  let shares: { tenancyId: string; amountKobo: number }[];
  if (b.split === 'custom') {
    if (!b.items?.length) throw badRequest('Enter each tenant\'s share');
    if (b.items.some((i) => !byId.has(i.tenancyId))) throw badRequest('Every share must be for an active tenancy on this property');
    shares = b.items;
  } else {
    const ids = (b.tenancyIds?.length ? b.tenancyIds : [...byId.keys()]).filter((id) => byId.has(id));
    if (!ids.length) throw badRequest('This property has no active tenants to bill');
    if (!b.totalKobo) throw badRequest('Enter the total amount');
    const each = Math.floor(b.totalKobo / ids.length);
    shares = ids.map((id, i) => ({ tenancyId: id, amountKobo: i === ids.length - 1 ? b.totalKobo! - each * (ids.length - 1) : each }));
  }
  const total = shares.reduce((s, x) => s + x.amountKobo, 0);
  const bill = unwrap(await db.from('bills').insert({ property_id: p.id, landlord_id: req.user.id, title: b.title, category: b.category, period_label: b.periodLabel ?? null,
    total_kobo: total, split: b.split, due_date: b.dueDate, notes: b.notes ?? null }).select().single());
  const items = unwrap(await db.from('bill_items').insert(shares.map((s) => ({ bill_id: bill.id, tenancy_id: s.tenancyId, tenant_id: (byId.get(s.tenancyId) as any)?.tenant_id ?? null, unit_label: (byId.get(s.tenancyId) as any)?.unit_label ?? null, amount_kobo: s.amountKobo }))).select());
  for (const it of items) if (it.tenant_id) await notify(it.tenant_id, 'bill', `New bill: ${b.title}`, `${naira(it.amount_kobo)} for ${p.title}${b.periodLabel ? ` (${b.periodLabel})` : ''}, due ${b.dueDate}.`, { billItemId: it.id });
  res.status(201).json({ bill, items });
});

/** Landlord: bills for one property (or all), with payment progress. */
r.get('/', requireRole(...MANAGERS), async (req, res) => {
  const { propertyId } = z.object({ propertyId: uuid.optional() }).parse(req.query);
  let q = db.from('bills').select(`*, property:properties(id, title), items:bill_items(${ITEM_SELECT})`).eq('landlord_id', req.user.id).order('created_at', { ascending: false }).limit(100);
  if (propertyId) q = q.eq('property_id', propertyId);
  const { data, error } = await q;
  if (error) throw dbError(error);
  res.json({ bills: (data ?? []).map((bl: any) => {
    const items = bl.items ?? [];
    const paid = items.filter((i: any) => i.status === 'paid').reduce((s: number, i: any) => s + Number(i.amount_kobo), 0);
    return { ...bl, collectedKobo: paid, outstandingKobo: items.filter((i: any) => ['due', 'overdue'].includes(i.status)).reduce((s: number, i: any) => s + Number(i.amount_kobo), 0), paidCount: items.filter((i: any) => i.status === 'paid').length };
  }) });
});

/** Tenant: my bills. */
r.get('/mine', async (req, res) => {
  const { data, error } = await db.from('bill_items').select('id, amount_kobo, status, method, paid_at, unit_label, created_at, bill:bills(id, title, category, period_label, due_date, notes, total_kobo, split, property:properties(title))')
    .eq('tenant_id', req.user.id).order('created_at', { ascending: false }).limit(100);
  if (error) throw dbError(error);
  res.json({ items: data ?? [] });
});

/** Tenant pays their share (Paystack). */
r.post('/items/:id/pay', requireVerified, async (req, res) => {
  const { data: it } = await db.from('bill_items').select('*, bill:bills(title)').eq('id', uuid.parse(req.params.id)).maybeSingle();
  if (!it || it.tenant_id !== req.user.id) throw notFound('Bill not found');
  if (!['due', 'overdue'].includes(it.status)) throw badRequest('This bill is already settled', 'SETTLED');
  const payment = await createPayment(req.user, 'bill', Number(it.amount_kobo), { bill_item_id: it.id });
  res.status(201).json({ payment, item: it });
});

/** Landlord records a payment made outside the app, or waives a share. */
r.post('/items/:id/record', requireRole(...MANAGERS), async (req, res) => {
  const { method } = z.object({ method: z.enum(['bank_transfer', 'cash', 'waived']) }).parse(req.body);
  const { data: it } = await db.from('bill_items').select('*, bill:bills(landlord_id, title)').eq('id', uuid.parse(req.params.id)).maybeSingle();
  if (!it || (it as any).bill?.landlord_id !== req.user.id) throw notFound('Bill not found');
  if (!['due', 'overdue'].includes(it.status)) throw badRequest('Already settled', 'SETTLED');
  await db.from('bill_items').update({ status: method === 'waived' ? 'waived' : 'paid', method, paid_at: new Date().toISOString(), recorded_by: req.user.id }).eq('id', it.id);
  if (it.tenant_id) await notify(it.tenant_id, 'bill', method === 'waived' ? 'Bill waived' : 'Bill payment recorded', `${(it as any).bill?.title}: ${method === 'waived' ? 'you don\'t need to pay this one' : `${naira(it.amount_kobo)} recorded as paid (${method.replace('_', ' ')})`}.`, { billItemId: it.id });
  res.json({ status: method === 'waived' ? 'waived' : 'paid' });
});

/** Landlord: remind everyone who hasn't paid a bill. */
r.post('/:id/remind', requireRole(...MANAGERS), async (req, res) => {
  const { data: bl } = await db.from('bills').select('id, title, landlord_id, due_date, items:bill_items(id, tenant_id, amount_kobo, status)').eq('id', uuid.parse(req.params.id)).maybeSingle();
  if (!bl || bl.landlord_id !== req.user.id) throw notFound('Bill not found');
  const unpaid = (bl.items ?? []).filter((i: any) => ['due', 'overdue'].includes(i.status) && i.tenant_id);
  for (const i of unpaid) await notify(i.tenant_id, 'bill', `Reminder: ${bl.title}`, `${naira(i.amount_kobo)} is due ${bl.due_date}. Pay in the app.`, { billItemId: i.id });
  res.json({ reminded: unpaid.length });
});

r.delete('/:id', requireRole(...MANAGERS), async (req, res) => {
  const { data: bl } = await db.from('bills').select('id, landlord_id, items:bill_items(status)').eq('id', uuid.parse(req.params.id)).maybeSingle();
  if (!bl || bl.landlord_id !== req.user.id) throw notFound('Bill not found');
  if ((bl.items ?? []).some((i: any) => i.status === 'paid')) throw forbidden('Some tenants already paid this bill: waive the rest instead of deleting it', 'HAS_PAYMENTS');
  await db.from('bills').delete().eq('id', bl.id);
  res.status(204).end();
});

export default r;

/** Payment confirmed: mark the share paid and credit the landlord's wallet (idempotent via the wallet reference). */
export async function settleBillPayment(p: { id: string; bill_item_id: string; amount_kobo: number }) {
  const { data: it } = await db.from('bill_items').update({ status: 'paid', method: 'paystack', paid_at: new Date().toISOString(), payment_id: p.id })
    .eq('id', p.bill_item_id).in('status', ['due', 'overdue']).select('*, bill:bills(landlord_id, title)').maybeSingle();
  if (!it) return;
  const b = (it as any).bill;
  await db.rpc('wallet_credit', { p_user: b.landlord_id, p_amount: Number(p.amount_kobo), p_kind: 'bill', p_desc: `Bill payment – ${b.title}`, p_ref: `bill:${it.id}` });
  await notify(b.landlord_id, 'bill', 'Bill payment received', `${naira(p.amount_kobo)} for ${b.title}${it.unit_label ? ` (${it.unit_label})` : ''}.`, {});
  if (it.tenant_id) await notify(it.tenant_id, 'bill', 'Bill paid ✅', `${b.title}: your receipt is in Transactions.`, { billItemId: it.id });
}

/** Scheduler: shares past their due date become overdue. */
export async function markOverdueBills() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: late } = await db.from('bills').select('id').lt('due_date', today).limit(1000);
    if (late?.length) await db.from('bill_items').update({ status: 'overdue' }).in('bill_id', late.map((b: any) => b.id)).eq('status', 'due');
  } catch (err) { logger.warn({ err }, 'overdue bills job failed'); }
}
