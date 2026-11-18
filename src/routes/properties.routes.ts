import { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { kobo, paginate, uuid } from '../lib/common';
import { authenticate, optionalAuth, requireRole, requireVerified } from '../middleware/auth';
import { deleteFromBunny, signPrivateUrl } from '../lib/bunny';
import { env } from '../config/env';
import { responseTime } from '../services/responseTime';

import { ownerListingReport, queueIfPending, queueListingReview } from '../services/listingReview';

const r = Router();
const LISTER_ROLES = ['agent', 'landlord', 'estate_manager'] as const;
// '*' so new listing columns (land / commercial, migration 012) appear without breaking search before the migration runs.
const CARD = '*, property_media(url, media_type, position)';

const mediaItem = z.object({ url: z.string().url(), type: z.enum(['image', 'video']).default('image') });
const unitBody = z.object({
  id: uuid.optional(),
  label: z.string().trim().min(1).max(40),
  unitType: z.enum(['studio', '1_bed', '2_bed', '3_bed', '4_bed', 'other']).default('2_bed'),
  rentKobo: z.number().int().min(0),                     // monthly
  sizeSqm: z.number().positive().nullable().optional(),
  bathrooms: z.number().int().min(0).max(20).default(1),
});
type UnitInput = z.infer<typeof unitBody>;
const unitRow = (u: UnitInput) => ({ label: u.label, unit_type: u.unitType, rent_kobo: u.rentKobo, size_sqm: u.sizeSqm ?? null, bathrooms: u.bathrooms });
const DOC_TYPES = ['title', 'survey', 'agreement', 'other'] as const;
function assertUniqueLabels(units: UnitInput[]) {
  const seen = new Set<string>();
  for (const u of units) { const k = u.label.toLowerCase(); if (seen.has(k)) throw badRequest(`Unit "${u.label}" is listed twice`); seen.add(k); }
}
const propertyBody = z.object({
  title: z.string().min(3), description: z.string().optional(), address: z.string().min(5),
  area: z.string().optional(), city: z.string().default('Lagos'), state: z.string().default('Lagos'),
  lat: z.number().optional(), lng: z.number().optional(),
  priceKobo: kobo, pricePeriod: z.enum(['year', 'month', 'outright']).default('year'), // outright = sale price (land)
  propertyType: z.string().default('apartment'),
  bedrooms: z.number().int().min(0).default(0), bathrooms: z.number().int().min(0).default(0),
  sizeSqm: z.number().positive().optional(), parking: z.boolean().default(false),
  amenities: z.array(z.string()).default([]), inspectionFeeKobo: kobo.optional(),
  parkingSpaces: z.number().int().min(0).max(50).optional(), yearBuilt: z.number().int().min(1900).max(2100).optional(),
  landmark: z.string().trim().max(120).optional(), cautionFeeKobo: kobo.optional(), agencyFeeKobo: kobo.optional(),
  securityFeatures: z.array(z.string().max(40)).max(12).optional(),
  /** Land: title document and number of plots. Commercial: intended use. */
  titleDocument: z.string().trim().max(80).optional(), plotCount: z.number().positive().max(10000).optional(), commercialUse: z.string().trim().max(80).optional(),
  media: z.array(mediaItem).max(30).default([]),
  /** false = private/managed property (landlord tools only), never shown in search */
  publish: z.boolean().default(true),
  /** Landlord multi-unit setup (Figma "Add Property & Tenant Setup"). Omitted → one unit from bedrooms/price. */
  unitMode: z.enum(['single', 'same', 'mixed']).optional(),
  units: z.array(unitBody).max(500).optional(),
});

/**
 * A draft (publish: false, or editing an unlisted listing) can be saved with any part of the form filled in.
 * Everything is checked when it is submitted for review (POST /:id/submit, see draftProblems).
 */
const draftBody = propertyBody.extend({
  title: z.string().trim().max(200).default(''), address: z.string().trim().max(300).default(''),
  priceKobo: z.number().int().min(0).default(0),
});

/** What a draft still needs before it can be published. */
async function draftProblems(p: any) {
  const { count } = await db.from('property_media').select('id', { count: 'exact', head: true }).eq('property_id', p.id);
  return [
    String(p.title ?? '').trim().length >= 3 ? null : 'a title',
    String(p.address ?? '').trim().length >= 5 ? null : 'the street address',
    String(p.area ?? '').trim() ? null : 'the area',
    Number(p.price_kobo) > 0 ? null : 'the price',
    (count ?? 0) > 0 ? null : 'at least one photo',
  ].filter(Boolean) as string[];
}

const row = (b: z.infer<typeof propertyBody>) => ({
  title: b.title, description: b.description, address: b.address, area: b.area, city: b.city, state: b.state,
  lat: b.lat, lng: b.lng, price_kobo: b.priceKobo, price_period: b.pricePeriod, property_type: b.propertyType,
  bedrooms: b.bedrooms, bathrooms: b.bathrooms, size_sqm: b.sizeSqm, parking: b.parking, amenities: b.amenities,
  inspection_fee_kobo: b.inspectionFeeKobo,
  parking_spaces: b.parkingSpaces, year_built: b.yearBuilt, landmark: b.landmark,
  caution_fee_kobo: b.cautionFeeKobo, agency_fee_kobo: b.agencyFeeKobo, security_features: b.securityFeatures,
  title_document: b.titleDocument, plot_count: b.plotCount, commercial_use: b.commercialUse,
});

async function assertOwner(propertyId: string, userId: string) {
  const { data } = await db.from('properties').select('*').eq('id', propertyId).maybeSingle();
  if (!data) throw notFound('Property not found');
  if (data.owner_id !== userId) throw forbidden('Not your property');
  return data;
}

/** Agents need an active subscription and must be within their plan's listing limit. */
async function assertCanList(user: Profile) {
  if (user.role !== 'agent') return;
  const { data: sub } = await db.from('subscriptions').select('*, subscription_plans(listing_limit)')
    .eq('agent_id', user.id).eq('status', 'active').gt('expires_at', new Date().toISOString()).maybeSingle();
  if (!sub) throw forbidden('An active subscription is required to list properties', 'SUBSCRIPTION_REQUIRED');
  const limit = (sub as any).subscription_plans.listing_limit;
  if (limit != null) {
    const { count } = await db.from('properties').select('id', { count: 'exact', head: true })
      .eq('owner_id', user.id).in('status', ['pending', 'approved']);
    if ((count ?? 0) >= limit) throw forbidden(`Your plan allows ${limit} listings. Upgrade to add more.`, 'LISTING_LIMIT_REACHED');
  }
}

// ── Search & discovery (public) ──
r.get('/', async (req, res) => {
  const { from, to, page, limit } = paginate(req.query);
  const q = z.object({
    q: z.string().optional(), area: z.string().optional(), type: z.string().optional(),
    minPrice: z.coerce.number().optional(), maxPrice: z.coerce.number().optional(),
    beds: z.coerce.number().optional(), baths: z.coerce.number().optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
    /** Filter sheet (Figma 4474:7679): comma lists for types / amenities, plus toggles. */
    types: z.string().optional(), amenities: z.string().optional(), period: z.enum(['year', 'month']).optional(),
    verified: z.enum(['true', 'false']).optional(), parking: z.enum(['true', 'false']).optional(), minSize: z.coerce.number().positive().optional(),
  }).parse(req.query);
  // PostgREST filter syntax uses , ( ) . : * as operators — strip them from free text so input can't add conditions.
  const term = q.q?.replace(/[,()*:\%."]/g, ' ').trim().slice(0, 80);
  const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20) : []);

  // Hide listings whose agent subscription has lapsed.
  const { data: lapsed } = await db.from('subscriptions').select('agent_id').eq('status', 'expired');
  const { data: active } = await db.from('subscriptions').select('agent_id').eq('status', 'active').gt('expires_at', new Date().toISOString());
  const activeSet = new Set((active ?? []).map((s) => s.agent_id));
  const hidden = [...new Set((lapsed ?? []).map((s) => s.agent_id))].filter((id) => !activeSet.has(id));

  let query = db.from('properties').select(CARD, { count: 'exact' }).eq('status', 'approved');
  if (hidden.length) query = query.not('owner_id', 'in', `(${hidden.join(',')})`);
  if (term) query = query.or(`title.ilike.%${term}%,address.ilike.%${term}%,area.ilike.%${term}%`);
  if (q.area) query = query.ilike('area', `%${q.area}%`);
  if (q.type) query = query.eq('property_type', q.type);
  if (q.minPrice) query = query.gte('price_kobo', q.minPrice);
  if (q.maxPrice) query = query.lte('price_kobo', q.maxPrice);
  if (q.beds) query = query.gte('bedrooms', q.beds);
  if (q.baths) query = query.gte('bathrooms', q.baths);
  if (list(q.types).length) query = query.in('property_type', list(q.types));
  if (list(q.amenities).length) query = query.contains('amenities', list(q.amenities));
  if (q.period) query = query.eq('price_period', q.period);
  if (q.verified === 'true') query = query.eq('is_verified', true);
  if (q.parking === 'true') query = query.eq('parking', true);
  if (q.minSize) query = query.gte('size_sqm', q.minSize);
  query = q.sort === 'price_asc' ? query.order('price_kobo') : q.sort === 'price_desc' ? query.order('price_kobo', { ascending: false }) : query.order('created_at', { ascending: false });

  const { data, count, error } = await query.range(from, to);
  if (error) throw badRequest(error.message);
  // "Popular" tag on cards: 10+ views in the last 30 days.
  const ids = (data ?? []).map((p: any) => p.id);
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const views = ids.length ? (await db.from('property_views').select('property_id').in('property_id', ids).gte('created_at', since)).data ?? [] : [];
  const viewCount = new Map<string, number>();
  for (const v of views) viewCount.set(v.property_id, (viewCount.get(v.property_id) ?? 0) + 1);
  res.json({ properties: (data ?? []).map((p: any) => ({ ...p, popular: (viewCount.get(p.id) ?? 0) >= 10 })), page, limit, total: count ?? 0 });
});

// ── Static paths before /:id ──
/** Areas with live listings, most listings first — location chips in the filter sheet. */
r.get('/areas', async (_req, res) => {
  const { data } = await db.from('properties').select('area').eq('status', 'approved').not('area', 'is', null).limit(2000);
  const counts = new Map<string, number>();
  for (const p of data ?? []) { const a = String(p.area).trim(); if (a) counts.set(a, (counts.get(a) ?? 0) + 1); }
  res.json({ areas: [...counts].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([name, count]) => ({ name, count })) });
});

