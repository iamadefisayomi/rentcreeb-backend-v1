import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { db, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { kobo, phoneSchema, uuid } from '../lib/common';
import { sendSms } from '../lib/sms';
import { sendEmail } from '../lib/email';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { createPayment } from '../services/payments';
import { notify } from '../services/notify';
import { settleRent } from '../services/rent';
import { DEFAULT_REMINDER, sendRentReminder, TENANCY_SELECT, tenancyView, type TenancyState } from '../services/tenancy';

const r = Router();
r.use(authenticate);
const MANAGERS = ['landlord', 'estate_manager'] as const;
const today = () => new Date().toISOString().slice(0, 10);

async function getTenancy(id: string, userId: string) {
  const { data } = await db.from('tenancies').select(TENANCY_SELECT).eq('id', id).maybeSingle();
  if (!data) throw notFound('Tenancy not found');
  if (![(data as any).landlord_id, (data as any).tenant_id].includes(userId)) throw forbidden();
  return data as any;
}
const mustManage = (t: any, userId: string) => { if (t.landlord_id !== userId) throw forbidden(); };
const channelEnum = z.enum(['in_app', 'sms', 'email']);

/**
 * Landlord/estate manager adds a tenant to a property (optionally a specific unit).
 * If an account matches the email/phone it's attached now; otherwise the tenancy is created as an invite and
 * claimed automatically when that person signs up (DB trigger `claim_tenancy_invites`).
 */
r.post('/', requireRole(...MANAGERS), requireVerified, async (req, res) => {
  const b = z.object({
    propertyId: uuid, unitId: uuid.optional(), unitLabel: z.string().max(40).optional(),
    tenantName: z.string().trim().min(2).max(120).optional(),
    tenantEmail: z.string().email().toLowerCase().optional(), tenantPhone: phoneSchema.optional(),
    emergencyContactName: z.string().trim().max(120).optional(), emergencyContactPhone: z.string().trim().max(30).optional(),
    leaseStart: z.string().date(), leaseEnd: z.string().date().optional(), rentKobo: kobo,
    frequency: z.enum(['monthly', 'quarterly', 'yearly']).default('yearly'), firstDueDate: z.string().date().optional(),
  }).refine((x) => x.tenantEmail || x.tenantPhone, { message: 'Enter the tenant’s email or phone number', path: ['tenantEmail'] })
    .refine((x) => !x.leaseEnd || x.leaseEnd > x.leaseStart, { message: 'Lease end must be after the start', path: ['leaseEnd'] })
    .parse(req.body);

  const { data: prop } = await db.from('properties').select('owner_id, title').eq('id', b.propertyId).maybeSingle();
  if (!prop || prop.owner_id !== req.user.id) throw forbidden('Not your property');
  let unit: any = null;
  if (b.unitId) {
    unit = (await db.from('units').select('*').eq('id', b.unitId).eq('property_id', b.propertyId).maybeSingle()).data;
    if (!unit) throw notFound('Unit not found on this property');
    const { count } = await db.from('tenancies').select('id', { count: 'exact', head: true }).eq('unit_id', unit.id).eq('status', 'active');
    if (count) throw conflict('That unit already has an active tenant', 'UNIT_OCCUPIED');
  }

  const or = [b.tenantEmail && `email.eq.${b.tenantEmail}`, b.tenantPhone && `phone.eq.${b.tenantPhone}`].filter(Boolean).join(',');
  const { data: account } = await db.from('profiles').select('id, role').or(or).limit(1).maybeSingle();
  if (account && account.role !== 'tenant') throw badRequest('That email/phone belongs to a non-tenant account');

  const due = b.firstDueDate ?? b.leaseStart;
  const t = unwrap(await db.from('tenancies').insert({
    property_id: b.propertyId, unit_id: unit?.id ?? null, unit_label: unit?.label ?? b.unitLabel ?? null, landlord_id: req.user.id,
    tenant_id: account?.id ?? null, invite_name: b.tenantName ?? null, invite_email: b.tenantEmail ?? null, invite_phone: b.tenantPhone ?? null,
    emergency_contact_name: b.emergencyContactName ?? null, emergency_contact_phone: b.emergencyContactPhone ?? null,
    lease_start: b.leaseStart, lease_end: b.leaseEnd ?? null, rent_kobo: b.rentKobo, frequency: b.frequency, next_due_date: due,
  }).select().single());
  await db.from('rent_payments').insert({ tenancy_id: t.id, amount_kobo: b.rentKobo, due_date: due });
  if (unit) await db.from('units').update({ status: 'occupied' }).eq('id', unit.id);

  if (account) {
    await notify(account.id, 'tenancy_added', 'You were added to a property', `${prop.title}${unit ? ` · Unit ${unit.label}` : ''}. Track your rent in your dashboard.`, { tenancyId: t.id });
  } else {
    const where = `${prop.title}${unit ? `, Unit ${unit.label}` : ''}`;
    const link = env.APP_BASE_URL;
    if (b.tenantEmail) await sendEmail(b.tenantEmail, 'You’ve been invited to RentCreeb',
      `<p>Hi ${b.tenantName ?? 'there'},</p><p>Your landlord added you as a tenant at <b>${where}</b> on RentCreeb.</p><p>Download the app and sign up with this email to pay rent, track receipts and request repairs: <a href="${link}">${link}</a></p>`);
    if (b.tenantPhone) await sendSms(b.tenantPhone, `RentCreeb: you've been added as a tenant at ${where}. Sign up with this number to pay rent and request repairs: ${link}`);
  }
  res.status(201).json({ tenancy: t, invited: !account });
});

/** Rent reminders to one or many tenancies, from a template with {name} {amount} {due_date} {unit}. */
r.post('/reminders', requireRole(...MANAGERS), async (req, res) => {
  const b = z.object({
    tenancyIds: z.array(uuid).min(1).max(200),
    message: z.string().trim().min(10).max(500).default(DEFAULT_REMINDER),
    channels: z.array(channelEnum).min(1).default(['in_app']),
  }).parse(req.body);
  const { data } = await db.from('tenancies').select(TENANCY_SELECT).in('id', b.tenancyIds).eq('landlord_id', req.user.id).eq('status', 'active');
  let reminded = 0; const skipped: string[] = [];
  for (const t of (data ?? []) as any[]) {
    const used = await sendRentReminder(t, req.user.id, b.message, b.channels);
    if (used.length) reminded++; else skipped.push(t.id);
  }
  res.json({ reminded, skipped });
});

/** Landlord dashboard shortcut: remind every tenant whose rent is past due (optionally one property). */
r.post('/remind-overdue', requireRole(...MANAGERS), async (req, res) => {
  const b = z.object({ propertyId: uuid.optional(), channels: z.array(channelEnum).min(1).default(['in_app']) }).parse(req.body ?? {});
  let q = db.from('tenancies').select(TENANCY_SELECT).eq('landlord_id', req.user.id).eq('status', 'active');
  if (b.propertyId) q = q.eq('property_id', b.propertyId);
  const { data } = await q;
  let reminded = 0;
  for (const t of (data ?? []) as any[]) {
    if (tenancyView(t).state !== 'overdue') continue;
    if ((await sendRentReminder(t, req.user.id, DEFAULT_REMINDER, b.channels)).length) reminded++;
  }
  res.json({ reminded });
});

/** Tenant answers a lease renewal the landlord sent. Accepting extends the lease and updates the rent. */
r.post('/renewals/:renewalId/respond', requireRole('tenant'), async (req, res) => {
  const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
  const { data: rn } = await db.from('lease_renewals').select('*, tenancies(*)').eq('id', String(req.params.renewalId)).maybeSingle();
  if (!rn) throw notFound('Renewal not found');
  const t = (rn as any).tenancies;
  if (t.tenant_id !== req.user.id) throw forbidden();
  if (rn.status !== 'pending') throw badRequest('This renewal has already been answered', 'BAD_STATE');
  await db.from('lease_renewals').update({ status: accept ? 'accepted' : 'declined', responded_at: new Date().toISOString() }).eq('id', rn.id);
  if (accept) {
    await db.from('tenancies').update({ lease_end: rn.new_lease_end, rent_kobo: rn.new_rent_kobo }).eq('id', t.id);
    // Future instalments not yet paid move to the new rent.
    await db.from('rent_payments').update({ amount_kobo: rn.new_rent_kobo }).eq('tenancy_id', t.id).eq('status', 'due').gt('due_date', today());
  }
  await notify(t.landlord_id, 'tenancy_update', accept ? 'Lease renewal accepted' : 'Lease renewal declined',
    accept ? `Your tenant signed the renewal to ${rn.new_lease_end}.` : 'Your tenant declined the renewal offer.', { tenancyId: t.id });
  res.json({ status: accept ? 'accepted' : 'declined' });
});

/** Landlord withdraws a renewal the tenant hasn't answered. */
r.delete('/renewals/:renewalId', requireRole(...MANAGERS), async (req, res) => {
  const { data: rn } = await db.from('lease_renewals').select('id, landlord_id, status').eq('id', String(req.params.renewalId)).maybeSingle();
  if (!rn || rn.landlord_id !== req.user.id) throw notFound('Renewal not found');
  if (rn.status === 'pending') await db.from('lease_renewals').update({ status: 'cancelled', responded_at: new Date().toISOString() }).eq('id', rn.id);
  res.status(204).end();
});

/**
 * Landlord: tenancies with app-ready fields, filterable by state. Tenant: their tenancies.
 * ?state=active|overdue|expiring|vacating|invited|ended  ?q=search  ?propertyId=
 */
r.get('/', async (req, res) => {
  const f = z.object({ state: z.enum(['active', 'overdue', 'expiring', 'vacating', 'invited', 'ended']).optional(), q: z.string().optional(), propertyId: uuid.optional() }).parse(req.query);
  const col = req.user.role === 'tenant' ? 'tenant_id' : 'landlord_id';
  let q = db.from('tenancies').select(TENANCY_SELECT).eq(col, req.user.id).order('created_at', { ascending: false });
  if (f.propertyId) q = q.eq('property_id', f.propertyId);
  const rows = ((await q).data ?? []) as any[];
  const views = rows.map((t) => ({ ...t, rent_payments: undefined, lease_renewals: undefined, rent_reminders: undefined, view: tenancyView(t) }));
  const live = views.filter((v) => v.view.state !== 'ended');
  const counts: Record<TenancyState | 'total', number> = { total: live.length, active: 0, overdue: 0, expiring: 0, vacating: 0, invited: 0, ended: views.length - live.length };
  for (const v of live) counts[v.view.state as TenancyState]++;
  const needle = f.q?.trim().toLowerCase();
  const list = views.filter((v) => (f.state ? v.view.state === f.state : v.view.state !== 'ended'))
    .filter((v) => !needle || `${v.view.displayName} ${v.view.unit?.label ?? ''} ${v.view.property?.title ?? ''}`.toLowerCase().includes(needle));
  res.json({ tenancies: list, counts });
});

/** Documents the tenant chose to share with the landlord of this tenancy. */
r.get('/:id/documents', async (req, res) => {
  const t = await getTenancy(String(req.params.id), req.user.id);
  mustManage(t, req.user.id);
  const { data, error } = await db.from('user_documents').select('id, title, category, mime_type, size_bytes, created_at')
    .eq('tenancy_id', t.id).eq('shared_with_landlord', true).order('created_at', { ascending: false });
  res.json({ documents: error ? [] : data }); // empty before migration 012
});

r.get('/:id', async (req, res) => {
  const t = await getTenancy(String(req.params.id), req.user.id);
  const [{ data: payments }, { data: maintenance }, { data: reminders }] = await Promise.all([
    db.from('rent_payments').select('*').eq('tenancy_id', t.id).order('due_date', { ascending: false }),
    db.from('maintenance_requests').select('id, ticket_no, category, description, status, priority, created_at, resolved_at').eq('tenancy_id', t.id).order('created_at', { ascending: false }).limit(10),
    db.from('rent_reminders').select('channel, message, created_at').eq('tenancy_id', t.id).order('created_at', { ascending: false }).limit(10),
  ]);
  res.json({ tenancy: { ...t, rent_payments: undefined, lease_renewals: undefined, rent_reminders: undefined }, view: tenancyView(t), rentPayments: payments, maintenance, reminders });
});

r.patch('/:id', requireRole(...MANAGERS), async (req, res) => {
  const t = await getTenancy(String(req.params.id), req.user.id);
  mustManage(t, req.user.id);
  const b = z.object({
    leaseEnd: z.string().date().optional(), status: z.enum(['active', 'ended']).optional(), unitLabel: z.string().optional(),
    emergencyContactName: z.string().max(120).optional(), emergencyContactPhone: z.string().max(30).optional(),
  }).parse(req.body);
  const patch: Record<string, unknown> = {};
  if (b.leaseEnd !== undefined) patch.lease_end = b.leaseEnd;
  if (b.status !== undefined) patch.status = b.status;
  if (b.unitLabel !== undefined) patch.unit_label = b.unitLabel;
  if (b.emergencyContactName !== undefined) patch.emergency_contact_name = b.emergencyContactName;
  if (b.emergencyContactPhone !== undefined) patch.emergency_contact_phone = b.emergencyContactPhone;
  const updated = unwrap(await db.from('tenancies').update(patch).eq('id', t.id).select().single());
  if (b.status === 'ended' && t.unit_id) await db.from('units').update({ status: 'vacant' }).eq('id', t.unit_id);
  res.json({ tenancy: updated });
});

/**
 * Landlord records a rent payment made outside the app (bank transfer, cash, cheque) or via escrow.
 * Applies to the oldest unpaid instalment unless one is named; less than the instalment = part-payment.
 */
r.post('/:id/record-payment', requireRole(...MANAGERS), async (req, res) => {
  const t = await getTenancy(String(req.params.id), req.user.id);
  mustManage(t, req.user.id);
  const b = z.object({
    rentPaymentId: uuid.optional(), amountKobo: kobo,
    paidOn: z.string().date().refine((d) => d <= today(), 'Payment date can’t be in the future'),
    method: z.enum(['bank_transfer', 'cash', 'cheque', 'escrow']),
    reference: z.string().trim().max(80).optional(), notes: z.string().trim().max(500).optional(),
  }).parse(req.body);
  let q = db.from('rent_payments').select('*').eq('tenancy_id', t.id).neq('status', 'paid');
  q = b.rentPaymentId ? q.eq('id', b.rentPaymentId) : q.order('due_date').limit(1);
  const { data: inst } = await q.maybeSingle();
  if (!inst) throw badRequest('There is no unpaid rent to record against', 'NOTHING_DUE');
  if (b.amountKobo > Number(inst.amount_kobo)) throw badRequest(`That’s more than the ₦${(Number(inst.amount_kobo) / 100).toLocaleString('en-NG')} due for this period`, 'OVERPAYMENT');
  await settleRent(inst.id, null, { method: b.method, amountKobo: b.amountKobo, paidAt: new Date(`${b.paidOn}T12:00:00Z`).toISOString(), reference: b.reference, notes: b.notes, recordedBy: req.user.id });
  const fresh = await getTenancy(t.id, req.user.id);
  const outstandingKobo = (fresh.rent_payments ?? []).filter((p: any) => p.status !== 'paid' && p.due_date === inst.due_date).reduce((s: number, p: any) => s + Number(p.amount_kobo), 0);
  res.status(201).json({ view: tenancyView(fresh), outstandingKobo });
});

/** Landlord sends the tenant a renewal to sign (accept) in the app. */
r.post('/:id/renewals', requireRole(...MANAGERS), async (req, res) => {
  const t = await getTenancy(String(req.params.id), req.user.id);
  mustManage(t, req.user.id);
  if (t.status !== 'active' || t.terminates_on) throw badRequest('Only active leases without a termination notice can be renewed', 'BAD_STATE');
  if (!t.tenant_id) throw badRequest('The tenant hasn’t joined RentCreeb yet, so they can’t sign a renewal', 'TENANT_NOT_JOINED');
  const b = z.object({ newLeaseEnd: z.string().date(), newRentKobo: kobo }).parse(req.body);
  if (b.newLeaseEnd <= (t.lease_end ?? today())) throw badRequest('The new end date must be after the current lease end');
  const { data: existing } = await db.from('lease_renewals').select('id').eq('tenancy_id', t.id).eq('status', 'pending').maybeSingle();
  if (existing) throw conflict('A renewal is already waiting for the tenant’s signature', 'RENEWAL_PENDING');
  const rn = unwrap(await db.from('lease_renewals').insert({ tenancy_id: t.id, landlord_id: req.user.id, new_lease_end: b.newLeaseEnd, new_rent_kobo: b.newRentKobo }).select().single());
  await notify(t.tenant_id, 'lease_renewal', 'Lease renewal to sign',
    `Your landlord offered to renew until ${b.newLeaseEnd} at ₦${(b.newRentKobo / 100).toLocaleString('en-NG')} per ${t.frequency === 'yearly' ? 'year' : t.frequency === 'quarterly' ? 'quarter' : 'month'}.`,
    { tenancyId: t.id, renewalId: rn.id });
  res.status(201).json({ renewal: rn });
});

/** Landlord gives notice to end the lease. The tenancy ends automatically on `terminates_on` (scheduler). */
r.post('/:id/terminate', requireRole(...MANAGERS), async (req, res) => {
  const t = await getTenancy(String(req.params.id), req.user.id);
  mustManage(t, req.user.id);
  if (t.status !== 'active') throw badRequest('This lease has already ended', 'BAD_STATE');
  if (t.terminates_on) throw conflict('Notice has already been given on this lease', 'NOTICE_GIVEN');
  const b = z.object({
    noticeDays: z.union([z.literal(30), z.literal(60), z.literal(90)]),
    reason: z.enum(['non_payment', 'lease_violation', 'property_sold', 'end_of_term', 'mutual_agreement']),
  }).parse(req.body);
  const terminatesOn = new Date(Date.now() + b.noticeDays * 864e5).toISOString().slice(0, 10);
  await db.from('tenancies').update({ notice_given_at: new Date().toISOString(), notice_days: b.noticeDays, terminates_on: terminatesOn, termination_reason: b.reason }).eq('id', t.id);
  await db.from('lease_renewals').update({ status: 'cancelled', responded_at: new Date().toISOString() }).eq('tenancy_id', t.id).eq('status', 'pending');
  // Instalments due after the move-out date no longer apply.
  await db.from('rent_payments').delete().eq('tenancy_id', t.id).eq('status', 'due').gt('due_date', terminatesOn);
  const reasonText = { non_payment: 'non-payment of rent', lease_violation: 'violation of lease terms', property_sold: 'the property being sold', end_of_term: 'the end of the fixed term', mutual_agreement: 'mutual agreement' }[b.reason];
  if (t.tenant_id) await notify(t.tenant_id, 'lease_terminated', 'Notice to end your lease',
    `Your landlord has given ${b.noticeDays} days’ notice due to ${reasonText}. Your lease ends on ${terminatesOn}.`, { tenancyId: t.id });
  const phone = t.tenant?.phone ?? t.invite_phone;
  if (phone) await sendSms(phone, `RentCreeb: your landlord has given ${b.noticeDays} days' notice to end your lease (${reasonText}). Lease ends ${terminatesOn}.`);
  res.json({ terminatesOn });
});

/** Tenant pays the currently due rent via Paystack; landlord wallet is credited on success. */
r.post('/:id/pay-rent', requireRole('tenant'), requireVerified, async (req, res) => {
  const t = await getTenancy(String(req.params.id), req.user.id);
  if (t.tenant_id !== req.user.id || t.status !== 'active') throw forbidden();
  const { data: due } = await db.from('rent_payments').select('*').eq('tenancy_id', t.id).in('status', ['due', 'overdue']).order('due_date').limit(1).maybeSingle();
  if (!due) throw badRequest('No rent currently due', 'NOTHING_DUE');
  const payment = await createPayment(req.user, 'rent', Number(due.amount_kobo), { tenancy_id: t.id, rent_payment_id: due.id });
  res.status(201).json({ payment, rentPayment: due });
});

export default r;
