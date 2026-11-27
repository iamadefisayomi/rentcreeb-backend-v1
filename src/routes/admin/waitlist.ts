import type { Router } from 'express';
import { z } from 'zod';
import { db, dbError } from '../../lib/supabase';
import { notFound } from '../../lib/errors';
import { paginate, uuid } from '../../lib/common';
import { audit, sendCsv } from './shared';

/**
 * Admin → Waitlist: people who joined from the website ("Join the waitlist", POST /web/waitlist).
 * They are mailing contacts tagged "waitlist"; the form answers and the admin's status/notes live in `attributes`.
 * The list is small (thousands at most), so it is loaded once and filtered, grouped and paged here. That keeps the
 * headline numbers, the groups and the list in agreement.
 */
export const WAITLIST_STATUSES = ['pending', 'contacted', 'invited', 'joined', 'declined'] as const;

/** Ways to group the waitlist. Month/week/day use Nigerian time. "interest" counts a person once per thing they picked. */
export const WAITLIST_GROUPS = ['month', 'week', 'day', 'state', 'lga', 'city', 'iAm', 'interest', 'status', 'source'] as const;
type GroupBy = typeof WAITLIST_GROUPS[number];
const GROUP_LABELS: Record<GroupBy, string> = { month: 'Month', week: 'Week starting', day: 'Day', state: 'State', lga: 'LGA', city: 'City', iAm: 'I am', interest: 'Interested in', status: 'Status', source: 'Source' };

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const listQuery = z.object({
  q: z.string().max(100).optional(), status: z.enum(WAITLIST_STATUSES).optional(),
  // Drill-down filters (what clicking a group sets). Text answers match ignoring case and extra spaces; "-" means "not given".
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(), week: ymd.optional(), day: ymd.optional(), from: ymd.optional(), to: ymd.optional(),
  state: z.string().max(80).optional(), lga: z.string().max(80).optional(), city: z.string().max(80).optional(),
  iAm: z.string().max(80).optional(), interest: z.string().max(120).optional(), source: z.string().max(40).optional(),
  group: z.enum(WAITLIST_GROUPS).optional(), then: z.enum(WAITLIST_GROUPS).optional(),
});
type ListQuery = z.infer<typeof listQuery>;

type Entry = ReturnType<typeof shape>;
function shape(c: any) {
  const a = c.attributes ?? {};
  return {
    id: c.id as string, name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email as string, phone: String(a.phone ?? ''),
    state: String(a.state ?? ''), lga: String(a.lga ?? ''), city: String(a.city ?? ''), interest: Array.isArray(a.interest) ? (a.interest as string[]) : [], iAm: String(a.iAm ?? ''),
    message: a.message ?? '', status: String(a.waitlistStatus ?? 'pending'), source: String(a.waitlistSource ?? 'website'), notes: a.notes ?? '',
    contactedAt: (a.waitlistContactedAt ?? null) as string | null,
    mailStatus: c.status, userId: c.user_id ?? null,
    // When they joined the waitlist (an existing contact can join later than the contact was created).
    createdAt: String(a.waitlistJoinedAt ?? c.created_at), updatedAt: c.updated_at,
  };
}

