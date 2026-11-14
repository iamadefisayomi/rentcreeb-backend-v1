import { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { paginate } from '../lib/common';
import { authenticate, requireRole, requirePhoneVerified } from '../middleware/auth';
import { notify } from '../services/notify';

const r = Router();

// ───────── Shared helpers ─────────
const REVIEWER = 'reviewer:profiles!job_reviews_reviewer_id_fkey(first_name, last_name, role, avatar_url)';
const PAGE = 10;

/** Star breakdown over ALL of an artisan's reviews: { 5: n, 4: n, … } plus total and average. */
async function ratingSummary(userId: string) {
  const { data, error } = await db.from('job_reviews').select('rating').eq('reviewee_id', userId);
  if (error) throw dbError(error);
  const breakdown: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const x of data ?? []) breakdown[x.rating as 1 | 2 | 3 | 4 | 5]++;
  const count = data?.length ?? 0;
  const average = count ? Math.round(((data ?? []).reduce((a, x) => a + x.rating, 0) / count) * 10) / 10 : 0;
  // "Top Rated": a strong average over enough reviews that it isn't luck.
  return { count, average, breakdown, topRated: count >= 10 && average >= 4.5 };
}

/** "NABTEB_Certificate.pdf" → "NABTEB Certificate" — the public label for an uploaded trade certificate. */
const certLabel = (name?: string | null) =>
  (name ?? 'Trade certificate').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Trade certificate';

// ───────── Public ─────────
r.get('/:id/public', async (req, res) => {
  const id = req.params.id;
  const [p, ap, port, reviews, certs, jobs, summary] = await Promise.all([
    db.from('profiles').select('id, first_name, last_name, avatar_url, rating_avg, rating_count, nin_verified, created_at').eq('id', id).eq('role', 'artisan').maybeSingle(),
    db.from('artisan_profiles').select('skill_category, additional_skills, service_areas, years_experience, bio, available, availability_hours').eq('user_id', id).eq('review_status', 'approved').maybeSingle(),
    db.from('artisan_portfolio').select('id, url, caption').eq('user_id', id).order('created_at', { ascending: false }),
    db.from('job_reviews').select(`id, rating, comment, reply, created_at, ${REVIEWER}`).eq('reviewee_id', id).order('created_at', { ascending: false }).limit(PAGE),
    db.from('artisan_documents').select('id, original_name').eq('user_id', id).eq('doc_type', 'trade_certificate'),
    db.from('jobs').select('landlord_id').eq('artisan_id', id).eq('status', 'completed'),
    ratingSummary(id),
  ]);
  if (!p.data || !ap.data) throw notFound('Artisan not found');
  // Repeat clients = landlords who have completed more than one job with this artisan.
  const perClient = new Map<string, number>();
  for (const j of jobs.data ?? []) perClient.set(j.landlord_id, (perClient.get(j.landlord_id) ?? 0) + 1);
  const repeatClients = [...perClient.values()].filter((n) => n > 1).length;
  res.json({
    artisan: { ...p.data, ...ap.data, jobsCompleted: jobs.data?.length ?? 0, repeatClients },
    certifications: (certs.data ?? []).map((c) => ({ id: c.id, label: certLabel(c.original_name) })),
    portfolio: port.data ?? [],
    reviews: reviews.data ?? [],
    summary,
    hasMore: summary.count > PAGE,
  });
});

/** "Load more reviews" on the public profile. */
r.get('/:id/reviews', async (req, res) => {
  const { page, limit, from, to } = paginate({ limit: PAGE, ...req.query });
  const { data, count, error } = await db.from('job_reviews').select(`id, rating, comment, reply, created_at, ${REVIEWER}`, { count: 'exact' })
    .eq('reviewee_id', req.params.id).order('created_at', { ascending: false }).range(from, to);
  if (error) throw dbError(error);
  res.json({ reviews: data ?? [], page, hasMore: (count ?? 0) > page * limit });
});

