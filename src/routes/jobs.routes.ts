import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { boolish, haversineKm, kobo, paginate, uuid } from '../lib/common';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { createPayment } from '../services/payments';
import { reduceEscrow, releaseEscrow } from '../services/escrow';
import { notify } from '../services/notify';
import { logForJob } from '../services/maintenance';

const r = Router();
r.use(authenticate);
const LANDLORDS = ['landlord', 'estate_manager'] as const;

async function artisanApproved(userId: string) {
  const { data } = await db.from('artisan_profiles').select('*').eq('user_id', userId).maybeSingle();
  if (!data || data.review_status !== 'approved') throw forbidden('Your artisan profile is not approved yet', 'ARTISAN_NOT_APPROVED');
  return data;
}
async function getJob(id: string) {
  const { data } = await db.from('jobs').select('*, properties(id, title, address, area, lat, lng, property_type, bedrooms, property_media(url, position))').eq('id', id).maybeSingle();
  if (!data) throw notFound('Job not found');
  return data as any;
}
const mustBeAssigned = (job: any, userId: string) => { if (job.artisan_id !== userId) throw forbidden('Job not assigned to you'); };
const mustOwn = (job: any, userId: string) => { if (job.landlord_id !== userId) throw forbidden(); };

// ───────── Landlord: create / list / accept ─────────
r.post('/', requireRole(...LANDLORDS), requireVerified, async (req, res) => {
  const b = z.object({
    propertyId: uuid, title: z.string().min(3), category: z.string(), description: z.string().min(5),
    urgency: z.enum(['standard', 'urgent']).default('standard'), budgetMinKobo: kobo, budgetMaxKobo: kobo,
    accessNotes: z.string().optional(), mediaUrls: z.array(z.string().url()).max(6).default([]),
  }).parse(req.body);
  if (b.budgetMinKobo > b.budgetMaxKobo) throw badRequest('Min budget cannot exceed max');
  const { data: p } = await db.from('properties').select('owner_id').eq('id', b.propertyId).maybeSingle();
  if (!p || p.owner_id !== req.user.id) throw forbidden('Not your property');
  const job = unwrap(await db.from('jobs').insert({
    property_id: b.propertyId, landlord_id: req.user.id, title: b.title, category: b.category, description: b.description,
    urgency: b.urgency, budget_min_kobo: b.budgetMinKobo, budget_max_kobo: b.budgetMaxKobo, access_notes: b.accessNotes }).select().single());
  if (b.mediaUrls.length) await db.from('job_media').insert(b.mediaUrls.map((url) => ({ job_id: job.id, kind: 'issue', url })));
  res.status(201).json({ job });
  void alertMatchingArtisans(job, req.user.id);
});

/** Tell approved, available artisans whose skills and service areas match a newly posted job. Best effort, after the response. */
async function alertMatchingArtisans(job: { id: string; title: string; category: string; property_id: string; urgency?: string }, landlordId: string) {
  try {
    const { data: prop } = await db.from('properties').select('area').eq('id', job.property_id).maybeSingle();
    const { data: pros } = await db.from('artisan_profiles').select('user_id, skill_category, additional_skills, service_areas')
      .eq('review_status', 'approved').eq('available', true).limit(1000);
    const matches = (pros ?? []).filter((a: any) => a.user_id !== landlordId
      && (['other', 'general repair'].includes(norm(a.skill_category)) || skillMatches(job, [a.skill_category, ...(a.additional_skills ?? [])].filter(Boolean)))
      && (!(a.service_areas ?? []).length || areaMatches(prop?.area, a.service_areas)));
    const where = prop?.area ? ` in ${prop.area}` : '';
    await Promise.all(matches.slice(0, 200).map((a: any) =>
      notify(a.user_id, 'job_alert', job.urgency === 'urgent' ? `Urgent ${job.category} job${where}` : `New ${job.category} job${where}`, job.title, { jobId: job.id })));
  } catch { /* alerts are best effort; the job is already posted */ }
}

