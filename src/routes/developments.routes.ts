import { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { uuid } from '../lib/common';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { ensureConversation } from '../services/conversations';
import { notify } from '../services/notify';

/**
 * Developments (migration 028).
 *   /developments          browse published projects, watch them, send interest (any signed-in user; investors mostly)
 *   /developer             a developer's own projects, unit types, construction updates and leads
 *   /investor              an investor's dashboard and portfolio
 * No investment money moves through RentCreeb: interest opens a chat, the developer records reserved / purchased.
 */
const naira = (k: number | string | null | undefined) => `₦${(Number(k ?? 0) / 100).toLocaleString('en-NG')}`;
const who = (p: any) => (p ? [p.first_name, p.last_name].filter(Boolean).join(' ') || null : null);
const DEV_SELECT = 'id, first_name, last_name, avatar_url, agency_name, license_number, nin_verified, created_at';
const PROJECT_SELECT = `*, developer:profiles!dev_projects_developer_id_fkey(${DEV_SELECT}), units:dev_unit_types(*)`;
const ACTIVE = ['new', 'contacted', 'negotiating', 'reserved', 'purchased'];
const HELD = ['reserved', 'purchased']; // statuses that take units off the market

/** Price range and unit counts from the unit types. */
function summarise(p: any) {
  const units = [...(p.units ?? [])].sort((a: any, b: any) => a.position - b.position);
  const prices = units.map((u: any) => Number(u.price_kobo));
  return {
    ...p, units,
    minPriceKobo: prices.length ? Math.min(...prices) : null, maxPriceKobo: prices.length ? Math.max(...prices) : null,
    totalUnits: units.reduce((s: number, u: any) => s + Number(u.total_units), 0),
    availableUnits: units.reduce((s: number, u: any) => s + Number(u.available_units), 0),
    cover: p.images?.[0] ?? null,
    developer: p.developer ? { ...p.developer, name: p.developer.agency_name || who(p.developer) } : null,
  };
}

// ══════════ /developments: public catalogue ══════════
export const developmentsRouter = Router();
developmentsRouter.use(authenticate);

developmentsRouter.get('/', async (req, res) => {
  const f = z.object({ q: z.string().optional(), city: z.string().optional(), status: z.enum(['off_plan', 'under_construction', 'completed', 'sold_out']).optional(),
    kind: z.enum(['residential', 'commercial', 'mixed_use', 'land']).optional(), maxPriceKobo: z.coerce.number().int().positive().optional(),
    sort: z.enum(['newest', 'roi', 'price', 'completion']).default('newest'), developerId: uuid.optional(), limit: z.coerce.number().int().min(1).max(50).default(30) }).parse(req.query);
  let q = db.from('dev_projects').select(PROJECT_SELECT).eq('published', true).limit(100);
  if (f.city) q = q.ilike('city', f.city);
  if (f.status) q = q.eq('status', f.status);
  if (f.kind) q = q.eq('kind', f.kind);
  if (f.developerId) q = q.eq('developer_id', f.developerId);
  if (f.q?.trim()) { const t = `%${f.q.trim().replace(/[%_,()]/g, ' ')}%`; q = q.or(`name.ilike.${t},area.ilike.${t},city.ilike.${t},tagline.ilike.${t}`); }
  q = f.sort === 'roi' ? q.order('expected_roi_pct', { ascending: false, nullsFirst: false }) : f.sort === 'completion' ? q.order('completion_date', { ascending: true, nullsFirst: false }) : q.order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) throw dbError(error);
  let list = (data ?? []).map(summarise);
  if (f.maxPriceKobo) list = list.filter((p) => p.minPriceKobo != null && p.minPriceKobo <= f.maxPriceKobo!);
  if (f.sort === 'price') list.sort((a, b) => (a.minPriceKobo ?? Infinity) - (b.minPriceKobo ?? Infinity));
  const { data: w } = await db.from('dev_watchlist').select('project_id').eq('user_id', req.user.id);
  const watched = new Set((w ?? []).map((x) => x.project_id));
  const { data: cities } = await db.from('dev_projects').select('city').eq('published', true).limit(500);
  res.json({ projects: list.slice(0, f.limit).map((p) => ({ ...p, watched: watched.has(p.id) })), cities: [...new Set((cities ?? []).map((c) => c.city))].sort() });
});