r.get('/mine', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const { data } = await db.from('properties').select(`${CARD}, unit_mode, created_at, units(id, status), bookings(id, status)`)
    .eq('owner_id', req.user.id).neq('status', 'archived').order('created_at', { ascending: false });
  const ids = (data ?? []).map((p: any) => p.id);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const { data: views } = ids.length ? await db.from('property_views').select('property_id').in('property_id', ids).gte('created_at', weekAgo) : { data: [] as any[] };
  const viewCount = new Map<string, number>();
  for (const v of views ?? []) viewCount.set(v.property_id, (viewCount.get(v.property_id) ?? 0) + 1);
  res.json({ properties: (data ?? []).map((p: any) => ({
    ...p, units: undefined, bookings: undefined,
    unitsTotal: (p.units ?? []).length, unitsOccupied: (p.units ?? []).filter((u: any) => u.status === 'occupied').length,
    bookingsCount: (p.bookings ?? []).filter((b: any) => !['expired', 'pending_payment'].includes(b.status)).length,
    viewsThisWeek: viewCount.get(p.id) ?? 0,
  })) });
});

// ── Saved ──
/**
 * Saved Properties (Figma 4510:13893). Each card carries when/at what price it was saved (price-drop alert),
 * whether it is still available, and which collections it belongs to.
 */
