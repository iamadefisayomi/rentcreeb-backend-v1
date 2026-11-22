import type { Router } from 'express';
import { z } from 'zod';
import { db, dbError } from '../../lib/supabase';
import { notFound } from '../../lib/errors';
import { paginate, uuid } from '../../lib/common';
import { audit, like, sendCsv } from './shared';

/**
 * Admin → Waitlist: people who joined from the website ("Join the waitlist", POST /web/waitlist).
 * They are mailing contacts tagged "waitlist"; the form answers and the admin's status/notes live in `attributes`.
 */
export const WAITLIST_STATUSES = ['pending', 'contacted', 'invited', 'joined', 'declined'] as const;

const listQuery = z.object({ q: z.string().max(100).optional(), status: z.enum(WAITLIST_STATUSES).optional() });

function shape(c: any) {
  const a = c.attributes ?? {};
  return {
    id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email, phone: a.phone ?? '',
    state: a.state ?? '', lga: a.lga ?? '', city: a.city ?? '', interest: Array.isArray(a.interest) ? a.interest : [], iAm: a.iAm ?? '',
    message: a.message ?? '', status: a.waitlistStatus ?? 'pending', source: a.waitlistSource ?? 'website', notes: a.notes ?? '',
    mailStatus: c.status, userId: c.user_id ?? null, createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

function filtered(q: z.infer<typeof listQuery>, select: string, opts?: { count: 'exact' }) {
  let query = db.from('mailing_contacts').select(select, opts).contains('tags', ['waitlist']);
  const term = q.q?.trim();
  if (term) { const p = like(term); query = query.or(`email.ilike.${p},first_name.ilike.${p},last_name.ilike.${p}`); }
  if (q.status === 'pending') query = query.or('attributes->>waitlistStatus.is.null,attributes->>waitlistStatus.eq.pending');
  else if (q.status) query = query.eq('attributes->>waitlistStatus', q.status);
  return query;
}

export function mountWaitlist(r: Router) {
  r.get('/waitlist', async (req, res) => {
    const { from, to } = paginate(req.query);
    const q = listQuery.parse(req.query);
    const [{ data, count, error }, all] = await Promise.all([
      filtered(q, '*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to),
      db.from('mailing_contacts').select('attributes->>waitlistStatus, created_at').contains('tags', ['waitlist']).limit(50000),
    ]);
    if (error) throw dbError(error);
    const byStatus: Record<string, number> = Object.fromEntries(WAITLIST_STATUSES.map((s) => [s, 0]));
    const weekAgo = Date.now() - 7 * 864e5; let lastWeek = 0;
    for (const x of (all.data ?? []) as any[]) {
      const s = x.waitlistStatus ?? 'pending'; byStatus[s] = (byStatus[s] ?? 0) + 1;
      if (Date.parse(x.created_at) >= weekAgo) lastWeek++;
    }
    res.json({ items: (data ?? []).map(shape), total: count ?? 0, summary: { total: (all.data ?? []).length, lastWeek, byStatus } });
  });

  r.get('/waitlist.csv', async (req, res) => {
    const q = listQuery.parse(req.query);
    const { data, error } = await filtered(q, '*').order('created_at', { ascending: false }).limit(50000);
    if (error) throw dbError(error);
    await audit(req, 'export.waitlist', 'waitlist', null, { rows: data?.length ?? 0, status: q.status ?? 'all' });
    sendCsv(res, `rentcreeb-waitlist-${new Date().toISOString().slice(0, 10)}.csv`, (data ?? []).map((c) => { const s = shape(c); return { ...s, interest: s.interest.join('; ') }; }),
      [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['iAm', 'I am'], ['interest', 'Interested in'], ['state', 'State'], ['lga', 'LGA'], ['city', 'City'],
        ['message', 'Message'], ['status', 'Status'], ['notes', 'Notes'], ['source', 'Source'], ['createdAt', 'Joined']]);
  });

  r.patch('/waitlist/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ status: z.enum(WAITLIST_STATUSES).optional(), notes: z.string().max(2000).optional() }).parse(req.body);
    const { data: c } = await db.from('mailing_contacts').select('attributes, tags').eq('id', id).maybeSingle();
    if (!c || !(c.tags ?? []).includes('waitlist')) throw notFound('Waitlist entry not found');
    const attributes = { ...(c.attributes ?? {}), ...(b.status ? { waitlistStatus: b.status } : {}), ...(b.notes !== undefined ? { notes: b.notes } : {}) };
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