developmentsRouter.get('/watchlist', async (req, res) => {
  const { data, error } = await db.from('dev_watchlist').select(`created_at, project:dev_projects(${PROJECT_SELECT})`).eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) throw dbError(error);
  res.json({ projects: (data ?? []).filter((x: any) => x.project?.published).map((x: any) => ({ ...summarise(x.project), watched: true })) });
});

/** My interests (investor side), newest first. */
developmentsRouter.get('/interests', async (req, res) => {
  const { data, error } = await db.from('dev_leads').select(`*, unit:dev_unit_types(id, name, price_kobo), project:dev_projects(${PROJECT_SELECT})`).eq('investor_id', req.user.id).order('created_at', { ascending: false });
  if (error) throw dbError(error);
  res.json({ interests: (data ?? []).map(({ developer_note, ...l }: any) => ({ ...l, project: l.project ? summarise(l.project) : null })) });
});

developmentsRouter.post('/interests/:id/withdraw', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { data: l } = await db.from('dev_leads').select('*, project:dev_projects(name)').eq('id', id).eq('investor_id', req.user.id).maybeSingle();
  if (!l) throw notFound('Interest not found');
  if (['purchased', 'withdrawn', 'declined'].includes(l.status)) throw badRequest(`This interest is already ${l.status}`);
  await releaseUnits(l);
  await db.from('dev_leads').update({ status: 'withdrawn', updated_at: new Date().toISOString() }).eq('id', id);
  await notify(l.developer_id, 'dev_lead', 'Interest withdrawn', `${who(req.user) ?? 'An investor'} withdrew their interest in ${(l as any).project?.name}.`, { leadId: id });
  res.json({ status: 'withdrawn' });
});

developmentsRouter.get('/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { data: p } = await db.from('dev_projects').select(PROJECT_SELECT).eq('id', id).maybeSingle();
  if (!p || (!p.published && p.developer_id !== req.user.id)) throw notFound('Project not found');
  const [{ data: updates }, { data: w }, { data: mine }, { count: interested }, { count: otherProjects }] = await Promise.all([
    db.from('dev_project_updates').select('*').eq('project_id', id).order('created_at', { ascending: false }).limit(30),
    db.from('dev_watchlist').select('project_id').eq('project_id', id).eq('user_id', req.user.id).maybeSingle(),
    db.from('dev_leads').select('id, status, kind, units, unit_type_id, conversation_id, created_at').eq('project_id', id).eq('investor_id', req.user.id).in('status', ACTIVE).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('dev_leads').select('id', { count: 'exact', head: true }).eq('project_id', id).in('status', ACTIVE),
    db.from('dev_projects').select('id', { count: 'exact', head: true }).eq('developer_id', p.developer_id).eq('published', true),
  ]);
  res.json({ project: { ...summarise(p), watched: !!w, interestedCount: interested ?? 0, developerProjects: otherProjects ?? 0 }, updates: updates ?? [], myInterest: mine ?? null });
});

developmentsRouter.post('/:id/watch', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  if (on) await db.from('dev_watchlist').upsert({ user_id: req.user.id, project_id: id }, { onConflict: 'user_id,project_id', ignoreDuplicates: true });
  else await db.from('dev_watchlist').delete().eq('user_id', req.user.id).eq('project_id', id);
  res.json({ watched: on });
});

