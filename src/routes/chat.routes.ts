import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { forbidden, notFound, badRequest } from '../lib/errors';
import { fullName } from '../lib/common';
import { authenticate } from '../middleware/auth';
import { notify } from '../services/notify';

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
  const [bks, jbs] = await Promise.all([
    bIds.length ? db.from('bookings').select('id, status, scheduled_at, properties(id, title, area, property_media(url, position))').in('id', bIds) : Promise.resolve({ data: [] as any[] }),
    jIds.length ? db.from('jobs').select('id, status, title, properties(id, title, area)').in('id', jIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  const ctx = new Map<string, any>();
  for (const x of (bks.data ?? []) as any[]) {
    const cover = [...(x.properties?.property_media ?? [])].sort((m: any, n: any) => m.position - n.position)[0]?.url ?? null;
    ctx.set(x.id, { id: x.id, kind: 'booking', status: x.status, title: x.properties?.title ?? 'Inspection', area: x.properties?.area ?? null, propertyId: x.properties?.id ?? null, date: x.scheduled_at, cover });
  }
  for (const x of (jbs.data ?? []) as any[]) ctx.set(x.id, { id: x.id, kind: 'job', status: x.status, title: x.title, area: x.properties?.area ?? null, propertyId: x.properties?.id ?? null, date: null, cover: null, property: x.properties?.title ?? null });
  for (const c of out as any[]) c.context = ctx.get(c.contextId) ?? null;
}

/** Conversations exist only after a booking is confirmed or a job is assigned. */
r.get('/', async (req, res) => {
  const { data: convs } = await db.from('conversations').select(
    '*, a:profiles!conversations_participant_a_fkey(id, first_name, last_name, avatar_url), b:profiles!conversations_participant_b_fkey(id, first_name, last_name, avatar_url)')
    .or(`participant_a.eq.${req.user.id},participant_b.eq.${req.user.id}`);
  const out = await Promise.all((convs ?? []).map(async (c: any) => {
    const { data: last } = await db.from('messages').select('body, attachment_url, created_at, sender_id').eq('conversation_id', c.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const { count } = await db.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', c.id).neq('sender_id', req.user.id).is('read_at', null);
    return { id: c.id, contextType: c.context_type, contextId: c.context_id, other: c.participant_a === req.user.id ? c.b : c.a, lastMessage: last, unreadCount: count ?? 0 };
  }));
  await attachContext(out);
  out.sort((x, y) => (y.lastMessage?.created_at ?? '').localeCompare(x.lastMessage?.created_at ?? ''));
  res.json({ conversations: out });
});

/** One conversation with the other participant and its context (chat header; push deep links only carry the id). */
r.get('/:id', async (req, res) => {
  const c: any = await getConv(String(req.params.id), req.user.id);
  const otherId = c.participant_a === req.user.id ? c.participant_b : c.participant_a;
  const { data: other } = await db.from('profiles').select('id, first_name, last_name, avatar_url, nin_verified, role').eq('id', otherId).maybeSingle();
  const conv: any = { id: c.id, contextType: c.context_type, contextId: c.context_id, other };
  await attachContext([conv]);
  res.json({ conversation: conv });
});

r.get('/:id/messages', async (req, res) => {
  await getConv(req.params.id, req.user.id);
  const { before, limit } = z.object({ before: z.string().optional(), limit: z.coerce.number().max(100).default(40) }).parse(req.query);
  let q = db.from('messages').select('*').eq('conversation_id', req.params.id).order('created_at', { ascending: false }).limit(limit);
  if (before) q = q.lt('created_at', before);
  res.json({ messages: (await q).data });
});

r.post('/:id/messages', async (req, res) => {
  const c = await getConv(req.params.id, req.user.id);
  const b = z.object({ body: z.string().max(4000).optional(), attachmentUrl: z.string().url().optional() }).parse(req.body);
  if (!b.body && !b.attachmentUrl) throw badRequest('Empty message');
  const msg = unwrap(await db.from('messages').insert({ conversation_id: c.id, sender_id: req.user.id, body: b.body, attachment_url: b.attachmentUrl }).select().single());
  const other = c.participant_a === req.user.id ? c.participant_b : c.participant_a;
  await notify(other, 'message', fullName(req.user) || 'New message', b.body?.slice(0, 100) ?? '📎 Attachment', { conversationId: c.id });
  res.status(201).json({ message: msg });
});

r.post('/:id/read', async (req, res) => {
  await getConv(req.params.id, req.user.id);
  await db.from('messages').update({ read_at: new Date().toISOString() }).eq('conversation_id', req.params.id).neq('sender_id', req.user.id).is('read_at', null);
  res.status(204).end();
});

export default r;