r.get('/saved', authenticate, async (req, res) => {
  const [saved, cols] = await Promise.all([
    db.from('saved_properties').select(`created_at, saved_price_kobo, properties(${CARD})`).eq('user_id', req.user.id).order('created_at', { ascending: false }),
    db.from('saved_collections').select('id, saved_collection_items(property_id)').eq('user_id', req.user.id),
  ]);
  if (saved.error) throw dbError(saved.error);
  const inCols = new Map<string, string[]>();
  for (const c of (cols.data ?? []) as any[]) for (const it of c.saved_collection_items ?? []) inCols.set(it.property_id, [...(inCols.get(it.property_id) ?? []), c.id]);
  res.json({
    properties: (saved.data ?? []).filter((d: any) => d.properties).map((d: any) => ({
      ...d.properties, savedAt: d.created_at, savedPriceKobo: d.saved_price_kobo ?? d.properties.price_kobo,
      available: d.properties.status === 'approved', collectionIds: inCols.get(d.properties.id) ?? [],
    })),
  });
});

r.get('/collections', authenticate, async (req, res) => {
  const { data, error } = await db.from('saved_collections')
    .select('id, name, created_at, saved_collection_items(property_id, properties(property_media(url, position)))')
    .eq('user_id', req.user.id).order('created_at');
  if (error) throw dbError(error);
  res.json({
    collections: (data ?? []).map((c: any) => ({
      id: c.id, name: c.name, count: (c.saved_collection_items ?? []).length,
      covers: (c.saved_collection_items ?? []).slice(0, 4).map((i: any) => [...(i.properties?.property_media ?? [])].sort((a: any, b: any) => a.position - b.position)[0]?.url).filter(Boolean),
    })),
  });
});