const LAGOS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' });
/** YYYY-MM-DD in Nigerian time. */
const lagosDay = (iso: string) => LAGOS.format(new Date(iso));
/** Monday of the (Nigerian-time) week, as YYYY-MM-DD. */
function lagosWeek(iso: string) {
  const d = new Date(lagosDay(iso) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The group key(s) an entry falls under. Empty answers group under "". */
function keysOf(e: Entry, by: GroupBy): string[] {
  switch (by) {
    case 'month': return [lagosDay(e.createdAt).slice(0, 7)];
    case 'week': return [lagosWeek(e.createdAt)];
    case 'day': return [lagosDay(e.createdAt)];
    case 'interest': { const k = [...new Set(e.interest.map((x) => norm(String(x))).filter(Boolean))]; return k.length ? k : ['']; }
    default: return [norm(e[by])];
  }
}

function matches(e: Entry, q: ListQuery) {
  const term = q.q?.trim().toLowerCase();
  if (term && !`${e.name} ${e.email} ${e.phone}`.toLowerCase().includes(term)) return false;
  if (q.status && e.status !== q.status) return false;
  const d = lagosDay(e.createdAt);
  if (q.from && d < q.from) return false;
  if (q.to && d > q.to) return false;
  for (const k of ['month', 'week', 'day', 'state', 'lga', 'city', 'iAm', 'interest', 'source'] as const) {
    const want = q[k];
    if (want === undefined) continue;
    if (!keysOf(e, k).includes(want === '-' ? '' : norm(want))) return false;
  }
  return true;
}

type Group = { key: string; label: string; empty: boolean; count: number; contacted: number; joined: number; latest: string; sub?: Group[] };
function groupBy(entries: Entry[], by: GroupBy, then?: GroupBy): Group[] {
  const groups = new Map<string, { key: string; count: number; contacted: number; joined: number; latest: string; items: Entry[]; labels: Map<string, number> }>();
  for (const e of entries) {
    for (const key of keysOf(e, by)) {
      let g = groups.get(key);
      if (!g) groups.set(key, g = { key, count: 0, contacted: 0, joined: 0, latest: e.createdAt, items: [], labels: new Map() });
      g.count++;
      if (e.status !== 'pending') g.contacted++;
      if (e.status === 'joined') g.joined++;
      if (e.createdAt > g.latest) g.latest = e.createdAt;
      if (then) g.items.push(e);
      // Show the spelling people used most (e.g. "Lagos" rather than "lagos").
      const raw = by === 'interest' ? e.interest.find((x) => norm(String(x)) === key) : ['month', 'week', 'day'].includes(by) ? '' : String(e[by as 'state']).trim();
      if (raw) g.labels.set(raw, (g.labels.get(raw) ?? 0) + 1);
    }
  }
  const timeline = by === 'month' || by === 'week' || by === 'day';
  return [...groups.values()]
    .sort((a, b) => timeline ? b.key.localeCompare(a.key) : (b.count - a.count) || a.key.localeCompare(b.key))
    .map((g) => ({
      key: g.key || '-', label: [...g.labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '', empty: !g.key,
      count: g.count, contacted: g.contacted, joined: g.joined, latest: g.latest,
      ...(then ? { sub: groupBy(g.items, then) } : {}),
    }));
}

async function loadAll() {
  const { data, error } = await db.from('mailing_contacts').select('*').contains('tags', ['waitlist']).limit(50000);
  if (error) throw dbError(error);
  return (data ?? []).map(shape).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const groupsFor = (hits: Entry[], q: ListQuery) => q.group ? groupBy(hits, q.group, q.then && q.then !== q.group ? q.then : undefined) : undefined;

export function mountWaitlist(r: Router) {
  r.get('/waitlist', async (req, res) => {
    const { from, to } = paginate(req.query);
    const q = listQuery.parse(req.query);
    const all = await loadAll();
    const byStatus: Record<string, number> = Object.fromEntries(WAITLIST_STATUSES.map((s) => [s, 0]));
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const month = lagosDay(new Date().toISOString()).slice(0, 7);
    let lastWeek = 0, thisMonth = 0;
    for (const e of all) {
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
      if (e.createdAt >= weekAgo) lastWeek++;
      if (lagosDay(e.createdAt).slice(0, 7) === month) thisMonth++;
    }
    const hits = all.filter((e) => matches(e, q));
    res.json({ items: hits.slice(from, to + 1), total: hits.length, summary: { total: all.length, lastWeek, thisMonth, byStatus }, groups: groupsFor(hits, q) });
  });

  r.get('/waitlist.csv', async (req, res) => {
    const q = listQuery.parse(req.query);
    const hits = (await loadAll()).filter((e) => matches(e, q));
    const day = new Date().toISOString().slice(0, 10);
    const groups = groupsFor(hits, q);
    if (groups) {
      // Grouped export: one row per group, and per sub-group when "then by" is set.
      const name = (g: Group) => g.empty ? 'Not given' : g.label || g.key;
      const rows = groups.flatMap((g) => [{ group: name(g), sub: '', count: g.count, contacted: g.contacted, joined: g.joined },
        ...(g.sub ?? []).map((s) => ({ group: name(g), sub: name(s), count: s.count, contacted: s.contacted, joined: s.joined }))]);
      const cols: [string, string][] = [['group', GROUP_LABELS[q.group!]], ...(groups[0]?.sub ? [['sub', GROUP_LABELS[q.then!]] as [string, string]] : []), ['count', 'People'], ['contacted', 'Contacted'], ['joined', 'Joined the app']];
      await audit(req, 'export.waitlist', 'waitlist', null, { rows: rows.length, group: q.group, then: q.then ?? null });
      return sendCsv(res, `rentcreeb-waitlist-by-${q.group}-${day}.csv`, rows, cols);
    }
    await audit(req, 'export.waitlist', 'waitlist', null, { rows: hits.length, status: q.status ?? 'all' });
    sendCsv(res, `rentcreeb-waitlist-${day}.csv`, hits.map((s) => ({ ...s, interest: s.interest.join('; ') })),
      [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['iAm', 'I am'], ['interest', 'Interested in'], ['state', 'State'], ['lga', 'LGA'], ['city', 'City'],
        ['message', 'Message'], ['status', 'Status'], ['contactedAt', 'Contacted'], ['notes', 'Notes'], ['source', 'Source'], ['createdAt', 'Joined']]);
  });

  r.patch('/waitlist/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ status: z.enum(WAITLIST_STATUSES).optional(), notes: z.string().max(2000).optional() }).parse(req.body);
    const { data: c } = await db.from('mailing_contacts').select('attributes, tags').eq('id', id).maybeSingle();
    if (!c || !(c.tags ?? []).includes('waitlist')) throw notFound('Waitlist entry not found');
    const attributes = { ...(c.attributes ?? {}), ...(b.status ? { waitlistStatus: b.status } : {}), ...(b.notes !== undefined ? { notes: b.notes } : {}),
      ...(b.status === 'contacted' && !c.attributes?.waitlistContactedAt ? { waitlistContactedAt: new Date().toISOString() } : {}) };
    const { error } = await db.from('mailing_contacts').update({ attributes, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw dbError(error);
    await audit(req, 'waitlist.update', 'waitlist', id, b);
    res.json({ success: true });
  });

  /** Takes the person off the waitlist (removes the tag); they stay a mailing contact. */
  r.delete('/waitlist/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: c } = await db.from('mailing_contacts').select('tags, email').eq('id', id).maybeSingle();
    if (!c) throw notFound('Waitlist entry not found');
    const { error } = await db.from('mailing_contacts').update({ tags: (c.tags ?? []).filter((t: string) => t !== 'waitlist'), updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw dbError(error);
    await audit(req, 'waitlist.remove', 'waitlist', id, { email: c.email });
    res.status(204).end();
  });
}