r.use(authenticate, requireRole('artisan'), requirePhoneVerified);

// ───────── Registration steps 1–3 + 5 (step 4 = /verification/nin) ─────────
const profileBody = z.object({
  skillCategory: z.string().optional(), additionalSkills: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  serviceAreas: z.array(z.string().trim().min(1).max(60)).max(25).optional(), yearsExperience: z.number().int().min(0).max(60).optional(),
  state: z.string().optional(), lga: z.string().optional(), homeAddress: z.string().optional(), bio: z.string().max(300).optional(),
});
r.put('/profile', async (req, res) => {
  const b = profileBody.parse(req.body);
  const row = { user_id: req.user.id, skill_category: b.skillCategory, additional_skills: b.additionalSkills, service_areas: b.serviceAreas,
    years_experience: b.yearsExperience, state: b.state, lga: b.lga, home_address: b.homeAddress, bio: b.bio };
  const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
  res.json({ artisan: unwrap(await db.from('artisan_profiles').upsert(clean).select().single()) });
});

r.get('/me', async (req, res) => {
  const [ap, docs, port, refs] = await Promise.all([
    db.from('artisan_profiles').select('*').eq('user_id', req.user.id).maybeSingle(),
    db.from('artisan_documents').select('id, doc_type, original_name, created_at').eq('user_id', req.user.id),
    db.from('artisan_portfolio').select('*').eq('user_id', req.user.id),
    db.from('artisan_references').select('*').eq('user_id', req.user.id),
  ]);
  res.json({ profile: req.user, artisan: ap.data, documents: docs.data, portfolio: port.data, references: refs.data });
});

/** Register an uploaded private document (path from POST /uploads?folder=artisan-docs). */
r.post('/documents', async (req, res) => {
  const b = z.object({ docType: z.enum(['gov_id', 'trade_certificate', 'other']), path: z.string().startsWith(`artisan-docs/${req.user.id}/`), originalName: z.string().optional() }).parse(req.body);
  res.status(201).json({ document: unwrap(await db.from('artisan_documents').insert({ user_id: req.user.id, doc_type: b.docType, storage_path: b.path, original_name: b.originalName }).select('id, doc_type, original_name').single()) });
});
r.delete('/documents/:id', async (req, res) => { await db.from('artisan_documents').delete().eq('id', req.params.id).eq('user_id', req.user.id); res.status(204).end(); });

r.post('/portfolio', async (req, res) => {
  const b = z.object({ url: z.string().url(), caption: z.string().optional() }).parse(req.body);
  const { count } = await db.from('artisan_portfolio').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
  if ((count ?? 0) >= 6) throw badRequest('Maximum 6 portfolio photos', 'PORTFOLIO_FULL');
  res.status(201).json({ item: unwrap(await db.from('artisan_portfolio').insert({ user_id: req.user.id, ...b }).select().single()) });
});
r.delete('/portfolio/:id', async (req, res) => { await db.from('artisan_portfolio').delete().eq('id', req.params.id).eq('user_id', req.user.id); res.status(204).end(); });