const collectionName = z.object({ name: z.string().trim().min(1, 'Give the collection a name').max(40) });
r.post('/collections', authenticate, async (req, res) => {
  const { name } = collectionName.parse(req.body);
  const { count } = await db.from('saved_collections').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
  if ((count ?? 0) >= 20) throw badRequest('You can have up to 20 collections', 'TOO_MANY_COLLECTIONS');
  const { data, error } = await db.from('saved_collections').insert({ user_id: req.user.id, name }).select('id, name').single();
  if (error?.code === '23505') throw badRequest('You already have a collection with that name', 'DUPLICATE_COLLECTION');
  if (error) throw dbError(error);
  res.status(201).json({ collection: { ...data, count: 0, covers: [] } });
});
r.patch('/collections/:cid', authenticate, async (req, res) => {
  const { name } = collectionName.parse(req.body);
  const { data, error } = await db.from('saved_collections').update({ name }).eq('id', uuid.parse(req.params.cid)).eq('user_id', req.user.id).select('id, name').maybeSingle();
  if (error?.code === '23505') throw badRequest('You already have a collection with that name', 'DUPLICATE_COLLECTION');
  if (error) throw dbError(error);
  if (!data) throw notFound('Collection not found');
  res.json({ collection: data });
});
r.delete('/collections/:cid', authenticate, async (req, res) => {
  await db.from('saved_collections').delete().eq('id', uuid.parse(req.params.cid)).eq('user_id', req.user.id);
  res.status(204).end();
});