r.get('/mine', requireRole(...LANDLORDS), async (req, res) => {
  const { data } = await db.from('jobs').select('*, job_quotes(count), properties(title)').eq('landlord_id', req.user.id).order('created_at', { ascending: false });
  res.json({ jobs: data });
});

/** Accepting a quote starts an escrow payment; the job is assigned once Paystack confirms. */
r.post('/quotes/:quoteId/accept', requireRole(...LANDLORDS), requireVerified, async (req, res) => {
  const { data: q } = await db.from('job_quotes').select('*, jobs(*)').eq('id', req.params.quoteId).maybeSingle();
  if (!q) throw notFound('Quote not found');
  const job = (q as any).jobs;
  mustOwn(job, req.user.id);
  if (job.status !== 'open' || q.status !== 'pending') throw conflict('This job already has an accepted quote', 'BAD_STATE');
  const payment = await createPayment(req.user, 'job_escrow', Number(q.amount_kobo), { job_id: job.id, quote_id: q.id });
  res.status(201).json({ payment });
});

r.get('/:id/quotes', requireRole(...LANDLORDS), async (req, res) => {
  mustOwn(await getJob(String(req.params.id)), req.user.id);
  const { data } = await db.from('job_quotes').select('*, artisan:profiles!job_quotes_artisan_id_fkey(id, first_name, last_name, avatar_url, rating_avg, rating_count, artisan_profiles(skill_category, years_experience))')
    .eq('job_id', req.params.id).order('created_at');
  res.json({ quotes: data });
});

/** Landlord reviews the artisan's diagnosis before repairs begin. */
/**
 * Landlord reviews the artisan's diagnosis/estimate before repairs begin:
 * approve, reject (artisan revises), or counter with a different amount the artisan can accept or decline.
 */
r.post('/:id/report/:decision', requireRole(...LANDLORDS), async (req, res) => {
  const decisionParam = z.enum(['approve', 'reject', 'counter']).parse(req.params.decision);
  const { note, amountKobo } = z.object({ note: z.string().max(500).optional(), amountKobo: kobo.optional() }).parse(req.body ?? {});
  const job = await getJob(String(req.params.id));
  mustOwn(job, req.user.id);
  if (job.status !== 'awaiting_approval') throw badRequest('No report awaiting approval', 'BAD_STATE');
  if (decisionParam === 'counter') {
    if (!amountKobo) throw badRequest('Enter your counter-offer amount');
    const { data: rep } = await db.from('job_reports').update({ status: 'countered', counter_amount_kobo: amountKobo, counter_note: note ?? null })
      .eq('job_id', job.id).eq('status', 'pending').select('total_kobo').maybeSingle();
    if (!rep) throw badRequest('No pending estimate to counter', 'BAD_STATE');
    if (amountKobo >= Number(rep.total_kobo)) throw badRequest('A counter-offer should be lower than the estimate — approve it instead');
    const naira = `₦${(amountKobo / 100).toLocaleString('en-NG')}`;
    await logForJob(job, req.user.id, 'countered', `Landlord countered the estimate with ${naira}`);
    await notify(job.artisan_id, 'report_countered', 'Counter-offer on your estimate', `${job.title}: the landlord offered ${naira}.${note ? ` “${note}”` : ''}`, { jobId: job.id });
    return res.json({ status: 'countered' });
  }
  const approve = decisionParam === 'approve';
  await db.from('job_reports').update({ status: approve ? 'approved' : 'rejected', review_note: note }).eq('job_id', job.id).eq('status', 'pending');
  await db.from('jobs').update({ status: approve ? 'approved' : 'diagnosing' }).eq('id', job.id);
  await logForJob(job, req.user.id, approve ? 'approved' : 'changes_requested', approve ? 'Repair estimate approved' : (note ?? 'Landlord asked for a revised estimate'));
  await notify(job.artisan_id, approve ? 'report_approved' : 'report_rejected', approve ? 'Approved! 🎉' : 'Diagnosis needs changes', approve ? 'You may begin the repair.' : note ?? 'Please revise your report.', { jobId: job.id });
  res.json({ status: approve ? 'approved' : 'diagnosing' });
});

