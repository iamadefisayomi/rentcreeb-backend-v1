import type { Request, Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap, unwrapMaybe } from '../../lib/supabase';
import { badRequest, notFound } from '../../lib/errors';
import { signPrivateUrl } from '../../lib/bunny';
import { paginate, uuid } from '../../lib/common';
import { notify } from '../../services/notify';
import { PERSON, audit, count, decision, like, notesFor } from './shared';
import { ensureTicketConversation, postStaffReply, setTicketStatus, type Ticket } from '../../services/supportChat';
import { liveListingReviews, queueListingReview, reviewListing } from '../../services/listingReview';

/** Run a query with the private AI review embedded; without it if migration 015 isn't applied yet. */
async function withAiFallback<T extends { error: any }>(q: (ai: string) => PromiseLike<T>): Promise<T> {
  const r = await q('listing_ai_reviews(*), ');
  return r.error && /listing_ai_reviews|relationship/i.test(r.error.message ?? '') ? q('') : r;
}

/** Flatten the private listing_ai_reviews row onto a listing for the dashboard: ai_review (result) + ai_status (live). */
function withAi(p: any) {
  const r = Array.isArray(p?.listing_ai_reviews) ? p.listing_ai_reviews[0] : p?.listing_ai_reviews;
  const { listing_ai_reviews: _x, ...rest } = p ?? {};
  return { ...rest, ai_review: r?.review ?? null, ai_status: r ? { status: r.status, stage: r.stage, since: r.started_at ?? r.queued_at, attempts: r.attempts } : null };
}

const LIVE = ['approved', 'paused', 'unlisted'];
const PROPERTY_STATUSES = ['unlisted', 'pending', 'approved', 'rejected', 'rented', 'archived'] as const;