/** Set which of the user's collections a saved property belongs to (saves it first if needed). */
r.put('/:id/collections', authenticate, async (req, res) => {
  const pid = uuid.parse(req.params.id);
  const { collectionIds } = z.object({ collectionIds: z.array(uuid).max(20) }).parse(req.body);
  const { data: mine } = await db.from('saved_collections').select('id').eq('user_id', req.user.id);
  const owned = new Set((mine ?? []).map((c) => c.id));
  if (collectionIds.some((c) => !owned.has(c))) throw forbidden('Unknown collection');
  const { data: prop } = await db.from('properties').select('price_kobo').eq('id', pid).maybeSingle();
  if (!prop) throw notFound('Property not found');
  await db.from('saved_properties').upsert({ user_id: req.user.id, property_id: pid, saved_price_kobo: prop.price_kobo }, { onConflict: 'user_id,property_id', ignoreDuplicates: true });
  if (owned.size) await db.from('saved_collection_items').delete().eq('property_id', pid).in('collection_id', [...owned]);
  if (collectionIds.length) await db.from('saved_collection_items').insert(collectionIds.map((collection_id) => ({ collection_id, property_id: pid })));
  res.json({ collectionIds });
});

r.post('/:id/save', authenticate, async (req, res) => {
  const pid = uuid.parse(req.params.id);
  const { data: prop } = await db.from('properties').select('price_kobo').eq('id', pid).maybeSingle();
  if (!prop) throw notFound('Property not found');
  await db.from('saved_properties').upsert({ user_id: req.user.id, property_id: pid, saved_price_kobo: prop.price_kobo }, { onConflict: 'user_id,property_id', ignoreDuplicates: true });
  res.status(204).end();
});
r.delete('/:id/save', authenticate, async (req, res) => {
  const pid = uuid.parse(req.params.id);
  await db.from('saved_properties').delete().eq('user_id', req.user.id).eq('property_id', pid);
  // Unsaving also removes it from every collection, as the "Remove from Saved?" sheet promises.
  const { data: mine } = await db.from('saved_collections').select('id').eq('user_id', req.user.id);
  if (mine?.length) await db.from('saved_collection_items').delete().eq('property_id', pid).in('collection_id', mine.map((c) => c.id));
  res.status(204).end();
});

r.post('/', authenticate, requireRole(...LISTER_ROLES), requireVerified, async (req, res) => {
  const b = (req.body?.publish === false ? draftBody : propertyBody).parse(req.body);
  if (b.publish) await assertCanList(req.user);
  if (b.units) assertUniqueLabels(b.units);
  const p = unwrap(await db.from('properties').insert({ ...row(b), owner_id: req.user.id, status: b.publish ? 'pending' : 'unlisted', unit_mode: b.unitMode ?? 'single' }).select().single());
  if (b.media.length)
    await db.from('property_media').insert(b.media.map((m, i) => ({ property_id: p.id, url: m.url, media_type: m.type, position: i })));
  const units: UnitInput[] = b.units?.length ? b.units : [{
    label: 'Main', unitType: (['studio', '1_bed', '2_bed', '3_bed'][b.bedrooms] ?? '4_bed') as UnitInput['unitType'],
    rentKobo: b.pricePeriod === 'year' ? Math.round(b.priceKobo / 12) : b.priceKobo, sizeSqm: b.sizeSqm ?? null, bathrooms: Math.max(1, b.bathrooms),
  }];
  const created = unwrap(await db.from('units').insert(units.map((u) => ({ ...unitRow(u), property_id: p.id }))).select());
  if (p.status === 'pending') queueListingReview(p.id); // checked in the background; the lister follows it on GET /:id/review
  res.status(201).json({ property: p, units: created, message: b.publish ? 'Submitted for approval' : 'Property saved' });
});

