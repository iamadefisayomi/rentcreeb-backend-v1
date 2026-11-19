import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { authenticate } from '../middleware/auth';
import { SUPPORT_HOURS, assistantReply, availableAgentCount, handOverToHuman, suggestionsFor } from '../services/assistant';

/** RentCreeb Assistant for app users (see services/assistant.ts). */
const r = Router();
r.use(authenticate);

let enabledCache: { at: number; on: boolean } | null = null;
/** Admins can switch the assistant off from the dashboard (app_settings.assistant_enabled = false). */
export async function assistantEnabled() {
  if (!env.ANTHROPIC_API_KEY) return false;
  if (enabledCache && Date.now() - enabledCache.at < 30_000) return enabledCache.on;
  const { data } = await db.from('app_settings').select('value').eq('key', 'assistant_enabled').maybeSingle();
  enabledCache = { at: Date.now(), on: data?.value !== false };
  return enabledCache.on;
}
export const resetAssistantEnabledCache = () => { enabledCache = null; };

// Each reply runs a model call: keep one person from flooding it.
const perUser = rateLimit({ windowMs: 10 * 60_000, limit: 40, standardHeaders: true, legacyHeaders: false, keyGenerator: (req: any) => req.user?.id ?? req.ip,
  handler: (_req, res) => res.status(429).json({ error: { code: 'SLOW_DOWN', message: "You're sending messages very quickly. Please wait a few minutes, or contact support." } }) });

const MSG_COLS = 'id, role, content, actions, feedback, created_at';
async function activeConversation(userId: string) {
  const { data, error } = await db.from('assistant_conversations').select('*').eq('user_id', userId).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw dbError(error);
  return data;
}
async function supportThreadOf(ticketId: string | null) {
  if (!ticketId) return null;
  const { data } = await db.from('support_tickets').select('id, status, conversation_id, assigned_to').eq('id', ticketId).maybeSingle();
  return data ? { ticketId: data.id, conversationId: data.conversation_id, status: data.status, assigned: !!data.assigned_to } : null;
}

r.get('/status', async (_req, res) => {
  res.json({ enabled: await assistantEnabled(), agentsOnline: await availableAgentCount(), supportHours: SUPPORT_HOURS });
});

/** The current chat (or the most recent handed-over one from the last day), with its messages. */
r.get('/conversation', async (req, res) => {
  let conv = await activeConversation(req.user.id);
  if (!conv) {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    conv = (await db.from('assistant_conversations').select('*').eq('user_id', req.user.id).eq('status', 'handed_off').gte('updated_at', since).order('updated_at', { ascending: false }).limit(1).maybeSingle()).data;
  }
  const messages = conv ? unwrap(await db.from('assistant_messages').select(MSG_COLS).eq('conversation_id', conv.id).neq('role', 'system').order('created_at').limit(200)) : [];
  res.json({
    enabled: await assistantEnabled(), suggestions: suggestionsFor(req.user.role),
    conversation: conv ? { id: conv.id, status: conv.status, handoff: await supportThreadOf(conv.ticket_id) } : null, messages,
  });
});

r.post('/messages', perUser, async (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(1, 'Type a message').max(2000) }).parse(req.body);
  if (!(await assistantEnabled())) throw badRequest('The assistant is not available right now. Please contact support.', 'ASSISTANT_OFF');
  let conv = await activeConversation(req.user.id);
  if (!conv) conv = unwrap(await db.from('assistant_conversations').insert({ user_id: req.user.id, title: text.slice(0, 80) }).select().single());
  const { data: past } = await db.from('assistant_messages').select('role, content').eq('conversation_id', conv.id).in('role', ['user', 'assistant']).order('created_at', { ascending: false }).limit(24);
  const userMsg = unwrap(await db.from('assistant_messages').insert({ conversation_id: conv.id, role: 'user', content: text }).select(MSG_COLS).single());

  const out = await assistantReply(req.user as any, [...(past ?? [])].reverse() as any, text);
  let handoff = null as Awaited<ReturnType<typeof handOverToHuman>> | null;
  if (out.handoff) {
    try { handoff = await handOverToHuman(req.user as any, conv.id, out.handoff.reason); }
    catch (err) { logger.error({ err }, 'assistant handover failed'); out.text += '\n\nI could not reach the support team just now. Please use Contact Support.'; out.actions = [{ label: 'Contact Support', screen: 'ContactSupport' }]; }
  }
  const reply = unwrap(await db.from('assistant_messages').insert({ conversation_id: conv.id, role: 'assistant', content: out.text, actions: out.actions, meta: out.meta }).select(MSG_COLS).single());
  await db.from('assistant_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conv.id);
  res.json({ conversation: { id: conv.id, status: handoff ? 'handed_off' : 'active', handoff: handoff ? await supportThreadOf(handoff.ticketId) : null }, userMessage: userMsg, reply, agent: handoff?.agent ?? null });
});

/** "Talk to a person" button: hand over without going through the model. */
r.post('/handoff', async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
  let conv = await activeConversation(req.user.id);
  if (!conv) conv = unwrap(await db.from('assistant_conversations').insert({ user_id: req.user.id, title: 'Asked for a person' }).select().single());
  const why = reason || (await db.from('assistant_messages').select('content').eq('conversation_id', conv.id).eq('role', 'user').order('created_at', { ascending: false }).limit(1).maybeSingle()).data?.content?.slice(0, 200) || 'Asked to talk to a person';
  const h = await handOverToHuman(req.user as any, conv.id, why);
  const text = h.agent ? `I've connected you with ${h.agent} from our support team. They'll continue with you in Messages.`
    : `Our support team has your request and will reply in Messages${(await availableAgentCount()) ? ' shortly' : ` (support hours ${SUPPORT_HOURS})`}.`;
  if (!h.alreadyHandedOff) await db.from('assistant_messages').insert({ conversation_id: conv.id, role: 'assistant', content: text, meta: { handoff: true } });
  res.json({ conversation: { id: conv.id, status: 'handed_off', handoff: await supportThreadOf(h.ticketId) }, agent: h.agent, message: text });
});

/** Start a fresh chat. */
r.post('/reset', async (req, res) => {
  await db.from('assistant_conversations').update({ status: 'ended', updated_at: new Date().toISOString() }).eq('user_id', req.user.id).eq('status', 'active');
  res.status(204).end();
});

r.post('/messages/:id/feedback', async (req, res) => {
  const { value } = z.object({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }).parse(req.body);
  const { data: m } = await db.from('assistant_messages').select('id, conversation_id, role, assistant_conversations!inner(user_id)').eq('id', String(req.params.id)).maybeSingle();
  if (!m || (m as any).assistant_conversations?.user_id !== req.user.id || m.role !== 'assistant') throw notFound('Message not found');
  await db.from('assistant_messages').update({ feedback: value || null }).eq('id', m.id);
  res.status(204).end();
});

export default r;