const SOCIAL = z.enum(['instagram', 'facebook', 'linkedin', 'x', 'tiktok', 'website']);
const reference = z.object({
  name: z.string().trim().min(3).max(80),
  phone: z.string().trim().min(10).max(20),
  email: z.string().trim().email().max(120).optional().or(z.literal('').transform(() => undefined)),
  relationship: z.enum(['client', 'employer', 'colleague', 'supplier', 'landlord', 'other']).optional(),
  company: z.string().trim().max(100).optional(),
  jobTitle: z.string().trim().max(80).optional(),
  yearsKnown: z.number().int().min(0).max(60).optional(),
  socials: z.array(z.object({ platform: SOCIAL, handle: z.string().trim().min(1).max(200) })).max(6).default([]),
  note: z.string().trim().max(300).optional(),
  consent: z.literal(true, { errorMap: () => ({ message: 'Confirm each reference agreed to be contacted' }) }),
});
/** Replace the artisan's references. New rows are written before old ones are removed, so a failed write never loses data. */
r.put('/references', async (req, res) => {
  const { references } = z.object({ references: z.array(reference).max(5) }).parse(req.body);
  const old = unwrap(await db.from('artisan_references').select('id').eq('user_id', req.user.id)) ?? [];
  if (references.length) {
    const rows = references.map((x) => ({
      user_id: req.user.id, name: x.name, phone: x.phone, email: x.email ?? null, relationship: x.relationship ?? null, company: x.company || null,
      job_title: x.jobTitle || null, years_known: x.yearsKnown ?? null, socials: x.socials, note: x.note || null, consent: x.consent,
    }));
    const ins = await db.from('artisan_references').insert(rows);
    if (ins.error) throw dbError(ins.error);
  }
  if (old.length) await db.from('artisan_references').delete().in('id', old.map((x: { id: string }) => x.id));
  res.status(204).end();
});

/** Final submit: requires profile, gov ID, NIN verified and accepted terms. Admin reviews within 48h. */
r.post('/submit', async (req, res) => {
  const { acceptTerms } = z.object({ acceptTerms: z.literal(true) }).parse(req.body);
  void acceptTerms;
  const { data: ap } = await db.from('artisan_profiles').select('*').eq('user_id', req.user.id).maybeSingle();
  const { count: ids } = await db.from('artisan_documents').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('doc_type', 'gov_id');
  const missing = [
    !ap?.skill_category && 'skills', !ap?.service_areas?.length && 'service_areas', !ids && 'government_id', !req.user.nin_verified && 'nin_verification',
  ].filter(Boolean);
  if (missing.length) throw badRequest('Application incomplete', 'APPLICATION_INCOMPLETE');
  await db.from('artisan_profiles').update({ review_status: 'pending', terms_accepted_at: new Date().toISOString(), submitted_at: new Date().toISOString(), review_note: null }).eq('user_id', req.user.id);
  await db.from('profiles').update({ onboarding_completed: true }).eq('id', req.user.id);
  res.json({ status: 'pending', message: 'Application submitted. We will review it within 48 hours.' });
});

// ───────── After approval ─────────
r.patch('/availability', async (req, res) => {
  const b = z.object({ available: z.boolean(), hours: z.string().max(100).optional() }).parse(req.body);
  await db.from('artisan_profiles').update({ available: b.available, availability_hours: b.hours }).eq('user_id', req.user.id);
  res.status(204).end();
});

/** My Reviews: a page of reviews plus (on page 1) the rating summary for the header card. */
r.get('/reviews', async (req, res) => {
  const { page, limit, from, to } = paginate(req.query);
  const [list, summary] = await Promise.all([
    db.from('job_reviews').select(`*, ${REVIEWER}, jobs(category, title)`, { count: 'exact' }).eq('reviewee_id', req.user.id).order('created_at', { ascending: false }).range(from, to),
    page === 1 ? ratingSummary(req.user.id) : Promise.resolve(undefined),
  ]);
  if (list.error) throw dbError(list.error);
  res.json({ reviews: list.data ?? [], summary, page, hasMore: (list.count ?? 0) > page * limit });
});
r.post('/reviews/:id/reply', async (req, res) => {
  const { reply } = z.object({ reply: z.string().min(1).max(1000) }).parse(req.body);
  const { data } = await db.from('job_reviews').update({ reply, replied_at: new Date().toISOString() }).eq('id', req.params.id).eq('reviewee_id', req.user.id).select().maybeSingle();
  if (!data) throw forbidden();
  await notify(data.reviewer_id, 'review_reply', 'The artisan replied to your review', reply.slice(0, 100));
  res.json({ review: data });
});

export default r;
