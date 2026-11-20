import { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { fullName, uuid } from '../lib/common';
import { authenticate, requireRole } from '../middleware/auth';
import { notify } from '../services/notify';
import { ensureConversation } from '../services/conversations';

/**
 * Roommate matching. Tenants publish a short profile (need a room / have a room, areas, budget, move-in date, lifestyle),
 * browse others, and send a request. Contact details stay private: an accepted request opens a chat in Messages.
 * Only identity-verified people can send or accept requests.
 */
const r = Router();
r.use(authenticate, requireRole('tenant'));
export const LIFESTYLE = ['Non-smoker', 'Early riser', 'Night owl', 'Works from home', 'Student', 'Pets OK', 'No pets', 'Quiet', 'Social', 'Clean & tidy', 'Religious', 'Cooks often'];
const PROFILE_PUBLIC = 'user_id, looking_for, areas, budget_min_kobo, budget_max_kobo, move_in_date, gender, preferred_gender, occupation, about, lifestyle, updated_at, property:properties(id, title, area, price_kobo, price_period), person:profiles!roommate_profiles_user_id_fkey(id, first_name, avatar_url, nin_verified, created_at)';

r.get('/me', async (req, res) => {
  const { data, error } = await db.from('roommate_profiles').select('*').eq('user_id', req.user.id).maybeSingle();
  if (error) throw dbError(error);
  res.json({ profile: data, lifestyleOptions: LIFESTYLE });
});
r.put('/me', async (req, res) => {
  const b = z.object({
    active: z.boolean().default(true), looking_for: z.enum(['need_room', 'have_room']),
    areas: z.array(z.string().trim().min(2).max(60)).min(1).max(6), budget_min_kobo: z.number().int().min(0), budget_max_kobo: z.number().int().positive(),
    move_in_date: z.string().date().nullable().optional(), gender: z.enum(['male', 'female', 'other']).nullable().optional(),
    preferred_gender: z.enum(['any', 'male', 'female']).default('any'), occupation: z.string().trim().max(80).nullable().optional(),
    about: z.string().trim().max(600).nullable().optional(), lifestyle: z.array(z.enum(LIFESTYLE as [string, ...string[]])).max(8).default([]),
    property_id: uuid.nullable().optional(),
  }).parse(req.body);
  if (b.budget_min_kobo > b.budget_max_kobo) throw badRequest('Minimum budget is higher than maximum');
  const profile = unwrap(await db.from('roommate_profiles').upsert({ user_id: req.user.id, ...b, updated_at: new Date().toISOString() }).select().single());
  res.json({ profile });
});

/** Browse: active profiles that overlap on area and budget, excluding people you already contacted. */
r.get('/', async (req, res) => {
  const f = z.object({ area: z.string().trim().max(60).optional(), lookingFor: z.enum(['need_room', 'have_room']).optional(), maxBudget: z.coerce.number().optional(), gender: z.enum(['male', 'female']).optional() }).parse(req.query);
  const { data: me } = await db.from('roommate_profiles').select('*').eq('user_id', req.user.id).maybeSingle();
  let q = db.from('roommate_profiles').select(PROFILE_PUBLIC).eq('active', true).neq('user_id', req.user.id).order('updated_at', { ascending: false }).limit(60);
  const area = f.area ?? null;
  if (area) q = q.contains('areas', [area]);
  if (f.lookingFor) q = q.eq('looking_for', f.lookingFor);
  if (f.gender) q = q.eq('gender', f.gender);
  if (f.maxBudget) q = q.lte('budget_min_kobo', f.maxBudget);
  const { data, error } = await q;
  if (error) throw dbError(error);
  const { data: reqs } = await db.from('roommate_requests').select('from_user, to_user, status').or(`from_user.eq.${req.user.id},to_user.eq.${req.user.id}`);
  const rel = new Map<string, string>();
  for (const x of reqs ?? []) rel.set(x.from_user === req.user.id ? x.to_user : x.from_user, x.status);
  // Simple compatibility score so the best matches come first.
  const score = (p: any) => {
    if (!me) return 0;
    let s = 0;
    if (p.areas?.some((a: string) => me.areas?.map((x: string) => x.toLowerCase()).includes(a.toLowerCase()))) s += 40;
    if (p.budget_min_kobo <= me.budget_max_kobo && p.budget_max_kobo >= me.budget_min_kobo) s += 30;
    if (me.looking_for !== p.looking_for) s += 15; // someone with a room meets someone who needs one
    if ((me.preferred_gender === 'any' || me.preferred_gender === p.gender) && (p.preferred_gender === 'any' || p.preferred_gender === me.gender)) s += 10;
    s += Math.min(5, (p.lifestyle ?? []).filter((l: string) => (me.lifestyle ?? []).includes(l)).length);
    return s;
  };
  const list = (data ?? []).filter((p: any) => !me || p.preferred_gender === 'any' || !me.gender || p.preferred_gender === me.gender)
    .map((p: any) => ({ ...p, match: score(p), connection: rel.get(p.user_id) ?? null })).sort((a: any, b: any) => b.match - a.match);
  res.json({ profiles: list, hasProfile: !!me });
});

r.get('/requests', async (req, res) => {
  const sel = 'id, status, message, created_at, from_user, to_user, from:profiles!roommate_requests_from_user_fkey(id, first_name, avatar_url, nin_verified), to:profiles!roommate_requests_to_user_fkey(id, first_name, avatar_url, nin_verified)';
  const { data, error } = await db.from('roommate_requests').select(sel).or(`from_user.eq.${req.user.id},to_user.eq.${req.user.id}`).order('created_at', { ascending: false }).limit(100);
  if (error) throw dbError(error);
  res.json({ incoming: (data ?? []).filter((x: any) => x.to_user === req.user.id), outgoing: (data ?? []).filter((x: any) => x.from_user === req.user.id) });
});

r.post('/requests', async (req, res) => {
  const b = z.object({ toUserId: uuid, message: z.string().trim().max(500).optional() }).parse(req.body);
  if (!req.user.nin_verified) throw forbidden('Verify your identity before contacting possible roommates', 'VERIFICATION_REQUIRED');
  if (b.toUserId === req.user.id) throw badRequest('That is you');
  const { data: target } = await db.from('roommate_profiles').select('user_id').eq('user_id', b.toUserId).eq('active', true).maybeSingle();
  if (!target) throw notFound('This person is no longer looking');
  const { data: reverse } = await db.from('roommate_requests').select('id, status').eq('from_user', b.toUserId).eq('to_user', req.user.id).maybeSingle();
  if (reverse?.status === 'pending') throw conflict('They already sent you a request: accept it in Requests', 'THEY_ASKED');
  const ins = await db.from('roommate_requests').insert({ from_user: req.user.id, to_user: b.toUserId, message: b.message ?? null }).select().single();
  if (ins.error?.code === '23505') throw conflict('You already sent this person a request', 'EXISTS');
  await notify(b.toUserId, 'roommate_request', 'New roommate request', `${req.user.first_name || 'Someone'} would like to connect about sharing a place.`, { roommateRequestId: unwrap(ins).id });
  res.status(201).json({ request: ins.data });
});

r.post('/requests/:id/respond', async (req, res) => {
  const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
  if (accept && !req.user.nin_verified) throw forbidden('Verify your identity before connecting with a roommate', 'VERIFICATION_REQUIRED');
  const { data: rq } = await db.from('roommate_requests').select('*').eq('id', uuid.parse(req.params.id)).eq('to_user', req.user.id).maybeSingle();
  if (!rq || rq.status !== 'pending') throw notFound('Request not found');
  await db.from('roommate_requests').update({ status: accept ? 'accepted' : 'declined', responded_at: new Date().toISOString() }).eq('id', rq.id);
  let conversationId: string | null = null;
  if (accept) {
    const conv = await ensureConversation('roommate', rq.id, rq.from_user, rq.to_user);
    conversationId = conv?.id ?? null;
    if (rq.message && conversationId) await db.from('messages').insert({ conversation_id: conversationId, sender_id: rq.from_user, body: rq.message, created_at: rq.created_at });
  }
  await notify(rq.from_user, accept ? 'message' : 'roommate_request', accept ? 'Roommate request accepted 🎉' : 'Roommate request declined', accept ? `${req.user.first_name || 'They'} accepted. Say hello in Messages.` : 'Keep looking: new people join every day.', accept && conversationId ? { conversationId } : {});
  res.json({ status: accept ? 'accepted' : 'declined', conversationId });
});

r.post('/requests/:id/withdraw', async (req, res) => {
  const { data } = await db.from('roommate_requests').update({ status: 'withdrawn' }).eq('id', uuid.parse(req.params.id)).eq('from_user', req.user.id).eq('status', 'pending').select('id').maybeSingle();
  if (!data) throw badRequest('Nothing to withdraw');
  res.json({ status: 'withdrawn' });
});

export default r;
