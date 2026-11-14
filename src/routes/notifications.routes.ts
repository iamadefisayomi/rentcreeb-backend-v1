import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/supabase';
import { paginate } from '../lib/common';
import { authenticate } from '../middleware/auth';
import { categoryOf, knownTypes, NOTIFICATION_CATEGORIES, typesOf, type NotificationCategory } from '../services/notify';

const r = Router();
r.use(authenticate);

/** Unread totals overall and per Notification Center tab. */
async function unreadCounts(userId: string) {
  const { data } = await db.from('notifications').select('type').eq('user_id', userId).is('read_at', null).limit(1000);
  const byCategory = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, 0])) as Record<NotificationCategory, number>;
  for (const n of data ?? []) byCategory[categoryOf(n.type)]++;
  return { unreadCount: (data ?? []).length, unreadByCategory: byCategory };
}

/**
 * Notification Center. ?category=payments|bookings|maintenance|messages|reviews|account  ?unread=true  ?page=&limit=
 * Each item carries `category` so the app can pick its icon/colour.
 */
r.get('/', async (req, res) => {
  const { from, to, page, limit } = paginate(req.query);
  const f = z.object({ category: z.enum(NOTIFICATION_CATEGORIES).optional(), unread: z.enum(['true', 'false']).optional() }).parse(req.query);
  let q = db.from('notifications').select('*', { count: 'exact' }).eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (f.category === 'account') q = q.not('type', 'in', `(${knownTypes().join(',')})`);
  else if (f.category) q = q.in('type', typesOf(f.category));
  if (f.unread === 'true') q = q.is('read_at', null);
  const [{ data, count }, counts] = await Promise.all([q.range(from, to), unreadCounts(req.user.id)]);
  res.json({
    notifications: (data ?? []).map((n) => ({ ...n, category: categoryOf(n.type) })),
    page, limit, total: count ?? 0, hasMore: (count ?? 0) > to + 1, ...counts,
  });
});

/** Cheap badge count for bells / tab bar / app icon. */
r.get('/unread-count', async (req, res) => res.json(await unreadCounts(req.user.id)));

r.post('/read-all', async (req, res) => {
  const { category } = z.object({ category: z.enum(NOTIFICATION_CATEGORIES).optional() }).parse(req.body ?? {});
  let q = db.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', req.user.id).is('read_at', null);
  if (category === 'account') q = q.not('type', 'in', `(${knownTypes().join(',')})`);
  else if (category) q = q.in('type', typesOf(category));
  await q;
  res.status(204).end();
});

r.post('/:id/read', async (req, res) => {
  await db.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', String(req.params.id)).eq('user_id', req.user.id);
  res.status(204).end();
});

/** Mark one notification unread again. */
r.post('/:id/unread', async (req, res) => {
  await db.from('notifications').update({ read_at: null }).eq('id', String(req.params.id)).eq('user_id', req.user.id);
  res.status(204).end();
});

r.delete('/:id', async (req, res) => {
  await db.from('notifications').delete().eq('id', String(req.params.id)).eq('user_id', req.user.id);
  res.status(204).end();
});

/** Clear every notification that has already been read. */
r.delete('/', async (req, res) => {
  await db.from('notifications').delete().eq('user_id', req.user.id).not('read_at', 'is', null);
  res.status(204).end();
});

export default r;
