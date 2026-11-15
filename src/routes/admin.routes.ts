import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap, unwrapMaybe } from '../lib/supabase';
import { badRequest, notFound } from '../lib/errors';
import { signPrivateUrl } from '../lib/bunny';
import { paginate, uuid } from '../lib/common';
import { authenticate, requireRole } from '../middleware/auth';
import { notify } from '../services/notify';
import { logger } from '../lib/logger';

/**
 * Admin API, used by the web dashboard served at /admin (backend/admin).
 * Every route needs a signed-in profile with role 'admin'. Every change is written to admin_actions.
 */
const r = Router();
r.use(authenticate, requireRole('admin'));

const decision = z.object({ approve: z.boolean(), reason: z.string().optional() });
const PERSON = 'id, first_name, last_name, email, phone, role, avatar_url';

/** Record who did what (best effort: a missing admin_actions table must not block moderation). */
async function audit(req: Request, action: string, targetType: string, targetId: string | null, details: Record<string, unknown> = {}) {
  const { error } = await db.from('admin_actions').insert({ admin_id: req.user.id, action, target_type: targetType, target_id: targetId, details });
  if (error) logger.warn({ err: error, action }, 'admin audit write failed (apply migration 011)');
}

/** Exact row count for a filtered table; 0 if the table doesn't exist yet. */
async function count(table: string, filter?: (q: any) => any) {
  let q: any = db.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  return error ? 0 : n ?? 0;
}
const sumKobo = (rows: { amount_kobo: number | string }[] | null) => (rows ?? []).reduce((t, x) => t + Number(x.amount_kobo || 0), 0);
const like = (s: string) => `%${s.replace(/[%_,()]/g, ' ').trim()}%`;

// ───────── Overview ─────────
r.get('/overview', async (_req, res) => {
  const d30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const d7 = new Date(Date.now() - 7 * 864e5).toISOString();
  const [
    users, newUsers7d, tenants, landlords, agents, artisans, suspended,
    pendingProperties, liveProperties, pendingArtisans, manualVerifications, openReports, openTickets, flaggedReviews,
    bookings7d, activeSubs, pay30, escrowHeld, recent,
  ] = await Promise.all([
    count('profiles'), count('profiles', (q) => q.gte('created_at', d7)),
    count('profiles', (q) => q.eq('role', 'tenant')), count('profiles', (q) => q.in('role', ['landlord', 'estate_manager'])),
    count('profiles', (q) => q.eq('role', 'agent')), count('profiles', (q) => q.eq('role', 'artisan')), count('profiles', (q) => q.eq('is_suspended', true)),
    count('properties', (q) => q.eq('status', 'pending')), count('properties', (q) => q.eq('status', 'approved')),
    count('artisan_profiles', (q) => q.eq('review_status', 'pending')), count('verifications', (q) => q.eq('status', 'manual_review')),
    count('reports', (q) => q.in('status', ['open', 'investigating'])), count('support_tickets', (q) => q.in('status', ['open', 'in_progress'])),
    count('reviews', (q) => q.gt('flag_count', 0).eq('hidden', false)),
    count('bookings', (q) => q.gte('created_at', d7)), count('subscriptions', (q) => q.eq('status', 'active')),
    db.from('payments').select('amount_kobo').eq('status', 'success').gte('created_at', d30).limit(10000),
    db.from('escrows').select('amount_kobo').eq('status', 'held').limit(10000),
    db.from('admin_actions').select('id, action, target_type, target_id, details, created_at, admin:profiles!admin_actions_admin_id_fkey(first_name, last_name)').order('created_at', { ascending: false }).limit(12),
  ]);
  res.json({
    users: { total: users, new7d: newUsers7d, tenants, landlords, agents, artisans, suspended },
    queues: { pendingProperties, pendingArtisans, manualVerifications, openReports, openTickets, flaggedReviews },
    activity: { liveProperties, bookings7d, activeSubscriptions: activeSubs, paymentsKobo30d: sumKobo(pay30.data), escrowHeldKobo: sumKobo(escrowHeld.data) },
    recentActions: recent.error ? [] : recent.data,
  });
});