// ── Detail ──
r.get('/:id', optionalAuth, async (req, res) => {
  const { data: p } = await db.from('properties').select('*, property_media(id, url, media_type, position), nearby_places(*)').eq('id', req.params.id).maybeSingle();
  const isOwner = !!p && req.user?.id === p.owner_id;
  // Owners can open their own pending/paused/unlisted listings; everyone else only sees live ones.
  if (!p || (!isOwner && !['approved', 'rented'].includes(p.status))) throw notFound('Property not found');
  if (!isOwner) void db.from('property_views').insert({ property_id: p.id, viewer_id: req.user?.id ?? null }).then(() => undefined, () => undefined);

  const [owner, listings, stats, similar, rt] = await Promise.all([
    db.from('profiles').select('id, first_name, last_name, avatar_url, role, rating_avg, rating_count, nin_verified, created_at').eq('id', p.owner_id).single(),
    db.from('properties').select('id', { count: 'exact', head: true }).eq('owner_id', p.owner_id).eq('status', 'approved'),
    db.from('reviews').select('rating').eq('property_id', p.id).eq('hidden', false),
    db.from('properties').select(CARD).eq('status', 'approved').neq('id', p.id)
      .or(`area.eq."${String(p.area ?? '').replace(/"/g, '')}",property_type.eq."${String(p.property_type).replace(/"/g, '')}"`).limit(8),
    responseTime(p.owner_id).catch(() => null),
  ]);
  const ratings = (stats.data ?? []).map((x) => x.rating);
  res.json({
    // Effective inspection fee (listing override or the platform default) so the booking summary can show it up front.
    property: { ...p, inspection_fee_kobo: Number(p.inspection_fee_kobo ?? env.INSPECTION_FEE_KOBO), property_media: (p.property_media ?? []).sort((a: any, b: any) => a.position - b.position) },
    agent: { ...owner.data, listingsCount: listings.count ?? 0, responseTime: rt },
    reviewsSummary: { count: ratings.length, average: ratings.length ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0 },
    similar: similar.data,
  });
});

r.get('/:id/nearby', async (req, res) => {
  const { category } = z.object({ category: z.string().optional() }).parse(req.query);
  let q = db.from('nearby_places').select('*').eq('property_id', req.params.id).order('distance_km');
  if (category) q = q.eq('category', category);
  res.json({ places: (await q).data });
});

// ── Owner management ──
/** Owner view: units (+ current tenant), documents, listing performance and recent bookings. */
r.get('/:id/manage', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const p = await assertOwner(String(req.params.id), req.user.id);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const [units, docs, media, views, allViews, saves, bookings, reviews] = await Promise.all([
    db.from('units').select('*, tenancies(id, status, tenant_id, invite_name, terminates_on, tenant:profiles!tenancies_tenant_id_fkey(first_name, last_name))').eq('property_id', p.id).order('label'),
    db.from('property_documents').select('*').eq('property_id', p.id).order('created_at'),
    db.from('property_media').select('id, url, media_type, position').eq('property_id', p.id).order('position'),
    db.from('property_views').select('id', { count: 'exact', head: true }).eq('property_id', p.id).gte('created_at', weekAgo),
    db.from('property_views').select('id', { count: 'exact', head: true }).eq('property_id', p.id),
    db.from('saved_properties').select('user_id', { count: 'exact', head: true }).eq('property_id', p.id),
    db.from('bookings').select('id, status, scheduled_at, tenant:profiles!bookings_tenant_id_fkey(first_name, last_name, avatar_url)').eq('property_id', p.id).order('scheduled_at', { ascending: false }).limit(20),
    db.from('reviews').select('rating').eq('property_id', p.id).eq('hidden', false),
  ]);
  const b = (bookings.data ?? []).filter((x: any) => !['expired', 'pending_payment'].includes(x.status));
  const ratings = (reviews.data ?? []).map((x: any) => x.rating as number);
  res.json({
    property: { ...p, property_media: media.data ?? [] },
    units: (units.data ?? []).map((u: any) => {
      const cur = (u.tenancies ?? []).find((t: any) => t.status === 'active');
      return { ...u, tenancies: undefined, tenancy: cur ? { id: cur.id, name: cur.tenant ? `${cur.tenant.first_name ?? ''} ${cur.tenant.last_name ?? ''}`.trim() : cur.invite_name, invited: !cur.tenant_id, vacating: !!cur.terminates_on } : null };
    }),
    documents: (docs.data ?? []).map((d: any) => ({ ...d, url: signPrivateUrl(d.storage_path, 600) })),
    performance: {
      viewsThisWeek: views.count ?? 0, saves: saves.count ?? 0, bookings: b.length,
      conversionRate: allViews.count ? +((b.length / allViews.count) * 100).toFixed(1) : 0,
    },
    recentBookings: b.slice(0, 5),
    reviewsSummary: { count: ratings.length, average: ratings.length ? +(ratings.reduce((x, y) => x + y, 0) / ratings.length).toFixed(1) : 0 },
  });
});