/** Send interest: opens (or reuses) a chat with the developer and drops the request in as the first message. */
developmentsRouter.post('/:id/interest', requireVerified, async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ kind: z.enum(['enquiry', 'reservation', 'inspection']).default('enquiry'), unitTypeId: uuid.nullable().optional(), units: z.number().int().min(1).max(100).default(1),
    budgetKobo: z.number().int().positive().nullable().optional(), message: z.string().trim().max(1000).optional() }).parse(req.body);
  const { data: p } = await db.from('dev_projects').select('id, name, developer_id, published, status, units:dev_unit_types(id, name, available_units, price_kobo)').eq('id', id).maybeSingle();
  if (!p || !p.published) throw notFound('Project not found');
  if (p.developer_id === req.user.id) throw badRequest("You can't send interest in your own project");
  const unit = b.unitTypeId ? (p.units ?? []).find((u: any) => u.id === b.unitTypeId) : null;
  if (b.unitTypeId && !unit) throw badRequest('That unit type is not part of this project');
  if (b.kind === 'reservation' && unit && Number(unit.available_units) < b.units) throw badRequest(`Only ${unit.available_units} of these units are left`);
  const { data: open } = await db.from('dev_leads').select('id').eq('project_id', id).eq('investor_id', req.user.id).in('status', ['new', 'contacted', 'negotiating']).maybeSingle();
  if (open) throw badRequest('You already have an open request for this project. Continue in the chat.', 'LEAD_EXISTS');

  const convo = await ensureConversation('project', id, req.user.id, p.developer_id);
  const lead = unwrap(await db.from('dev_leads').insert({ project_id: id, developer_id: p.developer_id, investor_id: req.user.id, unit_type_id: unit?.id ?? null, kind: b.kind, units: b.units,
    budget_kobo: b.budgetKobo ?? null, message: b.message ?? null, conversation_id: convo?.id ?? null }).select().single());
  const what = b.kind === 'reservation' ? 'Reservation request' : b.kind === 'inspection' ? 'Site inspection request' : 'Enquiry';
  const line = [`${what} for ${p.name}`, unit ? `${b.units} × ${unit.name} (${naira(unit.price_kobo)} each)` : null, b.budgetKobo ? `Budget: ${naira(b.budgetKobo)}` : null, b.message].filter(Boolean).join('\n');
  if (convo) await db.from('messages').insert({ conversation_id: convo.id, sender_id: req.user.id, body: line });
  await notify(p.developer_id, 'dev_lead', `New ${what.toLowerCase()}`, `${who(req.user) ?? 'An investor'}: ${p.name}${unit ? ` · ${unit.name}` : ''}`, { leadId: lead.id, conversationId: convo?.id });
  res.status(201).json({ interest: lead, conversationId: convo?.id ?? null });
});

// ══════════ /developer: the developer's workspace ══════════
export const developerRouter = Router();
developerRouter.use(authenticate, requireRole('developer'));