// ───────── Users ─────────
r.get('/users', async (req, res) => {
  const { from, to } = paginate(req.query);
  const f = z.object({ q: z.string().optional(), role: z.string().optional(), status: z.enum(['suspended', 'unverified', 'verified']).optional() }).parse(req.query);
  let q = db.from('profiles').select('id, first_name, last_name, email, phone, role, avatar_url, phone_verified, nin_verified, is_suspended, rating_avg, rating_count, created_at', { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to);
  if (f.role) q = q.eq('role', f.role);
  if (f.status === 'suspended') q = q.eq('is_suspended', true);
  if (f.status === 'unverified') q = q.eq('nin_verified', false);
  if (f.status === 'verified') q = q.eq('nin_verified', true);
  if (f.q?.trim()) { const t = like(f.q); q = q.or(`first_name.ilike.${t},last_name.ilike.${t},email.ilike.${t},phone.ilike.${t}`); }
  const { data, count: total, error } = await q;
  if (error) throw dbError(error);
  res.json({ users: data, total: total ?? 0 });
});

r.get('/users/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { data: profile } = await db.from('profiles').select('*').eq('id', id).maybeSingle();
  if (!profile) throw notFound('User not found');
  const [properties, bookings, payments, reportsAgainst, reportsFiled, verifs, artisan] = await Promise.all([
    db.from('properties').select('id, title, area, status, price_kobo, created_at').eq('owner_id', id).order('created_at', { ascending: false }).limit(20),
    db.from('bookings').select('id, status, scheduled_at, amount_kobo, properties(title)').or(`tenant_id.eq.${id},host_id.eq.${id}`).order('created_at', { ascending: false }).limit(20),
    db.from('payments').select('id, purpose, reference, amount_kobo, status, channel, paid_at, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(20),
    db.from('reports').select('id, reason, status, created_at').eq('agent_id', id).order('created_at', { ascending: false }).limit(20),
    count('reports', (q) => q.eq('reporter_id', id)),
    db.from('verifications').select('id, status, nin_last3, confidence, failure_reason, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(5),
    db.from('artisan_profiles').select('skill_category, additional_skills, service_areas, review_status, review_note, years_experience').eq('user_id', id).maybeSingle(),
  ]);
  const { expo_push_token: _t, privacy_prefs: _p, notification_prefs: _n, ...safe } = profile as any; // internal fields stay internal
  res.json({
    user: safe, artisan: artisan.data ?? null, verifications: verifs.data ?? [],
    properties: properties.data ?? [], bookings: bookings.data ?? [], payments: payments.data ?? [],
    reportsAgainst: reportsAgainst.data ?? [], reportsFiled,
  });
});

// Manual NIN verification fallback & moderation
r.post('/users/:id/verify', async (req, res) => {
  await db.from('profiles').update({ nin_verified: true }).eq('id', req.params.id);
  await db.from('verifications').update({ status: 'success' }).eq('user_id', req.params.id).eq('status', 'manual_review');
  await notify(req.params.id, 'verified', 'Identity verified ✅', 'Your account is now fully verified.');
  await audit(req, 'user.verify', 'user', req.params.id);
  res.status(204).end();
});
r.post('/users/:id/suspend', async (req, res) => {
  const { suspended, reason } = z.object({ suspended: z.boolean(), reason: z.string().max(300).optional() }).parse(req.body);
  if (req.params.id === req.user.id) throw badRequest('You cannot suspend your own account');
  await db.from('profiles').update({ is_suspended: suspended }).eq('id', req.params.id);
  await audit(req, suspended ? 'user.suspend' : 'user.unsuspend', 'user', req.params.id, reason ? { reason } : {});
  res.status(204).end();
});

// ───────── Identity verifications needing a human ─────────
r.get('/verifications', async (req, res) => {
  const { status } = z.object({ status: z.enum(['manual_review', 'failed', 'success']).default('manual_review') }).parse(req.query);
  const { data, error } = await db.from('verifications').select(`id, status, nin_last3, confidence, failure_reason, created_at, user:profiles!verifications_user_id_fkey(${PERSON}, nin_verified)`)
    .eq('status', status).order('created_at', { ascending: false }).limit(100);
  if (error) throw dbError(error);
  res.json({ verifications: data });
});
r.post('/verifications/:id/reject', async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(3).max(300) }).parse(req.body);
  const v = unwrapMaybe(await db.from('verifications').update({ status: 'failed', failure_reason: reason }).eq('id', req.params.id).eq('status', 'manual_review').select('id, user_id').maybeSingle());
  if (!v) throw notFound('Verification not awaiting review');
  await notify(v.user_id, 'verification_failed', 'Identity check unsuccessful', reason);
  await audit(req, 'verification.reject', 'verification', v.id, { reason, userId: v.user_id });
  res.status(204).end();
});

// ───────── Listings ─────────
r.get('/properties/pending', async (_req, res) =>
  res.json({ properties: (await db.from('properties').select('*, property_media(url), owner:profiles!properties_owner_id_fkey(first_name, last_name, role)').eq('status', 'pending').order('created_at')).data }));