/** Replace the unit configuration. Occupied units can be edited but not removed. */
r.put('/:id/units', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const p = await assertOwner(String(req.params.id), req.user.id);
  const { units, unitMode } = z.object({ units: z.array(unitBody).min(1).max(500), unitMode: z.enum(['single', 'same', 'mixed']).optional() }).parse(req.body);
  assertUniqueLabels(units);
  const { data: existing } = await db.from('units').select('id, status, label').eq('property_id', p.id);
  const keep = new Set(units.filter((u) => u.id).map((u) => u.id));
  const removing = (existing ?? []).filter((u) => !keep.has(u.id));
  const blocked = removing.filter((u) => u.status === 'occupied');
  if (blocked.length) throw badRequest(`Unit ${blocked.map((u) => u.label).join(', ')} has a tenant and can't be removed`, 'UNIT_OCCUPIED');
  if (removing.length) await db.from('units').delete().in('id', removing.map((u) => u.id));
  for (const u of units.filter((x) => x.id)) await db.from('units').update(unitRow(u)).eq('id', u.id!).eq('property_id', p.id);
  const fresh = units.filter((x) => !x.id);
  if (fresh.length) await db.from('units').insert(fresh.map((u) => ({ ...unitRow(u), property_id: p.id })));
  if (unitMode) await db.from('properties').update({ unit_mode: unitMode }).eq('id', p.id);
  res.json({ units: (await db.from('units').select('*').eq('property_id', p.id).order('label')).data });
});

/** Ownership documents (C of O, survey plan, tenancy agreement). Files are uploaded to the private zone first. */
/** The automatic review report for the listing's owner (checking / needs changes / waiting for a reviewer / rejected). */
r.get('/:id/review', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const p = await assertOwner(String(req.params.id), req.user.id);
  res.json({ report: await ownerListingReport(p) });
});

r.post('/:id/documents', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const p = await assertOwner(String(req.params.id), req.user.id);
  const b = z.object({ docType: z.enum(DOC_TYPES), path: z.string().min(3).max(300), originalName: z.string().max(200).optional(), sizeBytes: z.number().int().nonnegative().optional() }).parse(req.body);
  if (!b.path.startsWith(`property-docs/${req.user.id}/`)) throw badRequest('Upload the file to property-docs first', 'BAD_PATH');
  const doc = unwrap(await db.from('property_documents').insert({ property_id: p.id, doc_type: b.docType, storage_path: b.path, original_name: b.originalName, size_bytes: b.sizeBytes }).select().single());
  res.status(201).json({ document: { ...doc, url: signPrivateUrl(doc.storage_path, 600) } });
});

r.delete('/:id/documents/:docId', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  await assertOwner(String(req.params.id), req.user.id);
  const { data } = await db.from('property_documents').delete().eq('id', String(req.params.docId)).eq('property_id', String(req.params.id)).select().maybeSingle();
  if (data) await deleteFromBunny(data.storage_path, true);
  res.status(204).end();
});

/** Temporarily hide a live listing from search, and bring it back. */
r.post('/:id/pause', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const p = await assertOwner(String(req.params.id), req.user.id);
  if (p.status !== 'approved') throw badRequest('Only live listings can be paused', 'BAD_STATE');
  await db.from('properties').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', p.id);
  res.json({ status: 'paused' });
});
r.post('/:id/resume', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const p = await assertOwner(String(req.params.id), req.user.id);
  if (p.status !== 'paused') throw badRequest('This listing is not paused', 'BAD_STATE');
  await assertCanList(req.user);
  await db.from('properties').update({ status: 'approved', updated_at: new Date().toISOString() }).eq('id', p.id);
  res.json({ status: 'approved' });
});