const projectSchema = z.object({
  name: z.string().trim().min(3).max(120), tagline: z.string().trim().max(160).nullable().optional(), description: z.string().trim().max(5000).nullable().optional(),
  kind: z.enum(['residential', 'commercial', 'mixed_use', 'land']).default('residential'), status: z.enum(['off_plan', 'under_construction', 'completed', 'sold_out']).default('off_plan'),
  city: z.string().trim().min(2).max(60), area: z.string().trim().max(80).nullable().optional(), address: z.string().trim().max(200).nullable().optional(),
  progressPct: z.number().int().min(0).max(100).default(0), launchDate: z.string().date().nullable().optional(), completionDate: z.string().date().nullable().optional(),
  titleDocument: z.string().trim().max(80).nullable().optional(), paymentPlan: z.string().trim().max(1000).nullable().optional(),
  minInvestmentKobo: z.number().int().positive().nullable().optional(), expectedRoiPct: z.number().min(0).max(500).nullable().optional(), rentalYieldPct: z.number().min(0).max(100).nullable().optional(),
  amenities: z.array(z.string().trim().min(1).max(40)).max(30).default([]), images: z.array(z.string().url()).max(15).default([]), brochureUrl: z.string().url().nullable().optional(),
  units: z.array(z.object({ id: uuid.optional(), name: z.string().trim().min(1).max(80), bedrooms: z.number().int().min(0).max(20).nullable().optional(), sizeSqm: z.number().positive().max(100000).nullable().optional(),
    priceKobo: z.number().int().positive(), totalUnits: z.number().int().min(0).max(10000), availableUnits: z.number().int().min(0).max(10000) })).max(30).default([]),
});
const toRow = (b: Partial<z.infer<typeof projectSchema>>) => {
  const map: Record<string, string> = { name: 'name', tagline: 'tagline', description: 'description', kind: 'kind', status: 'status', city: 'city', area: 'area', address: 'address', progressPct: 'progress_pct',
    launchDate: 'launch_date', completionDate: 'completion_date', titleDocument: 'title_document', paymentPlan: 'payment_plan', minInvestmentKobo: 'min_investment_kobo',
    expectedRoiPct: 'expected_roi_pct', rentalYieldPct: 'rental_yield_pct', amenities: 'amenities', images: 'images', brochureUrl: 'brochure_url' };
  return Object.fromEntries(Object.entries(b).filter(([k, v]) => map[k] && v !== undefined).map(([k, v]) => [map[k], v]));
};
async function ownProject(id: string, devId: string) {
  const { data } = await db.from('dev_projects').select(PROJECT_SELECT).eq('id', id).maybeSingle();
  if (!data || data.developer_id !== devId) throw notFound('Project not found');
  return data;
}
/** Replace a project's unit types: update by id, add new, remove the rest (leads keep their record; unit_type_id goes null). */
async function saveUnits(projectId: string, units: z.infer<typeof projectSchema>['units']) {
  for (const u of units) if (u.availableUnits > u.totalUnits) throw badRequest(`${u.name}: available can't be more than total`);
  const { data: cur } = await db.from('dev_unit_types').select('id').eq('project_id', projectId);
  const keep = new Set(units.map((u) => u.id).filter(Boolean));
  const drop = (cur ?? []).map((c) => c.id).filter((id) => !keep.has(id));
  if (drop.length) await db.from('dev_unit_types').delete().in('id', drop);
  for (const [i, u] of units.entries()) {
    const row = { project_id: projectId, name: u.name, bedrooms: u.bedrooms ?? null, size_sqm: u.sizeSqm ?? null, price_kobo: u.priceKobo, total_units: u.totalUnits, available_units: u.availableUnits, position: i };
    const { error } = u.id && (cur ?? []).some((c) => c.id === u.id) ? await db.from('dev_unit_types').update(row).eq('id', u.id) : await db.from('dev_unit_types').insert(row);
    if (error) throw dbError(error);
  }
}

