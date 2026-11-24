import { db } from '../lib/supabase';
import { logger } from '../lib/logger';
import { notify } from './notify';

/**
 * Listing price tools: price history, a fair-price check against similar live listings, owner performance stats and
 * price-drop alerts for people who saved the listing. Everything degrades to empty results if migration 034 is missing.
 */
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const naira = (k: number) => `₦${Math.round(k / 100).toLocaleString('en-NG')}`;

type P = { id: string; area: string | null; city: string | null; state: string | null; property_type: string; bedrooms: number | null; price_kobo: number; price_period: string };

/**
 * Median price of similar live listings: same type, bedrooms and price period. Tries the same area first, then widens
 * to the city and the state until at least 3 comparables are found.
 */
export async function comparablePrice(p: P) {
  const scopes: { scope: 'area' | 'city' | 'state'; col: string; val: string | null }[] = [
    { scope: 'area', col: 'area', val: p.area }, { scope: 'city', col: 'city', val: p.city }, { scope: 'state', col: 'state', val: p.state },
  ];
  for (const s of scopes) {
    if (!s.val) continue;
    const { data } = await db.from('properties').select('price_kobo').eq('status', 'approved').eq('property_type', p.property_type)
      .eq('bedrooms', p.bedrooms ?? 0).eq('price_period', p.price_period).ilike(s.col, s.val.trim()).neq('id', p.id).gt('price_kobo', 0).limit(300);
    const prices = (data ?? []).map((x: any) => Number(x.price_kobo));
    if (prices.length >= 3) {
      const med = median(prices)!;
      return { scope: s.scope, place: s.val, count: prices.length, medianKobo: med, lowKobo: Math.min(...prices), highKobo: Math.max(...prices),
        diffPct: Math.round(((p.price_kobo - med) / med) * 100) };
    }
  }
  return null;
}

/** Price changes, newest first, plus the latest drop (if the price went down since it was listed). */
export async function priceHistory(propertyId: string) {
  const { data, error } = await db.from('property_price_history').select('old_price_kobo, new_price_kobo, changed_at').eq('property_id', propertyId).order('changed_at', { ascending: false }).limit(20);
  if (error) return { history: [], lastDrop: null };
  const history = (data ?? []).map((h: any) => ({ fromKobo: Number(h.old_price_kobo), toKobo: Number(h.new_price_kobo), at: h.changed_at }));
  const recent = history.find((h) => h.toKobo < h.fromKobo && Date.now() - new Date(h.at).getTime() < 60 * 864e5);
  return { history, lastDrop: recent ? { byKobo: recent.fromKobo - recent.toKobo, at: recent.at, fromKobo: recent.fromKobo } : null };
}

/** Plain-language verdict for tenants and a suggested price for owners. */
export function verdict(c: Awaited<ReturnType<typeof comparablePrice>>) {
  if (!c) return null;
  const where = c.scope === 'area' ? `in ${c.place}` : `across ${c.place}`;
  if (c.diffPct <= -10) return { tone: 'good', text: `${Math.abs(c.diffPct)}% below similar homes ${where}` };
  if (c.diffPct >= 15) return { tone: 'high', text: `${c.diffPct}% above similar homes ${where}` };
  return { tone: 'fair', text: `In line with similar homes ${where}` };
}

/** Owner view: views, saves, inspection requests, enquiries and how the price compares. */
export async function listingInsights(p: P & { created_at: string }) {
  const now = Date.now();
  const d30 = new Date(now - 30 * 864e5).toISOString();
  const [views, saves, bookings, enquiries, comp] = await Promise.all([
    db.from('property_views').select('created_at').eq('property_id', p.id).gte('created_at', d30).limit(5000),
    db.from('saved_properties').select('user_id', { count: 'exact', head: true }).eq('property_id', p.id),
    db.from('bookings').select('status, created_at').eq('property_id', p.id).limit(1000),
    db.from('conversations').select('id', { count: 'exact', head: true }).eq('context_type', 'property').eq('context_id', p.id),
    comparablePrice(p),
  ]);
  const v = (views.data ?? []) as { created_at: string }[];
  const days = Array.from({ length: 14 }, (_, i) => new Date(now - (13 - i) * 864e5).toISOString().slice(0, 10));
  const perDay = new Map(days.map((d) => [d, 0]));
  for (const x of v) { const d = x.created_at.slice(0, 10); if (perDay.has(d)) perDay.set(d, perDay.get(d)! + 1); }
  const b = (bookings.data ?? []) as { status: string }[];
  const requests = b.filter((x) => !['pending_payment', 'expired'].includes(x.status)).length;
  const views30 = v.length;
  const tips: string[] = [];
  if (comp && comp.diffPct >= 15) tips.push(`Your price is ${comp.diffPct}% above similar homes. Homes near ${naira(comp.medianKobo)} get more inspection requests.`);
  if (views30 >= 30 && requests === 0) tips.push('Lots of views but no inspection requests: check the price, add more photos or a video tour.');
  if (views30 < 5 && now - new Date(p.created_at).getTime() > 7 * 864e5) tips.push('Few people are seeing this listing. Add a map pin and share the listing link or QR code.');
  return {
    views7: v.filter((x) => now - new Date(x.created_at).getTime() < 7 * 864e5).length, views30,
    viewsByDay: days.map((d) => ({ day: d, views: perDay.get(d) ?? 0 })),
    saves: saves.count ?? 0, inspectionRequests: requests, completedInspections: b.filter((x) => x.status === 'completed').length,
    enquiries: enquiries.count ?? 0, conversionPct: views30 ? Math.round((requests / views30) * 1000) / 10 : 0,
    price: comp ? { ...comp, suggestedKobo: comp.medianKobo, verdict: verdict(comp) } : null,
    tips,
  };
}

/** Tell everyone who saved the listing that its price dropped. Fire-and-forget from the update route. */
export async function alertPriceDrop(p: { id: string; title: string; status: string }, oldKobo: number, newKobo: number) {
  if (p.status !== 'approved' || newKobo >= oldKobo) return;
  try {
    const { data } = await db.from('saved_properties').select('user_id').eq('property_id', p.id).limit(1000);
    const by = naira(oldKobo - newKobo);
    for (const s of data ?? []) await notify(s.user_id, 'price_drop', `Price dropped ${by} 📉`, `${p.title} is now ${naira(newKobo)}.`, { propertyId: p.id });
  } catch (err) { logger.warn({ err }, 'price drop alert failed'); }
}