async function decideProperty(req: Request, id: string, approve: boolean, reason?: string) {
  const p = unwrapMaybe(await db.from('properties').update(approve
    ? { status: 'approved', is_verified: true, rejection_reason: null, updated_at: new Date().toISOString() }
    : { status: 'rejected', rejection_reason: reason ?? 'Does not meet listing requirements', updated_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'pending').select().maybeSingle());
  if (!p) return null;
  await notify(p.owner_id, approve ? 'listing_approved' : 'listing_rejected', approve ? 'Listing approved ✅' : 'Listing rejected', approve ? p.title : (reason ?? 'Edit and resubmit.'), { propertyId: p.id });
  await audit(req, approve ? 'property.approve' : 'property.reject', 'property', p.id, { title: p.title, reason });
  return p;
}

export function mountContent(r: Router) {
  // ───────── Listings ─────────
  r.get('/properties/pending', async (_req, res) =>
    res.json({ properties: ((await withAiFallback((ai) => db.from('properties').select(`*, ${ai}property_media(url, position, media_type), owner:profiles!properties_owner_id_fkey(id, first_name, last_name, role, nin_verified)`).eq('status', 'pending').order('created_at'))).data ?? []).map(withAi) }));

  /** Live view of the automatic reviewer for the dashboard (polled every few seconds while open). */
  r.get('/ai-reviews/live', async (_req, res) => res.json(await liveListingReviews()));

  r.get('/properties', async (req, res) => {
    const { from, to } = paginate(req.query);
    const f = z.object({ q: z.string().optional(), status: z.string().optional(), type: z.string().optional(), ownerId: z.string().uuid().optional(), verified: z.enum(['true', 'false']).optional() }).parse(req.query);
    let q = db.from('properties').select(`id, title, address, area, city, status, price_kobo, price_period, property_type, bedrooms, is_verified, rejection_reason, created_at, description,
      property_media(url, position), owner:profiles!properties_owner_id_fkey(id, first_name, last_name, role)`, { count: 'exact' })
      .order('created_at', { ascending: false }).range(from, to);
    if (f.status) q = q.eq('status', f.status);
    if (f.type) q = q.eq('property_type', f.type);
    if (f.ownerId) q = q.eq('owner_id', f.ownerId);
    if (f.verified) q = q.eq('is_verified', f.verified === 'true');
    if (f.q?.trim()) { const t = like(f.q); q = q.or(`title.ilike.${t},address.ilike.${t},area.ilike.${t},city.ilike.${t}`); }
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    res.json({ properties: data, total: total ?? 0 });
  });

  r.get('/properties/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: raw } = await withAiFallback((ai) => db.from('properties').select(`*, ${ai}property_media(id, url, position, media_type), owner:profiles!properties_owner_id_fkey(id, first_name, last_name, email, phone, role, nin_verified, is_suspended)`).eq('id', id).maybeSingle());
    if (!raw) throw notFound('Listing not found');
    const p = withAi(raw);
    const [units, bookings, reviews, tenancies, saved, nearby, notes] = await Promise.all([
      db.from('units').select('*').eq('property_id', id).order('created_at'),
      db.from('bookings').select(`id, status, scheduled_at, amount_kobo, created_at, tenant:profiles!bookings_tenant_id_fkey(id, first_name, last_name)`).eq('property_id', id).order('created_at', { ascending: false }).limit(30),
      db.from('reviews').select('id, rating, comment, hidden, flag_count, created_at, reviewer:profiles!reviews_reviewer_id_fkey(first_name, last_name)').eq('property_id', id).order('created_at', { ascending: false }).limit(30),
      db.from('tenancies').select('id, status, rent_kobo, frequency, lease_start, lease_end, tenant:profiles!tenancies_tenant_id_fkey(id, first_name, last_name)').eq('property_id', id).limit(30),
      count('saved_properties', (q) => q.eq('property_id', id)),
      db.from('nearby_places').select('category, name, distance_km').eq('property_id', id).limit(30),
      notesFor('property', id),
    ]);
    res.json({ property: { ...p, property_media: ((p as any).property_media ?? []).sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0)) },
      units: units.data ?? [], bookings: bookings.data ?? [], reviews: reviews.data ?? [], tenancies: tenancies.data ?? [], savedCount: saved, nearby: nearby.data ?? [], notes });
  });

  r.post('/properties/:id/decision', async (req, res) => {
    const b = decision.parse(req.body);
    const p = await decideProperty(req, uuid.parse(req.params.id), b.approve, b.reason);
    if (!p) throw notFound('Pending property not found');
    res.json({ property: p });
  });

  /** Run the automatic review now. `apply` lets it auto-approve a pending listing that fully passes. */
  r.post('/properties/:id/ai-review', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { apply, background } = z.object({ apply: z.boolean().default(false), background: z.boolean().default(false) }).parse(req.body ?? {});
    if (background) { queueListingReview(id, 0); await audit(req, 'property.ai_review', 'property', id, { queued: true }); return res.status(202).json({ queued: true }); }
    const review = await reviewListing(id, { apply });
    if (!review) throw notFound('Listing not found');
    await audit(req, 'property.ai_review', 'property', id, { decision: review.decision, apply });
    res.json({ review });
  });

  /** Approve or reject several pending listings at once. */
  r.post('/properties/bulk-decision', async (req, res) => {
    const b = z.object({ ids: z.array(z.string().uuid()).min(1).max(50), approve: z.boolean(), reason: z.string().max(500).optional() }).parse(req.body);
    if (!b.approve && !b.reason) throw badRequest('Give a reason for rejecting');
    let done = 0;
    for (const id of b.ids) if (await decideProperty(req, id, b.approve, b.reason)) done++;
    res.json({ done, skipped: b.ids.length - done });
  });

  /** Take a live listing down (e.g. after a scam report), or put it back. */
  r.post('/properties/:id/takedown', async (req, res) => {
    const b = z.object({ down: z.boolean(), reason: z.string().max(300).optional() }).parse(req.body);
    const p = unwrapMaybe(await db.from('properties').update(b.down ? { status: 'rejected', rejection_reason: b.reason ?? 'Removed by RentCreeb' } : { status: 'approved', rejection_reason: null })
      .eq('id', uuid.parse(req.params.id)).in('status', b.down ? LIVE : ['rejected']).select().maybeSingle());
    if (!p) throw badRequest(b.down ? 'Only live listings can be taken down' : 'Only taken-down listings can be restored');
    await notify(p.owner_id, b.down ? 'listing_rejected' : 'listing_approved', b.down ? 'Listing removed' : 'Listing restored', b.down ? (b.reason ?? 'Your listing was removed by RentCreeb.') : p.title, { propertyId: p.id });
    await audit(req, b.down ? 'property.takedown' : 'property.restore', 'property', p.id, { title: p.title, reason: b.reason });
    res.json({ property: p });
  });

  /** Set any status, or toggle the "verified listing" badge. */
  r.patch('/properties/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ status: z.enum(PROPERTY_STATUSES).optional(), isVerified: z.boolean().optional(), reason: z.string().max(300).optional(), notifyOwner: z.boolean().default(true) }).parse(req.body);
    const { data: before } = await db.from('properties').select('status, is_verified, owner_id, title').eq('id', id).maybeSingle();
    if (!before) throw notFound('Listing not found');
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (b.status) { patch.status = b.status; patch.rejection_reason = b.status === 'rejected' ? b.reason ?? 'Removed by RentCreeb' : null; }
    if (b.isVerified !== undefined) patch.is_verified = b.isVerified;
    unwrap(await db.from('properties').update(patch).eq('id', id).select('id').single());
    if (b.notifyOwner && b.status && b.status !== before.status)
      await notify(before.owner_id, b.status === 'approved' ? 'listing_approved' : 'listing_rejected', `Listing ${b.status}`, b.reason ?? before.title, { propertyId: id });
    await audit(req, 'property.edit', 'property', id, { title: before.title, from: { status: before.status, verified: before.is_verified }, to: { status: b.status, verified: b.isVerified }, reason: b.reason });
    res.status(204).end();
  });

  // ───────── Reviews ─────────
  r.get('/reviews', async (req, res) => {
    const { from, to } = paginate(req.query);
    const f = z.object({ flagged: z.enum(['true', 'false', 'hidden']).default('true') }).parse(req.query);
    let q = db.from('reviews').select('id, rating, comment, reply, flag_count, hidden, created_at, reviewer:profiles!reviews_reviewer_id_fkey(id, first_name, last_name), agent:profiles!reviews_agent_id_fkey(id, first_name, last_name), properties(id, title), review_flags(reason)', { count: 'exact' })
      .order('flag_count', { ascending: false }).order('created_at', { ascending: false }).range(from, to);
    if (f.flagged === 'true') q = q.gt('flag_count', 0).eq('hidden', false);
    if (f.flagged === 'hidden') q = q.eq('hidden', true);
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    res.json({ reviews: data, total: total ?? 0 });
  });
  r.post('/reviews/:id/hide', async (req, res) => {
    const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
    await db.from('reviews').update({ hidden }).eq('id', uuid.parse(req.params.id));
    await audit(req, hidden ? 'review.hide' : 'review.unhide', 'review', req.params.id);
    res.status(204).end();
  });
  /** Flags were looked at and the review is fine: clear them so it leaves the queue. */
  r.post('/reviews/:id/clear-flags', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.from('review_flags').delete().eq('review_id', id);
    await db.from('reviews').update({ flag_count: 0 }).eq('id', id);
    await audit(req, 'review.clear_flags', 'review', id);
    res.status(204).end();
  });

  // ───────── Reports (scams / misconduct) ─────────
  r.get('/reports', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    let q = db.from('reports').select('*, reporter:profiles!reports_reporter_id_fkey(id, first_name, last_name), agent:profiles!reports_agent_id_fkey(id, first_name, last_name, is_suspended, role)', { count: 'exact' })
      .order('created_at', { ascending: false }).range(from, to);
    if (status) q = q.eq('status', status);
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    // How many times each reported person has been reported in total: repeat offenders stand out.
    const ids = [...new Set((data ?? []).map((x: any) => x.agent_id))];
    const priors: Record<string, number> = {};
    await Promise.all(ids.map(async (id) => { priors[id] = await count('reports', (x) => x.eq('agent_id', id)); }));
    const conv: Record<string, string> = {};
    const bookingIds = (data ?? []).map((x: any) => x.booking_id).filter(Boolean);
    if (bookingIds.length) {
      const { data: cs } = await db.from('conversations').select('id, context_id').eq('context_type', 'booking').in('context_id', bookingIds);
      for (const c of cs ?? []) conv[c.context_id] = c.id;
    }
    res.json({ reports: (data ?? []).map((x: any) => ({ ...x, reportsAgainstTotal: priors[x.agent_id] ?? 0, conversationId: x.booking_id ? conv[x.booking_id] ?? null : null })), total: total ?? 0 });
  });
  r.patch('/reports/:id', async (req, res) => {
    const b = z.object({ status: z.enum(['open', 'investigating', 'resolved', 'dismissed']), adminNote: z.string().max(2000).optional(), notifyReporter: z.boolean().default(false) }).parse(req.body);
    const report = unwrap(await db.from('reports').update({ status: b.status, admin_note: b.adminNote }).eq('id', uuid.parse(req.params.id)).select().single());
    if (b.notifyReporter && ['resolved', 'dismissed'].includes(b.status))
      await notify(report.reporter_id, 'report_update', 'Update on your report', b.status === 'resolved' ? 'Thanks for your report. We have taken action.' : 'Thanks for your report. We reviewed it and found no breach of our rules.');
    await audit(req, `report.${b.status}`, 'report', req.params.id, b.adminNote ? { note: b.adminNote } : {});
    res.json({ report });
  });

  // ───────── Conversations (for disputes; every view is audited) ─────────
  r.get('/conversations', async (req, res) => {
    const f = z.object({ userId: z.string().uuid().optional(), contextType: z.enum(['booking', 'job']).optional(), contextId: z.string().uuid().optional() }).parse(req.query);
    if (!f.userId && !f.contextId) throw badRequest('Pass userId or contextId');
    let q = db.from('conversations').select('id, context_type, context_id, created_at, a:profiles!conversations_participant_a_fkey(id, first_name, last_name), b:profiles!conversations_participant_b_fkey(id, first_name, last_name)')
      .order('created_at', { ascending: false }).limit(50);
    if (f.userId) q = q.or(`participant_a.eq.${f.userId},participant_b.eq.${f.userId}`);
    if (f.contextId) q = q.eq('context_id', f.contextId);
    if (f.contextType) q = q.eq('context_type', f.contextType);
    const { data, error } = await q;
    if (error) throw dbError(error);
    res.json({ conversations: data });
  });
  r.get('/conversations/:id/messages', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { reason } = z.object({ reason: z.string().min(3).max(200) }).parse(req.query);
    const { data: c } = await db.from('conversations').select('id, context_type, context_id, participant_a, participant_b, a:profiles!conversations_participant_a_fkey(id, first_name, last_name), b:profiles!conversations_participant_b_fkey(id, first_name, last_name)').eq('id', id).maybeSingle();
    if (!c) throw notFound('Conversation not found');
    const { data, error } = await db.from('messages').select('id, sender_id, body, attachment_url, attachment_path, attachment_name, attachment_type, created_at, read_at').eq('conversation_id', id).order('created_at').limit(1000);
    if (error) throw dbError(error);
    await audit(req, 'conversation.view', 'conversation', id, { reason });
    res.json({ conversation: c, messages: (data ?? []).map((m: any) => {
      let attachment: string | null = m.attachment_url ?? null;
      if (!attachment && m.attachment_path) { try { attachment = signPrivateUrl(m.attachment_path, 600); } catch { attachment = null; } }
      return { id: m.id, sender_id: m.sender_id, body: m.body, attachment, attachment_name: m.attachment_name, attachment_type: m.attachment_type, created_at: m.created_at, read_at: m.read_at };
    }) });
  });

  // ───────── Support tickets ─────────
  r.get('/tickets', async (req, res) => {
    const { from, to } = paginate(req.query);
    const f = z.object({ status: z.string().optional(), kind: z.string().optional(), q: z.string().optional(), awaiting: z.enum(['staff', 'user']).optional() }).parse(req.query);
    // Newest activity first, so a user's reply brings their ticket back to the top.
    let q = db.from('support_tickets').select(`*, user:profiles!support_tickets_user_id_fkey(${PERSON})`, { count: 'exact' })
      .order('last_message_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).range(from, to);
    if (f.status) q = q.eq('status', f.status);
    if (f.awaiting) q = q.eq('awaiting', f.awaiting);
    if (f.kind) q = q.eq('kind', f.kind);
    if (f.q?.trim()) { const t = like(f.q); q = q.or(`subject.ilike.${t},message.ilike.${t}`); }
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    res.json({ tickets: data, total: total ?? 0 });
  });
  /** One ticket with its chat thread (support threads are part of the job, so opening one is not audited like private chats). */
  r.get('/tickets/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const t = unwrapMaybe(await db.from('support_tickets').select(`*, user:profiles!support_tickets_user_id_fkey(${PERSON}, created_at, is_suspended)`).eq('id', id).maybeSingle());
    if (!t) throw notFound('Ticket not found');
    const conversationId = await ensureTicketConversation(t as Ticket);
    const [{ data: msgs, error }, { data: conv }, others, notes] = await Promise.all([
      db.from('messages').select('id, sender_id, body, system, attachment_url, attachment_path, attachment_name, attachment_type, created_at, read_at').eq('conversation_id', conversationId).order('created_at').limit(2000),
      db.from('conversations').select('closed_at').eq('id', conversationId).maybeSingle(),
      db.from('support_tickets').select('id, subject, status, created_at').eq('user_id', (t as any).user_id).neq('id', id).order('created_at', { ascending: false }).limit(10),
      notesFor('ticket', id),
    ]);
    if (error) throw dbError(error);
    const staffIds = [...new Set((msgs ?? []).map((m: any) => m.sender_id).filter((s: string) => s !== (t as any).user_id))];
    const { data: staff } = staffIds.length ? await db.from('profiles').select('id, first_name, last_name').in('id', staffIds) : { data: [] as any[] };
    // Opening the thread counts as reading what the user sent.
    await db.from('messages').update({ read_at: new Date().toISOString() }).eq('conversation_id', conversationId).eq('sender_id', (t as any).user_id).is('read_at', null);
    res.json({
      ticket: { ...t, conversation_id: conversationId }, closed: !!conv?.closed_at, otherTickets: others.data ?? [], notes, staff: staff ?? [],
      messages: (msgs ?? []).map((m: any) => {
        let attachment: string | null = m.attachment_url ?? null;
        if (!attachment && m.attachment_path) { try { attachment = signPrivateUrl(m.attachment_path, 3600); } catch { attachment = null; } }
        return { id: m.id, sender_id: m.sender_id, staff: m.sender_id !== (t as any).user_id, system: !!m.system, body: m.body, attachment, attachment_name: m.attachment_name, attachment_type: m.attachment_type, created_at: m.created_at, read_at: m.read_at };
      }),
    });
  });
  /** Answer in the thread. Optional status change in the same step (e.g. reply and resolve, reply and close). */
  r.post('/tickets/:id/messages', async (req, res) => {
    const b = z.object({ body: z.string().trim().min(1).max(4000), status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional() }).parse(req.body);
    const t = unwrapMaybe(await db.from('support_tickets').select('*').eq('id', uuid.parse(req.params.id)).maybeSingle()) as Ticket | null;
    if (!t) throw notFound('Ticket not found');
    const message = await postStaffReply(t, req.user.id, b.body);
    if (b.status && b.status !== 'in_progress') await setTicketStatus({ ...t, status: t.status === 'open' ? 'in_progress' : t.status }, req.user.id, b.status);
    await audit(req, 'ticket.reply', 'ticket', t.id, { length: b.body.length, ...(b.status ? { status: b.status } : {}) });
    res.status(201).json({ message });
  });
  r.patch('/tickets/:id', async (req, res) => {
    const b = z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(), assignedTo: z.string().uuid().nullable().optional(),
      adminNote: z.string().trim().max(2000).optional(), notifyUser: z.boolean().default(true) }).parse(req.body);
    const id = uuid.parse(req.params.id);
    const t = unwrapMaybe(await db.from('support_tickets').select('*').eq('id', id).maybeSingle()) as Ticket | null;
    if (!t) throw notFound('Ticket not found');
    // Old dashboard flow: a note "sent to the user" is now a reply in their thread.
    if (b.adminNote && b.notifyUser) await postStaffReply(t, req.user.id, b.adminNote);
    if (b.status) await setTicketStatus(b.adminNote && b.notifyUser && t.status === 'open' ? { ...t, status: 'in_progress' } : t, req.user.id, b.status);
    if (b.assignedTo !== undefined) await db.from('support_tickets').update({ assigned_to: b.assignedTo }).eq('id', id);
    if (b.adminNote && !b.notifyUser) await db.from('support_tickets').update({ admin_note: b.adminNote }).eq('id', id);
    await audit(req, `ticket.${b.status ?? 'update'}`, 'ticket', id, b.adminNote ? { note: b.adminNote } : {});
    res.json({ ticket: unwrap(await db.from('support_tickets').select('*').eq('id', id).single()) });
  });

  // ───────── App feedback ("Rate RentCreeb") ─────────
  r.get('/feedback', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { rating } = z.object({ rating: z.coerce.number().int().min(1).max(5).optional() }).parse(req.query);
    let q = db.from('app_feedback').select(`*, user:profiles!app_feedback_user_id_fkey(${PERSON})`, { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
    if (rating) q = q.eq('rating', rating);
    const [{ data, count: total, error }, all] = await Promise.all([q, db.from('app_feedback').select('rating').limit(10000)]);
    if (error) throw dbError(error);
    const dist = [1, 2, 3, 4, 5].map((n) => (all.data ?? []).filter((x: any) => x.rating === n).length);
    const n = (all.data ?? []).length;
    res.json({ feedback: data, total: total ?? 0, summary: { count: n, average: n ? (all.data ?? []).reduce((t: number, x: any) => t + x.rating, 0) / n : 0, distribution: dist } });
  });
}