/** Artisan answers the landlord's counter-offer. Accepting sets the estimate to the counter amount and approves it. */
r.post('/:id/counter/:decision', requireRole('artisan'), async (req, res) => {
  const accept = z.enum(['accept', 'decline']).parse(req.params.decision) === 'accept';
  const job = await getJob(String(req.params.id));
  mustBeAssigned(job, req.user.id);
  const { data: rep } = await db.from('job_reports').select('*').eq('job_id', job.id).eq('status', 'countered').maybeSingle();
  if (!rep) throw badRequest('There is no counter-offer to answer', 'BAD_STATE');
  if (accept) {
    await db.from('job_reports').update({ status: 'approved', total_kobo: rep.counter_amount_kobo }).eq('id', rep.id);
    await db.from('jobs').update({ status: 'approved' }).eq('id', job.id);
  } else {
    await db.from('job_reports').update({ status: 'rejected', review_note: 'Artisan declined the counter-offer' }).eq('id', rep.id);
    await db.from('jobs').update({ status: 'diagnosing' }).eq('id', job.id);
  }
  await logForJob(job, req.user.id, accept ? 'counter_accepted' : 'counter_declined', accept ? 'Artisan accepted the counter-offer' : 'Artisan declined the counter-offer');
  await notify(job.landlord_id, 'report_submitted', accept ? 'Counter-offer accepted' : 'Counter-offer declined',
    accept ? `${job.title}: the artisan will proceed at your price.` : `${job.title}: the artisan will send a revised estimate.`, { jobId: job.id });
  res.json({ status: accept ? 'approved' : 'diagnosing' });
});

/**
 * Landlord decides on the artisan's revised final amount.
 * Lower → difference refunded from escrow now. Higher → returns a Paystack top-up payment; escrow grows once paid.
 */
r.post('/:id/revision/:decision', requireRole(...LANDLORDS), requireVerified, async (req, res) => {
  const decision = z.enum(['approve', 'reject']).parse(req.params.decision);
  const job = await getJob(String(req.params.id));
  mustOwn(job, req.user.id);
  if (job.revision_status !== 'pending') throw badRequest('No revision awaiting a decision', 'BAD_STATE');
  if (decision === 'reject') {
    await db.from('jobs').update({ revision_status: 'rejected' }).eq('id', job.id);
    await notify(job.artisan_id, 'revision_rejected', 'Revised amount declined', 'The original quote stands.', { jobId: job.id });
    return res.json({ revisionStatus: 'rejected' });
  }
  const { data: e } = await db.from('escrows').select('id, amount_kobo').eq('job_id', job.id).eq('kind', 'job').eq('status', 'held').single();
  if (!e) throw conflict('No escrow found for this job');
  const diff = Number(job.revised_amount_kobo) - Number(e.amount_kobo);
  if (diff < 0) {
    await reduceEscrow(e.id, Number(job.revised_amount_kobo));
    await db.from('jobs').update({ revision_status: 'approved' }).eq('id', job.id);
    return res.json({ revisionStatus: 'approved', refundedKobo: -diff });
  }
  const payment = await createPayment(req.user, 'job_topup', diff, { job_id: job.id });
  await db.from('jobs').update({ revision_status: 'awaiting_payment' }).eq('id', job.id);
  res.status(201).json({ revisionStatus: 'awaiting_payment', payment });
});