developerRouter.get('/dashboard', async (req, res) => {
  const [{ data: projects }, { data: leads }] = await Promise.all([
    db.from('dev_projects').select(PROJECT_SELECT).eq('developer_id', req.user.id).order('created_at', { ascending: false }),
    db.from('dev_leads').select('id, status, kind, units, agreed_kobo, budget_kobo, created_at, project_id, unit:dev_unit_types(name, price_kobo), investor:profiles!dev_leads_investor_id_fkey(id, first_name, last_name, avatar_url), project:dev_projects(name)')
      .eq('developer_id', req.user.id).order('created_at', { ascending: false }).limit(500),
  ]);
  const ps = (projects ?? []).map(summarise);
  const ls = leads ?? [];
  const sold = ls.filter((l: any) => l.status === 'purchased');
  const byStatus = Object.fromEntries(['new', 'contacted', 'negotiating', 'reserved', 'purchased', 'declined', 'withdrawn'].map((s) => [s, ls.filter((l: any) => l.status === s).length]));
  const since = Date.now() - 30 * 864e5;
  res.json({
    stats: {
      projects: ps.length, published: ps.filter((p) => p.published).length, totalUnits: ps.reduce((s, p) => s + p.totalUnits, 0), availableUnits: ps.reduce((s, p) => s + p.availableUnits, 0),
      leads: ls.length, newLeads: byStatus.new, leads30: ls.filter((l: any) => Date.parse(l.created_at) > since).length,
      salesKobo: sold.reduce((s: number, l: any) => s + Number(l.agreed_kobo ?? Number(l.unit?.price_kobo ?? 0) * l.units), 0),
      reservedKobo: ls.filter((l: any) => l.status === 'reserved').reduce((s: number, l: any) => s + Number(l.agreed_kobo ?? Number(l.unit?.price_kobo ?? 0) * l.units), 0),
      conversionPct: ls.length ? Math.round((sold.length / ls.length) * 100) : 0,
    },
    byStatus, projects: ps.slice(0, 5), recentLeads: ls.slice(0, 6),
  });
});

developerRouter.get('/projects', async (req, res) => {
  const { data, error } = await db.from('dev_projects').select(PROJECT_SELECT).eq('developer_id', req.user.id).order('created_at', { ascending: false });
  if (error) throw dbError(error);
  const { data: counts } = await db.from('dev_leads').select('project_id, status').eq('developer_id', req.user.id);
  res.json({ projects: (data ?? []).map((p) => ({ ...summarise(p), leadCount: (counts ?? []).filter((c) => c.project_id === p.id && ACTIVE.includes(c.status)).length })) });
});

developerRouter.post('/projects', async (req, res) => {
  const b = projectSchema.parse(req.body);
  const p = unwrap(await db.from('dev_projects').insert({ ...toRow(b), developer_id: req.user.id }).select('id').single());
  await saveUnits(p.id, b.units);
  res.status(201).json({ project: summarise(await ownProject(p.id, req.user.id)) });
});

developerRouter.patch('/projects/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  await ownProject(id, req.user.id);
  const b = projectSchema.partial().parse(req.body);
  await db.from('dev_projects').update({ ...toRow(b), updated_at: new Date().toISOString() }).eq('id', id);
  if (b.units) await saveUnits(id, b.units);
  res.json({ project: summarise(await ownProject(id, req.user.id)) });
});

/** Go live / take down. Publishing needs a verified identity, at least one photo and one unit type. */
developerRouter.post('/projects/:id/publish', requireVerified, async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { on } = z.object({ on: z.boolean() }).parse(req.body);
  const p = await ownProject(id, req.user.id);
  if (on && !(p.images ?? []).length) throw badRequest('Add at least one photo before publishing');
  if (on && !(p.units ?? []).length) throw badRequest('Add at least one unit type with a price before publishing');
  await db.from('dev_projects').update({ published: on, updated_at: new Date().toISOString() }).eq('id', id);
  res.json({ published: on });
});

developerRouter.delete('/projects/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  await ownProject(id, req.user.id);
  const { count } = await db.from('dev_leads').select('id', { count: 'exact', head: true }).eq('project_id', id).in('status', ['reserved', 'purchased']);
  if (count) throw forbidden('This project has reservations or sales. Mark it sold out or unpublish it instead.', 'HAS_SALES');
  await db.from('dev_projects').delete().eq('id', id);
  res.status(204).end();
});

