import { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, notFound } from '../lib/errors';
import { uuid } from '../lib/common';
import { logger } from '../lib/logger';
import { authenticate } from '../middleware/auth';
import { applyFilters, describe, filtersSchema, matches, type Filters } from '../lib/propertyFilters';
import { notify } from '../services/notify';

/** Saved searches with new-listing alerts ("Tell me when a 2-bed under ₦2.5m appears in Yaba"). */
const r = Router();
r.use(authenticate);
const MAX = 20;

const cleanFilters = (raw: unknown): Filters => {
  const f = filtersSchema.parse(raw ?? {});
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as Filters;
};

r.get('/', async (req, res) => {
  const { data, error } = await db.from('saved_searches').select('*, hits:saved_search_hits(count)').eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) throw dbError(error);
  res.json({ searches: (data ?? []).map((s: any) => ({ ...s, summary: describe(s.filters), alertsSent: s.hits?.[0]?.count ?? 0, hits: undefined })) });
});

r.post('/', async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(80).optional(), filters: z.record(z.string(), z.any()), alerts: z.boolean().default(true) }).parse(req.body);
  const filters = cleanFilters(b.filters);
  const { count } = await db.from('saved_searches').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
  if ((count ?? 0) >= MAX) throw badRequest(`You can save up to ${MAX} searches. Delete one first.`, 'LIMIT');
  const search = unwrap(await db.from('saved_searches').insert({ user_id: req.user.id, name: b.name || describe(filters), filters, alerts: b.alerts }).select().single());
  // Homes that already match don't trigger an alert: only listings that appear from now on do.
  const { data: now } = await applyFilters(db.from('properties').select('id').eq('status', 'approved'), filters).limit(500);
  if (now?.length) await db.from('saved_search_hits').upsert(now.map((p: any) => ({ search_id: search.id, property_id: p.id })), { onConflict: 'search_id,property_id', ignoreDuplicates: true });
  res.status(201).json({ search: { ...search, summary: describe(filters) }, currentMatches: now?.length ?? 0 });
});

r.patch('/:id', async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(80).optional(), alerts: z.boolean().optional() }).parse(req.body);
  const { data, error } = await db.from('saved_searches').update(b).eq('id', uuid.parse(req.params.id)).eq('user_id', req.user.id).select().maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw notFound('Saved search not found');
  res.json({ search: { ...data, summary: describe(data.filters) } });
});

r.delete('/:id', async (req, res) => {
  await db.from('saved_searches').delete().eq('id', uuid.parse(req.params.id)).eq('user_id', req.user.id);
  res.status(204).end();
});

export default r;

/**
 * Scheduler job: listings approved recently are matched against every saved search with alerts on. Each match is
 * recorded once (saved_search_hits), so nobody is told twice. One notification per search per run.
 */
export async function runSavedSearchAlerts() {
  try {
    const since = new Date(Date.now() - 3 * 864e5).toISOString();
    const { data: fresh } = await db.from('properties').select('id, title, area, address, price_kobo, price_period, property_type, bedrooms, bathrooms, amenities, is_verified, parking, size_sqm, lat, lng, owner_id')
      .eq('status', 'approved').or(`created_at.gte.${since},updated_at.gte.${since}`).limit(500);
    if (!fresh?.length) return;
    const { data: searches } = await db.from('saved_searches').select('id, user_id, name, filters').eq('alerts', true).limit(5000);
    for (const s of searches ?? []) {
      const hits = fresh.filter((p: any) => p.owner_id !== s.user_id && matches(p, s.filters as Filters));
      if (!hits.length) continue;
      const { data: done } = await db.from('saved_search_hits').select('property_id').eq('search_id', s.id).in('property_id', hits.map((p: any) => p.id));
      const seen = new Set((done ?? []).map((d: any) => d.property_id));
      const fresh2 = hits.filter((p: any) => !seen.has(p.id));
      if (!fresh2.length) continue;
      await db.from('saved_search_hits').upsert(fresh2.map((p: any) => ({ search_id: s.id, property_id: p.id })), { onConflict: 'search_id,property_id', ignoreDuplicates: true });
      await db.from('saved_searches').update({ last_alert_at: new Date().toISOString() }).eq('id', s.id);
      const first = fresh2[0];
      const price = `₦${(Number(first.price_kobo) / 100).toLocaleString('en-NG')}${first.price_period === 'outright' ? '' : '/' + (first.price_period === 'year' ? 'yr' : 'mo')}`;
      if (fresh2.length === 1) await notify(s.user_id, 'saved_search', `New match: ${s.name}`, `${first.title} · ${first.area ?? ''} · ${price}`, { propertyId: first.id, searchId: s.id });
      else await notify(s.user_id, 'saved_search', `${fresh2.length} new homes match “${s.name}”`, `Including ${first.title} · ${price}`, { searchId: s.id });
    }
  } catch (err) { logger.error({ err }, 'saved-search alerts failed'); }
}