/** Tenant (or landlord) confirms the work → escrow released to artisan wallet minus 5% fee. */
r.post('/:id/confirm-completion', async (req, res) => {
  const job = await getJob(String(req.params.id));
  if (![job.tenant_id, job.landlord_id].includes(req.user.id)) throw forbidden();
  if (job.status !== 'awaiting_confirmation') throw badRequest('Job is not awaiting confirmation', 'BAD_STATE');
  if (['pending', 'awaiting_payment'].includes(job.revision_status)) throw conflict('A revised amount is awaiting the landlord’s decision', 'REVISION_PENDING');
  const { data: e } = await db.from('escrows').select('id').eq('job_id', job.id).eq('kind', 'job').eq('status', 'held').maybeSingle();
  if (!e) throw conflict('No escrow found for this job');
  const released = await releaseEscrow(e.id);
  await db.from('jobs').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', job.id);
  if (job.maintenance_request_id) await db.from('maintenance_requests').update({ status: 'completed', resolved_at: new Date().toISOString() }).eq('id', job.maintenance_request_id);
  await logForJob(job, req.user.id, 'resolved', 'Completion confirmed — payment released to artisan');
  await notify(job.artisan_id, 'payment_released', 'Payment released! 🎉', `₦${((released!.amount_kobo - released!.fee_kobo) / 100).toLocaleString()} credited to your wallet.`, { jobId: job.id });
  res.json({ status: 'completed' });
});

/** Rate the other party after completion (landlord/tenant → artisan, artisan → landlord). */
r.post('/:id/review', async (req, res) => {
  const b = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }).parse(req.body);
  const job = await getJob(String(req.params.id));
  if (job.status !== 'completed') throw badRequest('Job is not completed', 'BAD_STATE');
  let reviewee: string;
  if (req.user.id === job.artisan_id) reviewee = job.landlord_id;
  else if ([job.landlord_id, job.tenant_id].includes(req.user.id)) reviewee = job.artisan_id;
  else throw forbidden();
  const { data: dup } = await db.from('job_reviews').select('id').eq('job_id', job.id).eq('reviewer_id', req.user.id).maybeSingle();
  if (dup) throw conflict('Already reviewed');
  res.status(201).json({ review: unwrap(await db.from('job_reviews').insert({ job_id: job.id, reviewer_id: req.user.id, reviewee_id: reviewee, rating: b.rating, comment: b.comment }).select().single()) });
});

// ───────── Artisan: alerts, detail, quotes, work ─────────
// ───────── Job matching (alerts) ─────────
const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Common short forms artisans type for service areas. */
const AREA_ALIAS: Record<string, string> = { vi: 'victoria island', 'v i': 'victoria island', 'lekki ph 1': 'lekki phase 1', gra: 'gra' };
const areaKey = (v: unknown) => { const n = norm(v); return AREA_ALIAS[n] ?? n; };
/** "Lekki" covers "Lekki Phase 1"; "Lekki Phase 1" also matches a job tagged just "Lekki". */
export function areaMatches(jobArea: unknown, serviceAreas: string[]) {
  const a = areaKey(jobArea);
  if (!a) return true; // jobs without an area are never hidden
  return serviceAreas.some((s) => { const k = areaKey(s); return !!k && (a === k || a.startsWith(k + ' ') || k.startsWith(a + ' ') || a.includes(' ' + k)); });
}
/** A job matches when its category is one of the artisan's skills, or its title mentions a custom skill. */
export function skillMatches(job: { category?: string; title?: string }, skills: string[]) {
  // Singularise words so "Boreholes" matches "borehole pump".
  const stem = (v: unknown) => norm(v).replace(/(\w{3,})s\b/g, '$1');
  const cat = stem(job.category); const title = stem(job.title);
  return skills.some((s) => { const k = stem(s); return !!k && (cat === k || (k.length > 3 && (cat.includes(k) || title.includes(k)))); });
}

/**
 * Job alerts: hides declined/quoted jobs. By default only jobs matching the artisan's skills (primary + additional)
 * in their service areas; ?anywhere=true drops the area filter, ?category narrows to one category.
 * ?category&sort=newest|closest|budget&lat&lng&urgent&anywhere
 */