r.patch('/:id', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const existing = await assertOwner(String(req.params.id), req.user.id);
  const b = (existing.status === 'unlisted' ? draftBody : propertyBody).partial().omit({ media: true, publish: true }).parse(req.body);
  const patch: Record<string, unknown> = Object.fromEntries(Object.entries(row(b as any)).filter(([, v]) => v !== undefined));
  patch.updated_at = new Date().toISOString();
  if (existing.status === 'rejected') { patch.status = 'pending'; patch.rejection_reason = null; } // edit & resubmit
  const saved = unwrap(await db.from('properties').update(patch).eq('id', existing.id).select().single());
  if (saved.status === 'pending') queueListingReview(saved.id);
  res.json({ property: saved });
});

r.post('/:id/submit', authenticate, requireRole(...LISTER_ROLES), requireVerified, async (req, res) => {
  const p = await assertOwner(String(req.params.id), req.user.id);
  if (p.status !== 'unlisted') throw badRequest('Only unlisted properties can be submitted');
  const missing = await draftProblems(p);
  if (missing.length) throw badRequest(`Finish your listing before publishing: add ${missing.length > 1 ? missing.slice(0, -1).join(', ') + ' and ' + missing.at(-1) : missing[0]}.`, 'DRAFT_INCOMPLETE');
  await assertCanList(req.user);
  await db.from('properties').update({ status: 'pending', updated_at: new Date().toISOString() }).eq('id', p.id);
  queueListingReview(p.id);
  res.json({ message: 'Submitted for approval' });
});

r.delete('/:id', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const p = await assertOwner(String(req.params.id), req.user.id);
  await db.from('properties').update({ status: 'archived' }).eq('id', p.id);
  res.status(204).end();
});

r.post('/:id/media', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const p = await assertOwner(String(req.params.id), req.user.id);
  const { media } = z.object({ media: z.array(mediaItem).min(1).max(30) }).parse(req.body);
  const { count } = await db.from('property_media').select('id', { count: 'exact', head: true }).eq('property_id', p.id);
  const rows = media.map((m, i) => ({ property_id: p.id, url: m.url, media_type: m.type, position: (count ?? 0) + i }));
  const saved = unwrap(await db.from('property_media').insert(rows).select());
  await db.from('properties').update({ updated_at: new Date().toISOString() }).eq('id', p.id); // photos changed: re-review if pending
  void queueIfPending(p.id);
  res.status(201).json({ media: saved });
});

r.delete('/:id/media/:mediaId', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  await assertOwner(String(req.params.id), req.user.id);
  const { data } = await db.from('property_media').delete().eq('id', req.params.mediaId).eq('property_id', req.params.id).select().maybeSingle();
  if (data) { await deleteFromBunny(data.url); await db.from('properties').update({ updated_at: new Date().toISOString() }).eq('id', req.params.id); void queueIfPending(String(req.params.id)); }
  res.status(204).end();
});

r.post('/:id/nearby', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  await assertOwner(String(req.params.id), req.user.id);
  const { places } = z.object({ places: z.array(z.object({
    category: z.enum(['education', 'healthcare', 'transport', 'markets', 'religious', 'security', 'utilities']),
    name: z.string(), distanceKm: z.number().positive(), rating: z.number().min(0).max(5).optional(),
  })).min(1) }).parse(req.body);
  const rows = places.map((p) => ({ property_id: req.params.id, category: p.category, name: p.name, distance_km: p.distanceKm, rating: p.rating }));
  res.status(201).json({ places: unwrap(await db.from('nearby_places').insert(rows).select()) });
});


export default r;
