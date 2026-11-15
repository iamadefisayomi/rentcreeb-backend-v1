import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { fullName } from '../lib/common';
import { authenticate } from '../middleware/auth';
import { notify } from '../services/notify';

/**
 * In-app voice/video calls between the two people in a conversation.
 *
 * Media is peer-to-peer WebRTC (inside a WebView in the app); this API only does signalling:
 * the caller stores a complete SDP offer (ICE gathered, no trickle), the callee stores the answer,
 * and both sides poll GET /calls/:id for state changes. A ringing call expires after RING_SECONDS.
 */
const r = Router();
r.use(authenticate);

const RING_SECONDS = 45;
const PARTY = 'id, first_name, last_name, avatar_url';
const sdp = z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().min(10).max(20000) });
type Call = {
  id: string; conversation_id: string; caller_id: string; callee_id: string; kind: 'audio' | 'video'; status: string;
  offer: unknown; answer: unknown; end_reason: string | null; created_at: string; answered_at: string | null; ended_at: string | null;
};

export function iceServers() {
  const list: { urls: string[]; username?: string; credential?: string }[] = [];
  const stun = env.STUN_URLS.split(',').map((x) => x.trim()).filter(Boolean);
  if (stun.length) list.push({ urls: stun });
  const turn = (env.TURN_URLS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (turn.length) list.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  return list;
}

const label = (kind: string) => (kind === 'video' ? 'video call' : 'voice call');
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

async function load(id: string, userId: string): Promise<Call> {
  const { data, error } = await db.from('calls').select('*').eq('id', id).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw notFound('Call not found');
  if (data.caller_id !== userId && data.callee_id !== userId) throw forbidden();
  return expire(data as Call);
}

/** Lazily turns an unanswered call into "missed" once it has rung for too long. */
async function expire(c: Call): Promise<Call> {
  if (c.status !== 'ringing' || Date.now() - new Date(c.created_at).getTime() < RING_SECONDS * 1000) return c;
  return finish(c, 'missed', 'no_answer');
}

/** Moves a call to a final state once (guarded on the current status), logs it in the chat and tells the callee about misses. */
async function finish(c: Call, status: 'declined' | 'missed' | 'cancelled' | 'ended' | 'failed', reason?: string): Promise<Call> {
  const now = new Date().toISOString();
  const { data } = await db.from('calls').update({ status, end_reason: reason ?? null, ended_at: now })
    .eq('id', c.id).eq('status', c.status).select('*').maybeSingle();
  if (!data) { const { data: cur } = await db.from('calls').select('*').eq('id', c.id).maybeSingle(); return (cur ?? c) as Call; } // someone else finished it first
  const call = data as Call;
  const secs = call.answered_at ? Math.max(0, Math.round((Date.parse(now) - Date.parse(call.answered_at)) / 1000)) : 0;
  const body = status === 'ended' && call.answered_at ? `📞 ${label(call.kind)[0].toUpperCase()}${label(call.kind).slice(1)} · ${mmss(secs)}`
    : status === 'declined' ? `📞 Declined ${label(call.kind)}`
    : status === 'failed' ? `📞 ${label(call.kind)[0].toUpperCase()}${label(call.kind).slice(1)} couldn't connect`
    : `📞 Missed ${label(call.kind)}`;
  await db.from('messages').insert({ conversation_id: call.conversation_id, sender_id: call.caller_id, body });
  if (status === 'missed' || (status === 'cancelled' && !call.answered_at)) {
    const { data: caller } = await db.from('profiles').select(PARTY).eq('id', call.caller_id).maybeSingle();
    await notify(call.callee_id, 'missed_call', `Missed ${label(call.kind)}`, `${fullName(caller ?? {}) || 'Someone'} tried to call you`, { conversationId: call.conversation_id });
  }
  return call;
}

async function withParties(c: Call, userId: string) {
  const otherId = c.caller_id === userId ? c.callee_id : c.caller_id;
  const { data: other } = await db.from('profiles').select(PARTY).eq('id', otherId).maybeSingle();
  return { ...c, role: c.caller_id === userId ? 'caller' : 'callee', other };
}

r.get('/config', (_req, res) => { res.json({ iceServers: iceServers(), ringSeconds: RING_SECONDS }); });

/** Start a call to the other person in a conversation. */
r.post('/', async (req, res) => {
  const b = z.object({ conversationId: z.string().uuid(), kind: z.enum(['audio', 'video']).default('audio') }).parse(req.body);
  const { data: conv } = await db.from('conversations').select('*').eq('id', b.conversationId).maybeSingle();
  if (!conv) throw notFound('Conversation not found');
  if (![conv.participant_a, conv.participant_b].includes(req.user.id)) throw forbidden();
  const callee = conv.participant_a === req.user.id ? conv.participant_b : conv.participant_a;

  // One call at a time per person: clear our own stale rings, then refuse if the other person is busy.
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: open, error } = await db.from('calls').select('*').in('status', ['ringing', 'accepted']).gte('created_at', since)
    .or(`caller_id.eq.${callee},callee_id.eq.${callee},caller_id.eq.${req.user.id},callee_id.eq.${req.user.id}`);
  if (error) throw dbError(error);
  for (const c of (open ?? []) as Call[]) {
    const live = await expire(c);
    if (!['ringing', 'accepted'].includes(live.status)) continue;
    if (live.caller_id === req.user.id || live.callee_id === req.user.id) await finish(live, live.status === 'accepted' ? 'ended' : 'cancelled', 'superseded');
    else throw badRequest('They are on another call. Try again shortly.', 'CALLEE_BUSY');
  }

  const call = unwrap(await db.from('calls').insert({ conversation_id: conv.id, caller_id: req.user.id, callee_id: callee, kind: b.kind }).select('*').single()) as Call;
  await notify(callee, 'incoming_call', `Incoming ${label(b.kind)}`, `${fullName(req.user) || 'Someone'} is calling you on RentCreeb`, { callId: call.id, kind: b.kind });
  res.status(201).json({ call: await withParties(call, req.user.id), iceServers: iceServers(), ringSeconds: RING_SECONDS });
});