r.get('/alerts', requireRole('artisan'), async (req, res) => {
  const ap = await artisanApproved(req.user.id);
  const { from, to } = paginate(req.query);
  const q = z.object({ category: z.string().optional(), sort: z.enum(['newest', 'closest', 'budget']).default('newest'),
    lat: z.coerce.number().optional(), lng: z.coerce.number().optional(), urgent: boolish.optional(), anywhere: boolish.optional() }).parse(req.query);

  const [{ data: declined }, { data: quoted }] = await Promise.all([
    db.from('job_declines').select('job_id').eq('artisan_id', req.user.id),
    db.from('job_quotes').select('job_id').eq('artisan_id', req.user.id),
  ]);
  const skip = new Set([...(declined ?? []), ...(quoted ?? [])].map((x) => x.job_id));
  let query = db.from('jobs').select('*, properties(area, lat, lng), job_quotes(count)').eq('status', 'open');
  if (q.category) query = query.ilike('category', q.category);
  if (q.urgent) query = query.eq('urgency', 'urgent');
  const { data } = await query.order('created_at', { ascending: false }).limit(300);

  const skills: string[] = [ap.skill_category, ...(ap.additional_skills ?? [])].filter(Boolean);
  const areas: string[] = (ap.service_areas ?? []).filter(Boolean);
  // "Other" / "General Repair" artisans see every category; everyone else sees their skills.
  const broad = !skills.length || ['other', 'general repair'].includes(norm(ap.skill_category));
  const byArea = !q.anywhere && areas.length > 0;
  let jobs = (data ?? [])
    .filter((j: any) => !skip.has(j.id))
    .filter((j: any) => q.category || broad || skillMatches(j, skills))
    .filter((j: any) => !byArea || areaMatches(j.properties?.area, areas))
    .map((j: any) => ({
    ...j, quotesCount: j.job_quotes?.[0]?.count ?? 0,
    distanceKm: q.lat != null && q.lng != null && j.properties?.lat != null ? +haversineKm(q.lat, q.lng, j.properties.lat, j.properties.lng).toFixed(1) : null,
  }));
  if (q.sort === 'closest') jobs.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  if (q.sort === 'budget') jobs.sort((a, b) => Number(b.budget_max_kobo) - Number(a.budget_max_kobo));
  res.json({ jobs: jobs.slice(from, to + 1), total: jobs.length, filteredByArea: byArea, serviceAreas: areas });
});

r.get('/quotes/mine', requireRole('artisan'), async (req, res) => {
  const { data } = await db.from('job_quotes').select('*, jobs(id, title, status, budget_min_kobo, budget_max_kobo, properties(area))').eq('artisan_id', req.user.id).order('created_at', { ascending: false });
  res.json({ quotes: data });
});

r.get('/assigned', requireRole('artisan'), async (req, res) => {
  const { status } = z.object({ status: z.string().optional() }).parse(req.query);
  let q = db.from('jobs').select('*, properties(title, address, area)').eq('artisan_id', req.user.id).order('created_at', { ascending: false });
  if (status) q = q.in('status', status.split(','));
  res.json({ jobs: (await q).data });
});