r.get('/properties', async (req, res) => {
  const { from, to } = paginate(req.query);
  const f = z.object({ q: z.string().optional(), status: z.string().optional() }).parse(req.query);
  let q = db.from('properties').select(`id, title, address, area, city, status, price_kobo, price_period, property_type, bedrooms, is_verified, rejection_reason, created_at,
    property_media(url, position), owner:profiles!properties_owner_id_fkey(id, first_name, last_name, role)`, { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to);
  if (f.status) q = q.eq('status', f.status);
  if (f.q?.trim()) { const t = like(f.q); q = q.or(`title.ilike.${t},address.ilike.${t},area.ilike.${t}`); }
  const { data, count: total, error } = await q;
  if (error) throw dbError(error);
  res.json({ properties: data, total: total ?? 0 });
});

r.post('/properties/:id/decision', async (req, res) => {
  const b = decision.parse(req.body);
  const p = unwrapMaybe(await db.from('properties').update(b.approve
    ? { status: 'approved', is_verified: true, rejection_reason: null } : { status: 'rejected', rejection_reason: b.reason ?? 'Does not meet listing requirements' })
    .eq('id', req.params.id).eq('status', 'pending').select().maybeSingle());
  if (!p) throw notFound('Pending property not found');
  await notify(p.owner_id, b.approve ? 'listing_approved' : 'listing_rejected', b.approve ? 'Listing approved ✅' : 'Listing rejected', b.approve ? p.title : (b.reason ?? 'Edit and resubmit.'), { propertyId: p.id });
  await audit(req, b.approve ? 'property.approve' : 'property.reject', 'property', p.id, { title: p.title, reason: b.reason });
  res.json({ property: p });
});

/** Take a live listing down (e.g. after a scam report), or put it back. */
r.post('/properties/:id/takedown', async (req, res) => {
  const b = z.object({ down: z.boolean(), reason: z.string().max(300).optional() }).parse(req.body);
  const p = unwrapMaybe(await db.from('properties').update(b.down ? { status: 'rejected', rejection_reason: b.reason ?? 'Removed by RentCreeb' } : { status: 'approved', rejection_reason: null })
    .eq('id', req.params.id).in('status', b.down ? ['approved', 'paused', 'unlisted'] : ['rejected']).select().maybeSingle());
  if (!p) throw badRequest(b.down ? 'Only live listings can be taken down' : 'Only taken-down listings can be restored');
  await notify(p.owner_id, b.down ? 'listing_rejected' : 'listing_approved', b.down ? 'Listing removed' : 'Listing restored', b.down ? (b.reason ?? 'Your listing was removed by RentCreeb.') : p.title, { propertyId: p.id });
  await audit(req, b.down ? 'property.takedown' : 'property.restore', 'property', p.id, { title: p.title, reason: b.reason });
  res.json({ property: p });
});

// ───────── Artisan applications ─────────
// artisan_documents links to profiles (not artisan_profiles), so documents are embedded through the profile and
// lifted back up to keep the response shape { ...artisan, profiles, artisan_documents, artisan_references }.
r.get('/artisans/pending', async (_req, res) => {
  const { data } = await db.from('artisan_profiles').select('*, profiles(first_name, last_name, phone, email, nin_verified, avatar_url, artisan_documents(id, doc_type, original_name), artisan_references(*))').eq('review_status', 'pending').order('submitted_at');
  res.json({ artisans: (data ?? []).map((a: any) => {
    const { artisan_documents, artisan_references, ...profile } = a.profiles ?? {};
    return { ...a, profiles: profile, artisan_documents: artisan_documents ?? [], artisan_references: artisan_references ?? [] };
  }) });
});

/** Short-lived signed URL to view a private document. */
r.get('/artisan-documents/:id/url', async (req, res) => {
  const { data } = await db.from('artisan_documents').select('storage_path, user_id').eq('id', req.params.id).maybeSingle();
  if (!data) throw notFound();
  await audit(req, 'document.view', 'artisan_document', req.params.id, { userId: data.user_id });
  res.json({ url: signPrivateUrl(data.storage_path, 300) });
});

r.post('/artisans/:userId/decision', async (req, res) => {
  const b = decision.parse(req.body);
  const a = unwrapMaybe(await db.from('artisan_profiles').update(b.approve
    ? { review_status: 'approved', approved_at: new Date().toISOString(), review_note: null } : { review_status: 'rejected', review_note: b.reason })
    .eq('user_id', req.params.userId).eq('review_status', 'pending').select().maybeSingle());
  if (!a) throw notFound('Pending application not found');
  await notify(a.user_id, b.approve ? 'artisan_approved' : 'artisan_rejected', b.approve ? 'You’re now a Verified Artisan! 🎉' : 'Application needs changes', b.approve ? 'Your profile is now visible and you can receive job alerts.' : (b.reason ?? ''));
  await audit(req, b.approve ? 'artisan.approve' : 'artisan.reject', 'user', a.user_id, { reason: b.reason });
  res.json({ artisan: a });
});

// ───────── Reports (scams / misconduct) ─────────
r.get('/reports', async (req, res) => {
  const { from, to } = paginate(req.query);
  const { status } = z.object({ status: z.string().optional() }).parse(req.query);
  let q = db.from('reports').select('*, reporter:profiles!reports_reporter_id_fkey(id, first_name, last_name), agent:profiles!reports_agent_id_fkey(id, first_name, last_name, is_suspended)')
    .order('created_at', { ascending: false }).range(from, to);
  if (status) q = q.eq('status', status);
  res.json({ reports: (await q).data ?? [] });
});
r.patch('/reports/:id', async (req, res) => {
  const b = z.object({ status: z.enum(['open', 'investigating', 'resolved', 'dismissed']), adminNote: z.string().optional() }).parse(req.body);
  const report = unwrap(await db.from('reports').update({ status: b.status, admin_note: b.adminNote }).eq('id', uuid.parse(req.params.id)).select().single());
  await audit(req, `report.${b.status}`, 'report', req.params.id, b.adminNote ? { note: b.adminNote } : {});
  res.json({ report });
});

// ───────── Reviews ─────────
r.get('/reviews', async (req, res) => {
  const { flagged } = z.object({ flagged: z.enum(['true', 'false']).default('true') }).parse(req.query);
  let q = db.from('reviews').select('id, rating, comment, flag_count, hidden, created_at, reviewer:profiles!reviews_reviewer_id_fkey(first_name, last_name), agent:profiles!reviews_agent_id_fkey(first_name, last_name), properties(title), review_flags(reason)')
    .order('flag_count', { ascending: false }).order('created_at', { ascending: false }).limit(100);
  if (flagged === 'true') q = q.gt('flag_count', 0);
  const { data, error } = await q;
  if (error) throw dbError(error);
  res.json({ reviews: data });
});
r.post('/reviews/:id/hide', async (req, res) => {
  const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
  await db.from('reviews').update({ hidden }).eq('id', req.params.id);
  await audit(req, hidden ? 'review.hide' : 'review.unhide', 'review', req.params.id);
  res.status(204).end();
});

// ───────── Support tickets ─────────
r.get('/tickets', async (req, res) => {
  const { status, kind } = z.object({ status: z.string().optional(), kind: z.string().optional() }).parse(req.query);
  let q = db.from('support_tickets').select(`*, user:profiles!support_tickets_user_id_fkey(${PERSON})`).order('created_at', { ascending: false }).limit(100);
  if (status) q = q.eq('status', status);
  if (kind) q = q.eq('kind', kind);
  const { data, error } = await q;
  if (error) throw dbError(error);
  res.json({ tickets: data });
});
r.patch('/tickets/:id', async (req, res) => {
  const b = z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']), adminNote: z.string().max(2000).optional(), notifyUser: z.boolean().default(true) }).parse(req.body);
  const t = unwrap(await db.from('support_tickets').update({ status: b.status, admin_note: b.adminNote, updated_at: new Date().toISOString() }).eq('id', uuid.parse(req.params.id)).select().single());
  if (b.notifyUser && (b.status === 'resolved' || b.adminNote)) {
    await notify(t.user_id, 'support_update', b.status === 'resolved' ? 'Your request was resolved' : 'Update on your request', b.adminNote?.slice(0, 160) ?? t.subject);
  }
  await audit(req, `ticket.${b.status}`, 'ticket', t.id, b.adminNote ? { note: b.adminNote } : {});
  res.json({ ticket: t });
});

// ───────── Payments (read-only) ─────────
r.get('/payments', async (req, res) => {
  const { from, to } = paginate(req.query);
  const f = z.object({ status: z.string().optional(), purpose: z.string().optional(), q: z.string().optional() }).parse(req.query);
  let q = db.from('payments').select(`id, purpose, reference, amount_kobo, status, channel, paid_at, created_at, user:profiles!payments_user_id_fkey(${PERSON})`, { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to);
  if (f.status) q = q.eq('status', f.status);
  if (f.purpose) q = q.eq('purpose', f.purpose);
  if (f.q?.trim()) q = q.ilike('reference', like(f.q));
  const { data, count: total, error } = await q;
  if (error) throw dbError(error);
  res.json({ payments: data, total: total ?? 0 });
});

// ───────── Audit log ─────────
r.get('/actions', async (req, res) => {
  const { from, to } = paginate(req.query);
  const { data, error } = await db.from('admin_actions').select('*, admin:profiles!admin_actions_admin_id_fkey(first_name, last_name)').order('created_at', { ascending: false }).range(from, to);
  if (error) throw dbError(error);
  res.json({ actions: data });
});

export default r;