/** The newest call ringing for me right now (the app polls this while open). */
r.get('/incoming', async (req, res) => {
  const since = new Date(Date.now() - RING_SECONDS * 1000).toISOString();
  const { data, error } = await db.from('calls').select('*').eq('callee_id', req.user.id).eq('status', 'ringing').gte('created_at', since)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw dbError(error);
  const c = (data ?? [])[0] as Call | undefined;
  res.json({ call: c ? await withParties(c, req.user.id) : null });
});

r.get('/:id', async (req, res) => {
  const c = await load(req.params.id, req.user.id);
  res.json({ call: await withParties(c, req.user.id), iceServers: iceServers(), ringSeconds: RING_SECONDS });
});

/** Caller: store the SDP offer (complete, with ICE candidates). */
r.post('/:id/offer', async (req, res) => {
  const c = await load(req.params.id, req.user.id);
  if (c.caller_id !== req.user.id) throw forbidden();
  if (c.status !== 'ringing') throw badRequest('This call is no longer ringing', 'CALL_OVER');
  const offer = sdp.parse(req.body);
  await db.from('calls').update({ offer }).eq('id', c.id);
  res.status(204).end();
});

/** Callee: accept with the SDP answer. */
r.post('/:id/answer', async (req, res) => {
  const c = await load(req.params.id, req.user.id);
  if (c.callee_id !== req.user.id) throw forbidden();
  if (c.status !== 'ringing') throw badRequest('This call has ended', 'CALL_OVER');
  const answer = sdp.parse(req.body);
  const { data } = await db.from('calls').update({ answer, status: 'accepted', answered_at: new Date().toISOString() }).eq('id', c.id).eq('status', 'ringing').select('id').maybeSingle();
  if (!data) throw badRequest('This call has ended', 'CALL_OVER');
  res.status(204).end();
});

r.post('/:id/decline', async (req, res) => {
  const c = await load(req.params.id, req.user.id);
  if (c.callee_id !== req.user.id) throw forbidden();
  if (c.status === 'ringing') await finish(c, 'declined', 'declined');
  res.status(204).end();
});

/** Either side hangs up. Before an answer: caller = cancelled (or missed on timeout), callee = declined. */
r.post('/:id/end', async (req, res) => {
  const { reason } = z.object({ reason: z.enum(['hangup', 'no_answer', 'failed', 'busy']).default('hangup') }).parse(req.body ?? {});
  const c = await load(req.params.id, req.user.id);
  if (c.status === 'accepted') await finish(c, reason === 'failed' ? 'failed' : 'ended', reason);
  else if (c.status === 'ringing') {
    if (c.callee_id === req.user.id) await finish(c, 'declined', reason);
    else await finish(c, reason === 'no_answer' ? 'missed' : reason === 'failed' ? 'failed' : 'cancelled', reason);
  }
  res.status(204).end();
});

export default r;