/** Construction update: shown on the project page and sent to everyone watching or interested. */
developerRouter.post('/projects/:id/updates', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const p = await ownProject(id, req.user.id);
  const b = z.object({ title: z.string().trim().min(3).max(120), body: z.string().trim().max(3000).optional(), progressPct: z.number().int().min(0).max(100).optional(), images: z.array(z.string().url()).max(10).default([]) }).parse(req.body);
  const u = unwrap(await db.from('dev_project_updates').insert({ project_id: id, title: b.title, body: b.body ?? null, progress_pct: b.progressPct ?? null, images: b.images }).select().single());
  if (b.progressPct != null) await db.from('dev_projects').update({ progress_pct: b.progressPct, updated_at: new Date().toISOString() }).eq('id', id);
  if (p.published) {
    const [{ data: w }, { data: l }] = await Promise.all([db.from('dev_watchlist').select('user_id').eq('project_id', id), db.from('dev_leads').select('investor_id').eq('project_id', id).in('status', ACTIVE)]);
    const people = [...new Set([...(w ?? []).map((x) => x.user_id), ...(l ?? []).map((x) => x.investor_id)])];
    for (const uid of people) await notify(uid, 'dev_update', `${p.name}: ${b.title}`, b.progressPct != null ? `Construction is now ${b.progressPct}% complete.` : (b.body ?? '').slice(0, 140), { projectId: id });
  }
  res.status(201).json({ update: u });
});

developerRouter.delete('/updates/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { data: u } = await db.from('dev_project_updates').select('id, project:dev_projects(developer_id)').eq('id', id).maybeSingle();
  if (!u || (u as any).project?.developer_id !== req.user.id) throw notFound('Update not found');
  await db.from('dev_project_updates').delete().eq('id', id);
  res.status(204).end();
});

developerRouter.get('/leads', async (req, res) => {
  const f = z.object({ status: z.string().optional(), projectId: uuid.optional() }).parse(req.query);
  let q = db.from('dev_leads').select('*, unit:dev_unit_types(id, name, price_kobo, available_units), project:dev_projects(id, name, city, area, images), investor:profiles!dev_leads_investor_id_fkey(id, first_name, last_name, avatar_url, phone, email, nin_verified, created_at)')
    .eq('developer_id', req.user.id).order('created_at', { ascending: false }).limit(200);
  if (f.status === 'open') q = q.in('status', ['new', 'contacted', 'negotiating']);
  else if (f.status) q = q.eq('status', f.status);
  if (f.projectId) q = q.eq('project_id', f.projectId);
  const { data, error } = await q;
  if (error) throw dbError(error);
  res.json({ leads: data ?? [] });
});

/** Put units back on the market when a reserved / purchased lead falls through. */
async function releaseUnits(l: any) {
  if (!HELD.includes(l.status) || !l.unit_type_id) return;
  const { data: u } = await db.from('dev_unit_types').select('available_units, total_units').eq('id', l.unit_type_id).maybeSingle();
  if (u) await db.from('dev_unit_types').update({ available_units: Math.min(Number(u.total_units), Number(u.available_units) + l.units) }).eq('id', l.unit_type_id);
}

/** Move a lead along. Reserved / purchased take units off the market; leaving those statuses puts them back. */
developerRouter.patch('/leads/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z.object({ status: z.enum(['new', 'contacted', 'negotiating', 'reserved', 'purchased', 'declined']).optional(), agreedKobo: z.number().int().positive().nullable().optional(), note: z.string().trim().max(2000).nullable().optional() }).parse(req.body);
  const { data: l } = await db.from('dev_leads').select('*, project:dev_projects(name), unit:dev_unit_types(name, available_units)').eq('id', id).eq('developer_id', req.user.id).maybeSingle();
  if (!l) throw notFound('Lead not found');
  if (l.status === 'withdrawn') throw badRequest('The investor withdrew this request');
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.agreedKobo !== undefined) patch.agreed_kobo = b.agreedKobo;
  if (b.note !== undefined) patch.developer_note = b.note;
  if (b.status && b.status !== l.status) {
    const nowHeld = HELD.includes(b.status), wasHeld = HELD.includes(l.status);
    if (nowHeld && !wasHeld && l.unit_type_id) {
      const left = Number((l as any).unit?.available_units ?? 0);
      if (left < l.units) throw badRequest(`Only ${left} ${(l as any).unit?.name ?? 'units'} left`);
      await db.from('dev_unit_types').update({ available_units: left - l.units }).eq('id', l.unit_type_id);
    }
    if (wasHeld && !nowHeld) await releaseUnits(l);
    patch.status = b.status;
    const msg: Record<string, string> = { contacted: 'The developer has picked up your request.', negotiating: 'The developer is discussing terms with you.', reserved: 'Your unit is reserved 🎉', purchased: 'Purchase confirmed. Congratulations on your new property! 🏡', declined: 'The developer could not take your request this time.' };
    if (msg[b.status]) await notify(l.investor_id, 'dev_lead', `${(l as any).project?.name}`, msg[b.status], { leadId: id, conversationId: l.conversation_id });
  }
  const out = unwrap(await db.from('dev_leads').update(patch).eq('id', id).select().single());
  res.json({ lead: out });
});