/** Detail. Full address is only revealed to the owner and the assigned artisan. */
r.get('/:id', async (req, res) => {
  const job = await getJob(String(req.params.id));
  const privileged = [job.landlord_id, job.tenant_id, job.artisan_id].includes(req.user.id);
  if (!privileged && req.user.role !== 'artisan') throw forbidden();
  const [media, landlord, quotes, myQuote, report, posted] = await Promise.all([
    db.from('job_media').select('kind, url').eq('job_id', job.id),
    db.from('profiles').select('id, first_name, last_name, avatar_url, rating_avg, nin_verified').eq('id', job.landlord_id).single(),
    db.from('job_quotes').select('id', { count: 'exact', head: true }).eq('job_id', job.id),
    db.from('job_quotes').select('*').eq('job_id', job.id).eq('artisan_id', req.user.id).maybeSingle(),
    db.from('job_reports').select('*').eq('job_id', job.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('jobs').select('id', { count: 'exact', head: true }).eq('landlord_id', job.landlord_id),
  ]);
  const { properties, ...rest } = job;
  res.json({
    job: { ...rest, property: privileged ? properties : { area: properties.area, lat: properties.lat, lng: properties.lng, property_type: properties.property_type, bedrooms: properties.bedrooms },
           access_notes: privileged ? job.access_notes : null },
    media: media.data, landlord: landlord.data ? { ...landlord.data, jobsPosted: posted.count ?? 0 } : landlord.data, quotesCount: quotes.count ?? 0, myQuote: myQuote.data, report: privileged ? report.data : null,
  });
});

r.post('/:id/decline', requireRole('artisan'), async (req, res) => {
  await db.from('job_declines').upsert({ job_id: req.params.id, artisan_id: req.user.id });
  res.status(204).end();
});

r.post('/:id/quotes', requireRole('artisan'), requireVerified, async (req, res) => {
  await artisanApproved(req.user.id);
  const b = z.object({
    amountKobo: kobo, eta: z.enum(['same_day', '1_day', '2_3_days', '1_week']).optional(), notes: z.string().max(1000).optional(),
    breakdown: z.array(z.object({ item: z.string(), amountKobo: z.number().int().min(0) })).default([]),
  }).parse(req.body);
  const job = await getJob(String(req.params.id));
  if (job.status !== 'open') throw badRequest('Job is no longer open', 'BAD_STATE');
  if (b.amountKobo < job.budget_min_kobo || b.amountKobo > job.budget_max_kobo) throw badRequest('Your quote must be within the landlord’s budget range', 'OUT_OF_BUDGET');
  if (b.breakdown.length && b.breakdown.reduce((s, x) => s + x.amountKobo, 0) !== b.amountKobo) throw badRequest('Breakdown must add up to your quote', 'BAD_BREAKDOWN');
  const { data: dup } = await db.from('job_quotes').select('id').eq('job_id', job.id).eq('artisan_id', req.user.id).maybeSingle();
  if (dup) throw conflict('You already quoted this job');
  const quote = unwrap(await db.from('job_quotes').insert({ job_id: job.id, artisan_id: req.user.id, amount_kobo: b.amountKobo, breakdown: b.breakdown, eta: b.eta, notes: b.notes }).select().single());
  await notify(job.landlord_id, 'new_quote', 'New quote received', `${job.title}: ₦${(b.amountKobo / 100).toLocaleString()}`, { jobId: job.id, quoteId: quote.id });
  res.status(201).json({ quote });
});

/** Artisan arrives on site → diagnosing. */
r.post('/:id/start', requireRole('artisan'), async (req, res) => {
  const job = await getJob(String(req.params.id));
  mustBeAssigned(job, req.user.id);
  if (job.status !== 'assigned') throw badRequest('Job cannot be started', 'BAD_STATE');
  await db.from('jobs').update({ status: 'diagnosing', started_at: new Date().toISOString() }).eq('id', job.id);
  await logForJob(job, req.user.id, 'started', 'Artisan started work on site');
  await notify(job.landlord_id, 'job_started', 'Artisan has arrived', job.title, { jobId: job.id });
  res.json({ status: 'diagnosing' });
});

/** Inspection / diagnostic report. Landlord must approve before repairs. */
r.post('/:id/report', requireRole('artisan'), async (req, res) => {
  const b = z.object({
    diagnosis: z.string().min(5),
    materials: z.array(z.object({ item: z.string(), qty: z.number().int().positive(), costKobo: z.number().int().min(0) })).default([]),
    laborKobo: z.number().int().min(0), estimatedCompletion: z.coerce.date().optional(),
    beforeMediaUrls: z.array(z.string().url()).max(4).default([]),
  }).parse(req.body);
  const job = await getJob(String(req.params.id));
  mustBeAssigned(job, req.user.id);
  if (job.status !== 'diagnosing') throw badRequest('Start the job before submitting a report', 'BAD_STATE');
  const total = b.materials.reduce((s, m) => s + m.qty * m.costKobo, 0) + b.laborKobo;
  const { data: quote } = await db.from('job_quotes').select('amount_kobo').eq('id', job.accepted_quote_id).single();
  const report = unwrap(await db.from('job_reports').insert({
    job_id: job.id, artisan_id: req.user.id, diagnosis: b.diagnosis, materials: b.materials, labor_kobo: b.laborKobo, total_kobo: total,
    est_completion: b.estimatedCompletion?.toISOString(), exceeds_quote: total > Number(quote?.amount_kobo ?? 0) }).select().single());
  if (b.beforeMediaUrls.length) await db.from('job_media').insert(b.beforeMediaUrls.map((url) => ({ job_id: job.id, kind: 'before', url })));
  await db.from('jobs').update({ status: 'awaiting_approval' }).eq('id', job.id);
  await logForJob(job, req.user.id, 'estimate', `Artisan submitted repair estimate (₦${(total / 100).toLocaleString('en-NG')})`);
  await notify(job.landlord_id, 'report_submitted', 'Diagnosis report submitted', 'Review and approve to let the artisan proceed.', { jobId: job.id });
  res.status(201).json({ report });
});

r.post('/:id/begin-repair', requireRole('artisan'), async (req, res) => {
  const job = await getJob(String(req.params.id));
  mustBeAssigned(job, req.user.id);
  if (job.status !== 'approved') throw badRequest('Landlord approval required first', 'BAD_STATE');
  await db.from('jobs').update({ status: 'in_progress' }).eq('id', job.id);
  res.json({ status: 'in_progress' });
});

/** Artisan submits proof of completion; escrow releases after the tenant confirms. */
r.post('/:id/complete', requireRole('artisan'), async (req, res) => {
  const b = z.object({ afterMediaUrls: z.array(z.string().url()).min(1, 'At least one after photo is required').max(6), notes: z.string().max(1000).optional(), revisedAmountKobo: kobo.optional() }).parse(req.body);
  const job = await getJob(String(req.params.id));
  mustBeAssigned(job, req.user.id);
  if (job.status !== 'in_progress') throw badRequest('Job is not in progress', 'BAD_STATE');
  await db.from('job_media').insert(b.afterMediaUrls.map((url) => ({ job_id: job.id, kind: 'after', url })));
  const { data: quote } = await db.from('job_quotes').select('amount_kobo').eq('id', job.accepted_quote_id).single();
  const revised = b.revisedAmountKobo && b.revisedAmountKobo !== Number(quote?.amount_kobo) ? b.revisedAmountKobo : null;
  if (revised && revised > Number(job.budget_max_kobo)) throw badRequest('Revised amount exceeds the landlord’s maximum budget', 'OUT_OF_BUDGET');
  await db.from('jobs').update({ status: 'awaiting_confirmation', revised_amount_kobo: revised, revision_status: revised ? 'pending' : null, revision_note: b.notes ?? null }).eq('id', job.id);
  if (revised) await notify(job.landlord_id, 'revision_requested', 'Artisan requested a revised amount', `${job.title}: ₦${(revised / 100).toLocaleString()}`, { jobId: job.id });
  await logForJob(job, req.user.id, 'completed_by_artisan', 'Artisan marked the repair complete');
  for (const uid of [job.tenant_id, job.landlord_id].filter(Boolean))
    await notify(uid, 'job_complete', 'Repair finished — please confirm', job.title, { jobId: job.id });
  res.json({ status: 'awaiting_confirmation' });
});

export default r;
