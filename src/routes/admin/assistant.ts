import type { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap, unwrapMaybe } from '../../lib/supabase';
import { badRequest, notFound } from '../../lib/errors';
import { paginate, uuid } from '../../lib/common';
import { env } from '../../config/env';
import { PERSON, audit } from './shared';
import { assistantModel, assistantProvider, assistantReply, availableAgentCount, refreshAssistantKnowledge, suggestionsFor } from '../../services/assistant';
import { assistantEnabled, resetAssistantEnabledCache } from '../assistant.routes';

/**
 * Admin → Assistant (knowledge, conversations, test, on/off) and support-agent availability for live handovers.
 */
const MISSING = (e: any) => e && (e.code === 'PGRST205' || e.code === '42P01');

export function mountAssistant(r: Router) {
  r.get('/assistant/overview', async (_req, res) => {
    const probe = await db.from('assistant_conversations').select('id', { head: true, count: 'exact' }).limit(1);
    if (MISSING(probe.error)) return res.json({ available: false });
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const c = async (t: string, f: (q: any) => any) => { const { count } = await f(db.from(t).select('*', { count: 'exact', head: true })); return count ?? 0; };
    const [chats, msgs, handoffs, up, down, articles] = await Promise.all([
      c('assistant_conversations', (q) => q.gte('created_at', since)), c('assistant_messages', (q) => q.eq('role', 'user').gte('created_at', since)),
      c('assistant_conversations', (q) => q.eq('status', 'handed_off').gte('updated_at', since)),
      c('assistant_messages', (q) => q.eq('feedback', 1).gte('created_at', since)), c('assistant_messages', (q) => q.eq('feedback', -1).gte('created_at', since)),
      c('assistant_knowledge', (q) => q.eq('active', true)),
    ]);
    const provider = assistantProvider();
    res.json({ available: true, enabled: await assistantEnabled(), configured: !!provider, provider: provider === 'anthropic' ? 'Claude' : provider === 'openai' ? 'NVIDIA' : null, model: assistantModel(), effort: provider === 'anthropic' ? env.ASSISTANT_EFFORT : null,
      week: { chats, messages: msgs, handoffs, thumbsUp: up, thumbsDown: down }, articles, agentsOnline: await availableAgentCount() });
  });
  r.put('/assistant/settings', async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const { error } = await db.from('app_settings').upsert({ key: 'assistant_enabled', value: enabled, updated_by: req.user.id, updated_at: new Date().toISOString() });
    if (error) throw dbError(error);
    resetAssistantEnabledCache();
    await audit(req, `assistant.${enabled ? 'on' : 'off'}`, 'settings', 'assistant_enabled');
    res.json({ enabled });
  });

  // ── knowledge articles (read live by the assistant) ──
  r.get('/assistant/knowledge', async (_req, res) => {
    const { data, error } = await db.from('assistant_knowledge').select('*, editor:profiles!assistant_knowledge_updated_by_fkey(first_name, last_name)').order('updated_at', { ascending: false });
    if (error) throw dbError(error);
    res.json({ articles: data });
  });
  const article = z.object({ title: z.string().trim().min(2).max(160), body: z.string().trim().min(2).max(8000), tags: z.array(z.string().trim().max(40)).max(10).default([]), active: z.boolean().default(true) });
  r.post('/assistant/knowledge', async (req, res) => {
    const b = article.parse(req.body);
    const row = unwrap(await db.from('assistant_knowledge').insert({ ...b, updated_by: req.user.id }).select().single());
    refreshAssistantKnowledge();
    await audit(req, 'assistant.knowledge_add', 'assistant_knowledge', row.id, { title: b.title });
    res.status(201).json({ article: row });
  });
  r.patch('/assistant/knowledge/:id', async (req, res) => {
    const b = article.partial().parse(req.body);
    const row = unwrap(await db.from('assistant_knowledge').update({ ...b, updated_by: req.user.id, updated_at: new Date().toISOString() }).eq('id', uuid.parse(req.params.id)).select().single());
    refreshAssistantKnowledge();
    await audit(req, 'assistant.knowledge_edit', 'assistant_knowledge', row.id, { title: row.title });
    res.json({ article: row });
  });
  r.delete('/assistant/knowledge/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await db.from('assistant_knowledge').delete().eq('id', id);
    refreshAssistantKnowledge();
    await audit(req, 'assistant.knowledge_delete', 'assistant_knowledge', id);
    res.status(204).end();
  });

  // ── conversations (for quality review) ──
  r.get('/assistant/conversations', async (req, res) => {
    const { from, to } = paginate(req.query);
    const f = z.object({ filter: z.enum(['all', 'handed_off', 'disliked']).default('all') }).parse(req.query);
    let q = db.from('assistant_conversations').select(`id, status, title, created_at, updated_at, ticket_id, user:profiles!assistant_conversations_user_id_fkey(${PERSON})`, { count: 'exact' }).order('updated_at', { ascending: false }).range(from, to);
    if (f.filter === 'handed_off') q = q.eq('status', 'handed_off');
    if (f.filter === 'disliked') {
      const { data: bad } = await db.from('assistant_messages').select('conversation_id').eq('feedback', -1).limit(1000);
      q = q.in('id', [...new Set((bad ?? []).map((b: any) => b.conversation_id))].concat(['00000000-0000-0000-0000-000000000000']));
    }
    const { data, count, error } = await q;
    if (error) throw dbError(error);
    res.json({ conversations: data, total: count ?? 0 });
  });
  r.get('/assistant/conversations/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const conv = unwrapMaybe(await db.from('assistant_conversations').select(`*, user:profiles!assistant_conversations_user_id_fkey(${PERSON})`).eq('id', id).maybeSingle());
    if (!conv) throw notFound('Conversation not found');
    const messages = unwrap(await db.from('assistant_messages').select('id, role, content, actions, meta, feedback, created_at').eq('conversation_id', id).order('created_at').limit(500));
    await audit(req, 'assistant.conversation_view', 'assistant_conversation', id);
    res.json({ conversation: conv, messages });
  });

  /** Try the assistant as a given role (uses your own account's data for "my …" questions). Nothing is saved. */
  r.post('/assistant/test', async (req, res) => {
    const b = z.object({ text: z.string().trim().min(1).max(2000), asRole: z.enum(['tenant', 'agent', 'landlord', 'estate_manager', 'artisan']).default('tenant'),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(20).default([]) }).parse(req.body);
    if (!assistantProvider()) throw badRequest('Set ANTHROPIC_API_KEY or NVIDIA_API_KEY on the server to use the assistant', 'NOT_CONFIGURED');
    const out = await assistantReply({ ...(req.user as any), role: b.asRole }, b.history, b.text);
    res.json({ reply: out.text, actions: out.actions, handoff: out.handoff, meta: out.meta, suggestions: suggestionsFor(b.asRole) });
  });

  // ── support agents: who can take a live handover right now ──
  r.get('/support/agents', async (_req, res) => {
    const [{ data: admins }, { data: agents }] = await Promise.all([
      db.from('profiles').select('id, first_name, last_name, email, avatar_url').in('role', ['admin', 'admin_manager']).is('deleted_at', null),
      db.from('support_agents').select('*'),
    ]);
    const since = Date.now() - 3 * 60_000;
    const out = await Promise.all((admins ?? []).map(async (a: any) => {
      const s: any = (agents ?? []).find((x: any) => x.admin_id === a.id);
      const { count } = await db.from('support_tickets').select('id', { count: 'exact', head: true }).eq('assigned_to', a.id).in('status', ['open', 'in_progress']);
      return { ...a, available: !!s?.available, online: !!s?.last_seen_at && Date.parse(s.last_seen_at) > since, maxOpen: s?.max_open ?? 15, lastSeenAt: s?.last_seen_at ?? null, openChats: count ?? 0 };
    }));
    res.json({ agents: out });
  });
  r.put('/support/me', async (req, res) => {
    const b = z.object({ available: z.boolean().optional(), maxOpen: z.number().int().min(1).max(500).optional() }).parse(req.body);
    const row: Record<string, unknown> = { admin_id: req.user.id, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (b.available !== undefined) row.available = b.available;
    if (b.maxOpen !== undefined) row.max_open = b.maxOpen;
    const { data, error } = await db.from('support_agents').upsert(row).select().single();
    if (MISSING(error)) throw badRequest('Run migration 020_assistant.sql to turn on live chat availability', 'MIGRATION_REQUIRED');
    if (error) throw dbError(error);
    if (b.available !== undefined) await audit(req, `support.${b.available ? 'available' : 'away'}`, 'support_agent', req.user.id);
    res.json({ available: data.available, maxOpen: data.max_open });
  });
  /** The dashboard pings this every minute: keeps "online" fresh and reports chats waiting on this admin. */
  r.post('/support/heartbeat', async (req, res) => {
    const { data: me } = await db.from('support_agents').select('available').eq('admin_id', req.user.id).maybeSingle();
    if (me) await db.from('support_agents').update({ last_seen_at: new Date().toISOString() }).eq('admin_id', req.user.id);
    const { data: waiting } = await db.from('support_tickets').select('id, subject, last_message_at').eq('assigned_to', req.user.id).eq('awaiting', 'staff').in('status', ['open', 'in_progress'])
      .order('last_message_at', { ascending: false }).limit(5);
    res.json({ available: !!me?.available, waiting: waiting ?? [] });
  });
}