// ══════════ /investor: dashboard & portfolio ══════════
export const investorRouter = Router();
investorRouter.use(authenticate);

investorRouter.get('/dashboard', async (req, res) => {
  const [{ data: leads }, { count: watching }, { data: latest }] = await Promise.all([
    db.from('dev_leads').select('id, status, units, agreed_kobo, unit:dev_unit_types(price_kobo), project:dev_projects(id, name, expected_roi_pct, rental_yield_pct, progress_pct, status, images, city, area, completion_date)').eq('investor_id', req.user.id),
    db.from('dev_watchlist').select('project_id', { count: 'exact', head: true }).eq('user_id', req.user.id),
    db.from('dev_projects').select(PROJECT_SELECT).eq('published', true).order('created_at', { ascending: false }).limit(40),
  ]);
  const ls = (leads ?? []) as any[];
  const value = (l: any) => Number(l.agreed_kobo ?? Number(l.unit?.price_kobo ?? 0) * l.units);
  const owned = ls.filter((l) => l.status === 'purchased'); const reserved = ls.filter((l) => l.status === 'reserved');
  const investedKobo = owned.reduce((s, l) => s + value(l), 0);
  // Developer projections, not guarantees: shown with that caveat in the app.
  const projectedGainKobo = owned.reduce((s, l) => s + Math.round(value(l) * Number(l.project?.expected_roi_pct ?? 0) / 100), 0);
  const projectedRentKobo = owned.reduce((s, l) => s + Math.round(value(l) * Number(l.project?.rental_yield_pct ?? 0) / 100), 0);
  // Recommendations: their preferred cities and budget first, then best projected return.
  const prefs = (req.user as any).investment_prefs ?? {};
  const cities: string[] = (prefs.cities ?? []).map((c: string) => c.toLowerCase());
  const mine = new Set(ls.map((l) => l.project?.id));
  const recs = (latest ?? []).map(summarise).filter((p) => !mine.has(p.id) && p.developer_id !== req.user.id)
    .map((p) => ({ p, score: (cities.includes(String(p.city).toLowerCase()) ? 2 : 0) + (prefs.budgetMaxKobo && p.minPriceKobo != null && p.minPriceKobo <= prefs.budgetMaxKobo ? 1 : 0) + Number(p.expected_roi_pct ?? 0) / 100 }))
    .sort((a, b) => b.score - a.score).slice(0, 6).map((x) => x.p);
  res.json({
    stats: { investedKobo, reservedKobo: reserved.reduce((s, l) => s + value(l), 0), properties: owned.reduce((s, l) => s + l.units, 0), openRequests: ls.filter((l) => ['new', 'contacted', 'negotiating'].includes(l.status)).length,
      watching: watching ?? 0, projectedGainKobo, projectedRentKobo },
    holdings: [...owned, ...reserved].map((l) => ({ id: l.id, status: l.status, units: l.units, valueKobo: value(l), project: l.project })),
    recommended: recs, prefs,
  });
});

export default developmentsRouter;
