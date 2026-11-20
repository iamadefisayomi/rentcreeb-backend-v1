import { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { fullName, uuid } from '../lib/common';
import { authenticate, requireRole } from '../middleware/auth';
import { notify } from '../services/notify';

/**
 * Tenant screening, only with the tenant's consent. A landlord asks; the tenant sees exactly what will be shared and
 * agrees or declines; a shared report stays visible to that landlord for 30 days unless the tenant withdraws it.
 * The report uses only what RentCreeb knows first-hand: identity checks, rental history on RentCreeb, rent paid on
 * time, savings record, inspections, and upheld complaints. No credit bureau, no guesses.
 */
const r = Router();
r.use(authenticate);
const MANAGERS = ['landlord', 'estate_manager', 'agent'] as const;
const SHARE_DAYS = 30;

/** What the tenant agrees to share (shown on the consent screen, word for word). */
export const SHARED_ITEMS = [
  'Your name, photo and how long you have been on RentCreeb',
  'Whether your identity (NIN) and phone number are verified',
  'Your rental history on RentCreeb: how many tenancies, how long, and if any ended early',
  'Your rent payment record: payments made on time, late, and anything overdue now (amounts are not shown)',
  'Whether you are saving towards rent with RentSave (balances are not shown)',
  'How many inspections you completed, and any upheld complaints against you',
];

/** Landlord: ask a person to share their report. They must have interacted with you (booked one of your listings or is your tenant). */
r.post('/', requireRole(...MANAGERS), async (req, res) => {
  const b = z.object({ tenantId: uuid, propertyId: uuid.optional(), message: z.string().trim().max(400).optional() }).parse(req.body);
  if (b.tenantId === req.user.id) throw badRequest('You cannot screen yourself');
  const [{ count: booked }, { count: tenancy }] = await Promise.all([
    db.from('bookings').select('id', { count: 'exact', head: true }).eq('tenant_id', b.tenantId).eq('host_id', req.user.id),
    db.from('tenancies').select('id', { count: 'exact', head: true }).eq('tenant_id', b.tenantId).eq('landlord_id', req.user.id),
  ]);
  if (!booked && !tenancy) throw forbidden('You can only screen people who booked one of your properties or rent from you', 'NO_RELATIONSHIP');
  const { data: shared } = await db.from('screening_requests').select('id').eq('landlord_id', req.user.id).eq('tenant_id', b.tenantId).eq('status', 'shared').gt('expires_at', new Date().toISOString()).limit(1).maybeSingle();
  if (shared) return res.json({ request: shared, alreadyShared: true });
  const ins = await db.from('screening_requests').insert({ landlord_id: req.user.id, tenant_id: b.tenantId, property_id: b.propertyId ?? null, message: b.message ?? null }).select().single();
  if (ins.error?.code === '23505') throw conflict('You already asked; waiting for their answer', 'PENDING');
  const request = unwrap(ins);
  await notify(b.tenantId, 'screening_request', 'Rental profile request', `${fullName(req.user) || 'A landlord'} asked to see your RentCreeb rental profile. You decide.`, { screeningId: request.id });
  res.status(201).json({ request });
});

/** Both sides' lists. */
r.get('/', async (req, res) => {
  const sel = 'id, status, message, created_at, responded_at, expires_at, property:properties(id, title, area), landlord:profiles!screening_requests_landlord_id_fkey(id, first_name, last_name, avatar_url, role), tenant:profiles!screening_requests_tenant_id_fkey(id, first_name, last_name, avatar_url)';
  const [sent, received] = await Promise.all([
    db.from('screening_requests').select(sel).eq('landlord_id', req.user.id).order('created_at', { ascending: false }).limit(50),
    db.from('screening_requests').select(sel).eq('tenant_id', req.user.id).order('created_at', { ascending: false }).limit(50),
  ]);
  if (sent.error) throw dbError(sent.error);
  const now = Date.now();
  const live = (x: any) => ({ ...x, status: x.status === 'shared' && x.expires_at && Date.parse(x.expires_at) < now ? 'expired' : x.status });
  res.json({ sent: (sent.data ?? []).map(live), received: (received.data ?? []).map(live), sharedItems: SHARED_ITEMS, shareDays: SHARE_DAYS });
});

r.post('/:id/respond', requireRole('tenant'), async (req, res) => {
  const { share } = z.object({ share: z.boolean() }).parse(req.body);
  const { data: s } = await db.from('screening_requests').select('*').eq('id', uuid.parse(req.params.id)).eq('tenant_id', req.user.id).maybeSingle();
  if (!s) throw notFound('Request not found');
  if (s.status !== 'requested') throw badRequest('Already answered', 'BAD_STATE');
  const now = new Date();
  await db.from('screening_requests').update(share ? { status: 'shared', responded_at: now.toISOString(), expires_at: new Date(now.getTime() + SHARE_DAYS * 864e5).toISOString() } : { status: 'declined', responded_at: now.toISOString() }).eq('id', s.id);
  await notify(s.landlord_id, 'screening_request', share ? 'Rental profile shared' : 'Rental profile request declined', share ? `${fullName(req.user) || 'The applicant'} shared their RentCreeb rental profile.` : `${fullName(req.user) || 'The applicant'} chose not to share their profile.`, { screeningId: s.id });
  res.json({ status: share ? 'shared' : 'declined' });
});

r.post('/:id/revoke', requireRole('tenant'), async (req, res) => {
  const { data } = await db.from('screening_requests').update({ status: 'revoked', expires_at: new Date().toISOString() }).eq('id', uuid.parse(req.params.id)).eq('tenant_id', req.user.id).eq('status', 'shared').select('id').maybeSingle();
  if (!data) throw badRequest('Nothing to withdraw', 'BAD_STATE');
  res.json({ status: 'revoked' });
});

/** The report itself: landlord with a live share, or the tenant previewing their own. */
r.get('/:id/report', async (req, res) => {
  const { data: s } = await db.from('screening_requests').select('*').eq('id', uuid.parse(req.params.id)).maybeSingle();
  if (!s || ![s.landlord_id, s.tenant_id].includes(req.user.id)) throw notFound('Report not found');
  if (req.user.id === s.landlord_id && (s.status !== 'shared' || !s.expires_at || Date.parse(s.expires_at) < Date.now())) throw forbidden('This person has not shared their profile with you, or the share has ended', 'NOT_SHARED');
  res.json({ report: await buildReport(s.tenant_id), expiresAt: s.expires_at, status: s.status });
});
/** A tenant can always see their own profile exactly as a landlord would. */
r.get('/me/preview', requireRole('tenant'), async (req, res) => res.json({ report: await buildReport(req.user.id) }));

async function buildReport(tenantId: string) {
  const [{ data: p }, { data: ts }, { data: saves }, { count: inspections }, { count: upheld }] = await Promise.all([
    db.from('profiles').select('first_name, last_name, avatar_url, nin_verified, phone_verified, created_at, is_suspended').eq('id', tenantId).single(),
    db.from('tenancies').select('id, status, lease_start, lease_end, terminates_on, termination_reason, rent_payments(due_date, status, paid_at)').eq('tenant_id', tenantId),
    db.from('rentsave_plans').select('status, created_at').eq('tenant_id', tenantId),
    db.from('bookings').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'completed'),
    db.from('reports').select('id', { count: 'exact', head: true }).eq('agent_id', tenantId).eq('status', 'resolved'),
  ]);
  if (!p) throw notFound('Person not found');
  const pays = (ts ?? []).flatMap((t: any) => t.rent_payments ?? []);
  const paid = pays.filter((x: any) => x.status === 'paid');
  const onTime = paid.filter((x: any) => x.paid_at && x.paid_at.slice(0, 10) <= x.due_date).length;
  const months = (ts ?? []).reduce((m: number, t: any) => {
    const end = t.status === 'active' ? new Date() : new Date(t.terminates_on ?? t.lease_end ?? t.lease_start);
    return m + Math.max(0, Math.round((end.getTime() - new Date(t.lease_start).getTime()) / (30.4 * 864e5)));
  }, 0);
  const early = (ts ?? []).filter((t: any) => t.terminates_on && t.lease_end && t.terminates_on < t.lease_end).length;
  const score = !paid.length ? null : Math.round((onTime / paid.length) * 100);
  return {
    name: fullName(p), avatarUrl: p.avatar_url, memberSince: p.created_at, identityVerified: !!p.nin_verified, phoneVerified: !!p.phone_verified, restricted: !!p.is_suspended,
    rentals: { tenancies: (ts ?? []).length, active: (ts ?? []).filter((t: any) => t.status === 'active').length, monthsRenting: months, endedEarly: early },
    payments: { paid: paid.length, onTime, late: paid.length - onTime, overdueNow: pays.filter((x: any) => x.status === 'overdue').length, onTimePct: score },
    saving: { hasPlan: (saves ?? []).length > 0, activePlan: (saves ?? []).some((s: any) => s.status === 'active'), completedPlans: (saves ?? []).filter((s: any) => s.status === 'completed').length },
    inspectionsCompleted: inspections ?? 0, upheldComplaints: upheld ?? 0,
    generatedAt: new Date().toISOString(),
  };
}

export default r;
