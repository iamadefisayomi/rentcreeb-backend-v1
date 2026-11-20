import { z } from 'zod';

/**
 * Property search filters shared by search, map search and saved-search alerts, so an alert matches exactly what
 * the person would see if they ran the search themselves. Prices are in kobo.
 */
export const filtersSchema = z.object({
  q: z.string().trim().max(80).optional(), area: z.string().trim().max(80).optional(), type: z.string().max(40).optional(),
  minPrice: z.coerce.number().min(0).optional(), maxPrice: z.coerce.number().min(0).optional(),
  beds: z.coerce.number().min(0).max(20).optional(), baths: z.coerce.number().min(0).max(20).optional(),
  types: z.union([z.string(), z.array(z.string())]).optional(), amenities: z.union([z.string(), z.array(z.string())]).optional(),
  period: z.enum(['year', 'month', 'outright']).optional(),
  verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(), parking: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  minSize: z.coerce.number().positive().optional(),
  /** Map area: a drawn polygon ("lat,lng;lat,lng;…") or the visible box. */
  poly: z.string().max(4000).optional(),
  minLat: z.coerce.number().optional(), maxLat: z.coerce.number().optional(), minLng: z.coerce.number().optional(), maxLng: z.coerce.number().optional(),
});
export type Filters = z.infer<typeof filtersSchema>;

export const listOf = (v?: string | string[]) => (Array.isArray(v) ? v : v ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
const yes = (v: unknown) => v === true || v === 'true';

export function parsePolygon(poly?: string): [number, number][] | null {
  if (!poly) return null;
  const pts = poly.split(';').map((p) => p.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][];
  return pts.length >= 3 ? pts.slice(0, 200) : null;
}
/** Ray casting; points are [lat, lng]. */
export function inPolygon(lat: number, lng: number, pts: [number, number][]) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i]; const [yj, xj] = pts[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
export function boundsOf(f: Filters) {
  const poly = parsePolygon(f.poly);
  if (poly) {
    const lats = poly.map((p) => p[0]); const lngs = poly.map((p) => p[1]);
    return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs), poly };
  }
  if ([f.minLat, f.maxLat, f.minLng, f.maxLng].every((v) => typeof v === 'number' && Number.isFinite(v))) return { minLat: f.minLat!, maxLat: f.maxLat!, minLng: f.minLng!, maxLng: f.maxLng!, poly: null };
  return null;
}

/** Same filters applied to a PostgREST query on `properties`. */
export function applyFilters(query: any, f: Filters) {
  const term = f.q?.replace(/[,()*:\\%."]/g, ' ').trim().slice(0, 80);
  if (term) query = query.or(`title.ilike.%${term}%,address.ilike.%${term}%,area.ilike.%${term}%`);
  if (f.area) query = query.ilike('area', `%${f.area.replace(/[%_]/g, ' ')}%`);
  if (f.type) query = query.eq('property_type', f.type);
  if (f.minPrice) query = query.gte('price_kobo', f.minPrice);
  if (f.maxPrice) query = query.lte('price_kobo', f.maxPrice);
  if (f.beds) query = query.gte('bedrooms', f.beds);
  if (f.baths) query = query.gte('bathrooms', f.baths);
  if (listOf(f.types).length) query = query.in('property_type', listOf(f.types));
  if (listOf(f.amenities).length) query = query.contains('amenities', listOf(f.amenities));
  if (f.period) query = query.eq('price_period', f.period);
  if (yes(f.verified)) query = query.eq('is_verified', true);
  if (yes(f.parking)) query = query.eq('parking', true);
  if (f.minSize) query = query.gte('size_sqm', f.minSize);
  const b = boundsOf(f);
  if (b) query = query.gte('lat', b.minLat).lte('lat', b.maxLat).gte('lng', b.minLng).lte('lng', b.maxLng);
  return query;
}

/** In-memory check of one listing (for alerts on newly approved listings). */
export function matches(p: any, f: Filters) {
  const has = (s: unknown, t: string) => String(s ?? '').toLowerCase().includes(t.toLowerCase());
  const term = f.q?.trim();
  if (term && !(has(p.title, term) || has(p.address, term) || has(p.area, term))) return false;
  if (f.area && !has(p.area, f.area)) return false;
  if (f.type && p.property_type !== f.type) return false;
  if (f.minPrice && Number(p.price_kobo) < f.minPrice) return false;
  if (f.maxPrice && Number(p.price_kobo) > f.maxPrice) return false;
  if (f.beds && Number(p.bedrooms) < f.beds) return false;
  if (f.baths && Number(p.bathrooms) < f.baths) return false;
  const types = listOf(f.types); if (types.length && !types.includes(p.property_type)) return false;
  const am = listOf(f.amenities); if (am.length && !am.every((a) => (p.amenities ?? []).includes(a))) return false;
  if (f.period && p.price_period !== f.period) return false;
  if (yes(f.verified) && !p.is_verified) return false;
  if (yes(f.parking) && !p.parking) return false;
  if (f.minSize && Number(p.size_sqm ?? 0) < f.minSize) return false;
  const b = boundsOf(f);
  if (b) {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return false;
    if (p.lat < b.minLat || p.lat > b.maxLat || p.lng < b.minLng || p.lng > b.maxLng) return false;
    if (b.poly && !inPolygon(p.lat, p.lng, b.poly)) return false;
  }
  return true;
}

/** Short human summary, e.g. "2+ beds · Yaba · up to ₦2.5m/yr". */
export function describe(f: Filters) {
  const naira = (k: number) => (k >= 1e8 ? `₦${+(k / 1e8).toFixed(1)}m` : `₦${Math.round(k / 1e5)}k`);
  const bits = [
    f.beds ? `${f.beds}+ bed${f.beds > 1 ? 's' : ''}` : '', f.area || f.q || '', listOf(f.types).join('/') || f.type || '',
    f.minPrice && f.maxPrice ? `${naira(f.minPrice)}–${naira(f.maxPrice)}` : f.maxPrice ? `up to ${naira(f.maxPrice)}` : f.minPrice ? `from ${naira(f.minPrice)}` : '',
    parsePolygon(f.poly) ? 'drawn area' : '', yes(f.verified) ? 'verified' : '',
  ].filter(Boolean);
  return bits.join(' · ') || 'Any home';
}
