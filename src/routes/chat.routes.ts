import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { forbidden, notFound, badRequest } from '../lib/errors';
import { fullName } from '../lib/common';
import { authenticate } from '../middleware/auth';
import { notify } from '../services/notify';
import { signPrivateUrl } from '../lib/bunny';
import { logger } from '../lib/logger';
import { isTyping, presenceOf, setTyping } from '../services/presence';
import { PRIVACY_DEFAULTS } from './support.routes';
import { ensureConversation } from '../services/conversations';
import { SUPPORT_PERSON, onUserSupportMessage } from '../services/supportChat';
import { removePhoneNumbers } from '../lib/webAuth';
import { screenMessage } from '../services/scamGuard';

const r = Router();
r.use(authenticate);

async function getConv(id: string, userId: string) {
  const { data } = await db.from('conversations').select('*').eq('id', id).maybeSingle();
  if (!data) throw notFound('Conversation not found');
  if (![data.participant_a, data.participant_b].includes(userId)) throw forbidden();
  return data;
}

/** Booking / job context cards for the inbox and chat header (Figma Agent Messaging 4563:9123), two batched lookups. */
async function attachContext(out: { contextType: string; contextId: string }[]) {
  const bIds = out.filter((c) => c.contextType === 'booking').map((c) => c.contextId);
  const jIds = out.filter((c) => c.contextType === 'job').map((c) => c.contextId);
  const sIds = out.filter((c) => c.contextType === 'support').map((c) => c.contextId);
  const pIds = out.filter((c) => c.contextType === 'property').map((c) => c.contextId);
  const dIds = out.filter((c) => c.contextType === 'project').map((c) => c.contextId);
  if (dIds.length) {
    const { data: projs } = await db.from('dev_projects').select('id, name, area, city, status, images').in('id', dIds);
    for (const x of (projs ?? []) as any[]) for (const c of out as any[]) if (c.contextType === 'project' && c.contextId === x.id)
      c.context = { id: x.id, kind: 'project', status: x.status, title: x.name, area: [x.area, x.city].filter(Boolean).join(', '), propertyId: null, projectId: x.id, date: null, cover: x.images?.[0] ?? null };
  }
  if (pIds.length) {
    const { data: props } = await db.from('properties').select('id, title, area, slug, property_media(url, position)').in('id', pIds);
    for (const x of (props ?? []) as any[]) {
      const cover = [...(x.property_media ?? [])].sort((m: any, n: any) => m.position - n.position)[0]?.url ?? null;
      for (const c of out as any[]) if (c.contextType === 'property' && c.contextId === x.id) c.context = { id: x.id, kind: 'property', status: 'enquiry', title: x.title, area: x.area, propertyId: x.id, slug: x.slug ?? null, date: null, cover };
    }
  }
  const [bks, jbs, tks] = await Promise.all([
    bIds.length ? db.from('bookings').select('id, status, scheduled_at, properties(id, title, area, property_media(url, position))').in('id', bIds) : Promise.resolve({ data: [] as any[] }),
    jIds.length ? db.from('jobs').select('id, status, title, properties(id, title, area)').in('id', jIds) : Promise.resolve({ data: [] as any[] }),
    sIds.length ? db.from('support_tickets').select('id, status, subject, category, created_at').in('id', sIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  const ctx = new Map<string, any>();
  for (const x of (bks.data ?? []) as any[]) {
    const cover = [...(x.properties?.property_media ?? [])].sort((m: any, n: any) => m.position - n.position)[0]?.url ?? null;
    ctx.set(x.id, { id: x.id, kind: 'booking', status: x.status, title: x.properties?.title ?? 'Inspection', area: x.properties?.area ?? null, propertyId: x.properties?.id ?? null, date: x.scheduled_at, cover });
  }
  for (const x of (jbs.data ?? []) as any[]) ctx.set(x.id, { id: x.id, kind: 'job', status: x.status, title: x.title, area: x.properties?.area ?? null, propertyId: x.properties?.id ?? null, date: null, cover: null, property: x.properties?.title ?? null });
  for (const c of out as any[]) if (c.contextType === 'roommate') ctx.set(c.contextId, { id: c.contextId, kind: 'roommate', status: 'accepted', title: 'Roommate match', area: null, propertyId: null, date: null, cover: null });
  for (const x of (tks.data ?? []) as any[]) ctx.set(x.id, { id: x.id, kind: 'support', status: x.status, title: x.subject, area: x.category, propertyId: null, date: x.created_at, cover: null });
  for (const c of out as any[]) if (c.contextType !== 'property' && c.contextType !== 'project') c.context = ctx.get(c.contextId) ?? null;
}

/** Conversations exist only after a booking is confirmed or a job is assigned. */
r.get('/', async (req, res) => {
  const { data: convs } = await db.from('conversations').select(
    '*, a:profiles!conversations_participant_a_fkey(id, first_name, last_name, avatar_url), b:profiles!conversations_participant_b_fkey(id, first_name, last_name, avatar_url)')
    .or(`participant_a.eq.${req.user.id},participant_b.eq.${req.user.id}`);
  const out = await Promise.all((convs ?? []).map(async (c: any) => {
    const { data: last } = await db.from('messages').select('*').eq('conversation_id', c.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const { count } = await db.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', c.id).neq('sender_id', req.user.id).is('read_at', null);
    const other = c.context_type === 'support' ? SUPPORT_PERSON : c.participant_a === req.user.id ? c.b : c.a;
    return { id: c.id, contextType: c.context_type, contextId: c.context_id, other, closed: !!c.closed_at, lastMessage: last, unreadCount: count ?? 0 };
  }));
  await attachContext(out);
  out.sort((x, y) => (y.lastMessage?.created_at ?? '').localeCompare(x.lastMessage?.created_at ?? ''));
  res.json({ conversations: out });
});

/**
 * Open the chat for a booking or job straight from its screen ("Message artisan", "Message landlord" …), creating it
 * if needed. `with` picks the other person on a job: the artisan talks to the landlord or the tenant; landlord and
 * tenant talk to the artisan. Same shape as GET /:id.
 */
r.post('/open', async (req, res) => {
  const b = z.object({ contextType: z.enum(['booking', 'job', 'property']), contextId: z.string().uuid(), with: z.enum(['landlord', 'tenant', 'artisan', 'host']).optional() }).parse(req.body);
  const me = req.user.id;
  let other: string | null = null;
  if (b.contextType === 'property') {
    // Enquiry about a live listing, with its owner. Phone numbers are removed from these messages.
    const { data: p } = await db.from('properties').select('owner_id, status').eq('id', b.contextId).maybeSingle();
    if (!p || !['approved', 'rented'].includes(p.status)) throw notFound('Property not available');
    if (p.owner_id === me) throw badRequest('You cannot message yourself about your own property', 'CHAT_LOCKED');
    other = p.owner_id;
  } else if (b.contextType === 'booking') {
    const { data: bk } = await db.from('bookings').select('tenant_id, host_id, status').eq('id', b.contextId).maybeSingle();
    if (!bk) throw notFound('Booking not found');
    if (![bk.tenant_id, bk.host_id].includes(me)) throw forbidden();
    if (!['confirmed', 'completed'].includes(bk.status)) throw badRequest('Chat opens once the inspection is confirmed', 'CHAT_LOCKED');
    other = me === bk.tenant_id ? bk.host_id : bk.tenant_id;
  } else {
    const { data: j } = await db.from('jobs').select('landlord_id, tenant_id, artisan_id').eq('id', b.contextId).maybeSingle();
    if (!j) throw notFound('Job not found');
    if (![j.landlord_id, j.tenant_id, j.artisan_id].includes(me)) throw forbidden();
    if (!j.artisan_id) throw badRequest('Chat opens once an artisan is assigned', 'CHAT_LOCKED');
    if (me === j.artisan_id) other = b.with === 'tenant' && j.tenant_id ? j.tenant_id : j.landlord_id;
    else other = j.artisan_id;
  }
  if (!other || other === me) throw badRequest('There is no one to message here', 'CHAT_LOCKED');
  const conv0 = await ensureConversation(b.contextType, b.contextId, me, other);
  if (!conv0) throw badRequest('Could not open this chat. Please try again from Messages.', 'CHAT_UNAVAILABLE');
  const { data: prof } = await db.from('profiles').select('id, first_name, last_name, avatar_url, nin_verified, role').eq('id', other).maybeSingle();
  const conv: any = { id: conv0.id, contextType: b.contextType, contextId: b.contextId, other: prof };
  await attachContext([conv]);
  res.json({ conversation: conv });
});

/** One conversation with the other participant and its context (chat header; push deep links only carry the id). */
r.get('/:id', async (req, res) => {
  const c: any = await getConv(String(req.params.id), req.user.id);
  const otherId = c.participant_a === req.user.id ? c.participant_b : c.participant_a;
  const other = c.context_type === 'support' ? SUPPORT_PERSON
    : (await db.from('profiles').select('id, first_name, last_name, avatar_url, nin_verified, role').eq('id', otherId).maybeSingle()).data;
  const conv: any = { id: c.id, contextType: c.context_type, contextId: c.context_id, other, closed: !!c.closed_at };
  await attachContext([conv]);
  res.json({ conversation: conv });
});

/** The quoted message shown above a reply. */
const REPLY_EMBED = 'reply_to:messages!messages_reply_to_id_fkey(id, body, attachment_url, attachment_name, attachment_type, sender_id)';
const SIGNED_TTL = 60 * 60; // attachment links last an hour; the app re-fetches messages when it needs fresh ones

/** Private chat files are stored by path; swap in a short-lived signed URL for the app. */
export function withSignedAttachment<T extends { attachment_path?: string | null; attachment_url?: string | null }>(m: T): T {
  if (!m?.attachment_path) return m;
  try { return { ...m, attachment_url: signPrivateUrl(m.attachment_path, SIGNED_TTL) }; }
  catch (err) { logger.error({ err }, 'could not sign chat attachment'); return m; }
}
const attachmentLabel = (m: { attachment_type?: string | null; attachment_name?: string | null }) =>
  m.attachment_type?.startsWith('image/') ? '📷 Photo' : `📎 ${m.attachment_name ?? 'File'}`;

r.get('/:id/messages', async (req, res) => {
  await getConv(req.params.id, req.user.id);
  const { before, limit } = z.object({ before: z.string().optional(), limit: z.coerce.number().max(100).default(40) }).parse(req.query);
  const page = (cols: string) => {
    let q = db.from('messages').select(cols).eq('conversation_id', req.params.id).order('created_at', { ascending: false }).limit(limit);
    if (before) q = q.lt('created_at', before);
    return q;
  };
  let r1 = await page(`*, ${REPLY_EMBED}`);
  // Before migration 010 the reply relation doesn't exist yet: fall back to plain messages instead of an empty chat.
  if (r1.error) r1 = await page('*');
  res.json({ messages: ((r1.data ?? []) as any[]).map((m) => withSignedAttachment({ ...m, reply_to: m.reply_to ? withSignedAttachment(m.reply_to) : m.reply_to })) });
});

r.post('/:id/messages', async (req, res) => {
  const c = await getConv(req.params.id, req.user.id);
  const b = z.object({
    body: z.string().max(4000).optional(), attachmentUrl: z.string().url().optional(), replyToId: z.string().uuid().optional(),
    // Private upload from POST /uploads?folder=chat-files — must be the sender's own file.
    attachment: z.object({
      path: z.string().startsWith(`chat-files/${req.user.id}/`).max(500), name: z.string().trim().min(1).max(200),
      type: z.string().max(120), size: z.number().int().min(0).max(50 * 1024 * 1024),
    }).optional(),
  }).parse(req.body);
  if (!b.body?.trim() && !b.attachmentUrl && !b.attachment) throw badRequest('Empty message');
  if (c.closed_at) throw forbidden('This conversation has been closed. Start a new request from Contact Support.', 'CHAT_CLOSED');
  let quoted: { id: string; body: string | null; attachment_url: string | null; sender_id: string } | null = null;
  if (b.replyToId) {
    const { data } = await db.from('messages').select('id, body, attachment_url, sender_id, conversation_id').eq('id', b.replyToId).maybeSingle();
    if (!data || data.conversation_id !== c.id) throw badRequest('You can only reply to a message in this chat', 'BAD_REPLY');
    quoted = { id: data.id, body: data.body, attachment_url: data.attachment_url, sender_id: data.sender_id };
  }
  if (c.context_type === 'property' && b.body) b.body = removePhoneNumbers(b.body);
  const row: Record<string, unknown> = { conversation_id: c.id, sender_id: req.user.id, body: b.body?.trim() || null, attachment_url: b.attachmentUrl };
  if (quoted) row.reply_to_id = quoted.id; // only touch the column when replying, so plain messages work before migration 010
  if (b.attachment) Object.assign(row, { attachment_path: b.attachment.path, attachment_name: b.attachment.name, attachment_type: b.attachment.type, attachment_size: b.attachment.size });
  const msg = withSignedAttachment({ ...unwrap(await db.from('messages').insert(row).select().single()), reply_to: quoted });
  setTyping(c.id, req.user.id, false);
  const other = c.participant_a === req.user.id ? c.participant_b : c.participant_a;
  const preview = b.body?.trim() ? b.body.trim().slice(0, 100) : b.attachment ? attachmentLabel({ attachment_type: b.attachment.type, attachment_name: b.attachment.name }) : '📎 Attachment';
  if (c.context_type === 'support') await onUserSupportMessage(c.context_id, b.body?.trim() || preview, req.user);
  else if (other) await notify(other, 'message', fullName(req.user) || 'New message', preview, { conversationId: c.id });
  res.status(201).json({ message: msg });
  // Scam screening runs after the reply so sending never waits on it (services/scamGuard.ts).
  if (c.context_type !== 'support') void screenMessage(c, msg);
});

/** Scam warnings for me in this chat (the person who sent the flagged messages never sees them). */
r.get('/:id/safety', async (req, res) => {
  await getConv(req.params.id, req.user.id);
  const { data, error } = await db.from('scam_alerts').select('id, message_id, risk, category, reason, status, created_at')
    .eq('conversation_id', req.params.id).eq('recipient_id', req.user.id).in('status', ['open', 'reported', 'confirmed'])
    .order('created_at', { ascending: false }).limit(5);
  res.json({ alerts: error ? [] : data ?? [] });
});

/** "Report" (sends it to the RentCreeb team as urgent) or "It's fine" (hides the warning). */
r.post('/:id/safety/:alertId', async (req, res) => {
  await getConv(req.params.id, req.user.id);
  const { action, note } = z.object({ action: z.enum(['report', 'dismiss']), note: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
  const { data: a } = await db.from('scam_alerts').select('id, status, admin_note').eq('id', req.params.alertId).eq('conversation_id', req.params.id).eq('recipient_id', req.user.id).maybeSingle();
  if (!a) throw notFound('Alert not found');
  if (a.status === 'confirmed' && action === 'dismiss') return res.json({ ok: true }); // the team already confirmed it: keep the warning
  await db.from('scam_alerts').update({
    status: action === 'report' ? 'reported' : 'dismissed', user_action_at: new Date().toISOString(),
    ...(note ? { admin_note: [a.admin_note, `User: ${note}`].filter(Boolean).join('\n') } : {}),
  }).eq('id', a.id);
  res.json({ ok: true });
});

r.get('/:id/messages/:messageId', async (req, res) => {
  await getConv(req.params.id, req.user.id);
  const { data } = await db.from('messages').select('*').eq('id', req.params.messageId).eq('conversation_id', req.params.id).maybeSingle();
  if (!data) throw badRequest('Message not found', 'NOT_FOUND');
  res.json({ message: withSignedAttachment(data) });
});

const showsActivity = (prefs: unknown) => ((prefs as Record<string, unknown> | null)?.activity_status ?? PRIVACY_DEFAULTS.activity_status) !== false;

/** "I'm typing" ping (the app sends it at most every few seconds while the composer has text; it expires by itself). */
r.post('/:id/typing', async (req, res) => {
  const c = await getConv(req.params.id, req.user.id);
  const { typing } = z.object({ typing: z.boolean() }).parse(req.body ?? {});
  setTyping(c.id, req.user.id, typing);
  res.status(204).end();
});

/** The other person's live status for the chat header: typing…, on a call, online / last seen. */
r.get('/:id/activity', async (req, res) => {
  const c = await getConv(req.params.id, req.user.id);
  const otherId = c.participant_a === req.user.id ? c.participant_b : c.participant_a;
  if (c.context_type === 'support' || !otherId) return res.json({ visible: true, typing: isTyping(c.id, 'support'), inCall: false, online: false, lastSeenAt: null });
  const { data: other } = await db.from('profiles').select('privacy_prefs').eq('id', otherId).maybeSingle();
  if (!showsActivity(other?.privacy_prefs) || !showsActivity((req.user as any).privacy_prefs)) {
    return res.json({ visible: false, typing: false, inCall: false, online: false, lastSeenAt: null });
  }
  // "On a call": answered, or ringing within the last minute. Missing calls table (before migration 009) just means no.
  // Answered calls older than 2h are treated as stale (an app that crashed without hanging up).
  const since = new Date(Date.now() - 60_000).toISOString();
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const calls = await db.from('calls').select('id, status, created_at').or(`caller_id.eq.${otherId},callee_id.eq.${otherId}`)
    .or(`and(status.eq.accepted,created_at.gte."${stale}"),and(status.eq.ringing,created_at.gte."${since}")`).limit(1);
  const inCall = !calls.error && (calls.data ?? []).length > 0;
  res.json({ visible: true, typing: isTyping(c.id, otherId), inCall, ...presenceOf(otherId) });
});

r.post('/:id/read', async (req, res) => {
  await getConv(req.params.id, req.user.id);
  await db.from('messages').update({ read_at: new Date().toISOString() }).eq('conversation_id', req.params.id).neq('sender_id', req.user.id).is('read_at', null);
  res.status(204).end();
});

export default r;
