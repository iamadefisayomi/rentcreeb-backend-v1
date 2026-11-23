import type { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { db, dbError } from '../../lib/supabase';
import { badRequest } from '../../lib/errors';
import { paginate } from '../../lib/common';
import { logger } from '../../lib/logger';
import { sendEmail } from '../../lib/email';
import { smsHealth } from '../../lib/sms';
import { bytidHealth } from '../../lib/bytid';
import { paystack } from '../../lib/paystack';
import { aiHealth } from '../../lib/ai';
import { claudeEnabled, claudeHealth } from '../../lib/claude';
import { notify } from '../../services/notify';
import { getSettings, setSetting } from '../../services/settings';
import { iceServers } from '../calls.routes';
import { PERSON, audit, count, dailySeries, isUuid, like, sumKobo } from './shared';

const ROLES = ['tenant', 'landlord', 'estate_manager', 'artisan', 'agent', 'developer', 'investor', 'admin_manager', 'admin'] as const;
const audience = z.object({
  roles: z.array(z.enum(ROLES)).default([]),
  verification: z.enum(['any', 'verified', 'unverified']).default('any'),
});
type Audience = z.infer<typeof audience>;

function audienceQuery(a: Audience, cols = 'id') {
  let q: any = db.from('profiles').select(cols, { count: 'exact' }).eq('is_suspended', false).is('deleted_at', null);
  if (a.roles.length) q = q.in('role', a.roles);
  if (a.verification === 'verified') q = q.eq('nin_verified', true);
  if (a.verification === 'unverified') q = q.eq('nin_verified', false);
  return q;
}

/** Wrap a health probe so one slow provider can't hold up the page. */
const timed = async <T>(fn: () => Promise<T>, ms = 12_000): Promise<T | { ok: false; detail: string }> => {
  const started = Date.now();
  try {
    const v: any = await Promise.race([fn(), new Promise((_r, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);
    return { ...v, ms: Date.now() - started };
  } catch (err) { return { ok: false, detail: String((err as Error)?.message ?? err) }; }
};

export function mountPlatform(r: Router) {
  // ───────── Overview ─────────
  r.get('/overview', async (req, res) => {
    const d30 = new Date(Date.now() - 30 * 864e5).toISOString();
    const d7 = new Date(Date.now() - 7 * 864e5).toISOString();
    const h1 = new Date(Date.now() - 3600e3).toISOString();
    const [
      users, newUsers7d, tenants, landlords, agents, artisans, suspended, verified,
      pendingProperties, liveProperties, pendingArtisans, manualVerifications, openReports, openTickets, flaggedReviews,
      pendingWithdrawals, stuckPayments, heldEscrows, bookings7d, activeSubs, pay30, escrowHeld, signups30, recent, scamAlerts,
    ] = await Promise.all([
      count('profiles', (q) => q.is('deleted_at', null)), count('profiles', (q) => q.gte('created_at', d7)),
      count('profiles', (q) => q.eq('role', 'tenant')), count('profiles', (q) => q.in('role', ['landlord', 'estate_manager'])),
      count('profiles', (q) => q.eq('role', 'agent')), count('profiles', (q) => q.eq('role', 'artisan')),
      count('profiles', (q) => q.eq('is_suspended', true).is('deleted_at', null)), count('profiles', (q) => q.eq('nin_verified', true)),
      count('properties', (q) => q.eq('status', 'pending')), count('properties', (q) => q.eq('status', 'approved')),
      count('artisan_profiles', (q) => q.eq('review_status', 'pending')), count('verifications', (q) => q.eq('status', 'manual_review')),
      count('reports', (q) => q.in('status', ['open', 'investigating'])), count('support_tickets', (q) => q.in('status', ['open', 'in_progress'])),
      count('reviews', (q) => q.gt('flag_count', 0).eq('hidden', false)),
      count('withdrawals', (q) => q.eq('status', 'pending').lt('created_at', h1)), count('payments', (q) => q.eq('status', 'pending').lt('created_at', h1).gte('created_at', d7)),
      count('escrows', (q) => q.eq('status', 'held')),
      count('bookings', (q) => q.gte('created_at', d7)), count('subscriptions', (q) => q.eq('status', 'active')),
      db.from('payments').select('amount_kobo, paid_at, created_at').eq('status', 'success').gte('created_at', d30).limit(20000),
      db.from('escrows').select('amount_kobo').eq('status', 'held').limit(20000),
      db.from('profiles').select('created_at').gte('created_at', d30).limit(20000),
      db.from('admin_actions').select('id, action, target_type, target_id, details, created_at, admin:profiles!admin_actions_admin_id_fkey(first_name, last_name)').order('created_at', { ascending: false }).limit(12),
      count('scam_alerts', (q) => q.in('status', ['open', 'reported'])),
    ]);
    const settings = await getSettings();
    if (req.user.role !== 'admin') return res.json({ // managers: no money figures or audit trail
      role: req.user.role,
      users: { total: users, new7d: newUsers7d, tenants, landlords, agents, artisans, suspended, verified },
      queues: { pendingProperties, pendingArtisans, manualVerifications, openReports, openTickets, flaggedReviews, scamAlerts },
      activity: { liveProperties, bookings7d },
      trends: { signups: dailySeries(signups30.data ?? [], 30) },
      settings: { maintenanceMode: settings.maintenanceMode, banner: settings.banner },
      recentActions: [],
    });
    res.json({
      role: req.user.role,
      users: { total: users, new7d: newUsers7d, tenants, landlords, agents, artisans, suspended, verified },
      queues: { pendingProperties, pendingArtisans, manualVerifications, openReports, openTickets, flaggedReviews, pendingWithdrawals, stuckPayments, scamAlerts },
      activity: { liveProperties, bookings7d, activeSubscriptions: activeSubs, paymentsKobo30d: sumKobo(pay30.data), escrowHeldKobo: sumKobo(escrowHeld.data), heldEscrows },
      trends: { signups: dailySeries(signups30.data ?? [], 30), paymentsKobo: dailySeries(pay30.data ?? [], 30, (p) => Number(p.amount_kobo)) },
      settings: { maintenanceMode: settings.maintenanceMode, banner: settings.banner },
      recentActions: recent.error ? [] : recent.data,
    });
  });

  // ───────── Global search ─────────
  r.get('/search', async (req, res) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    const t = like(q);
    const id = isUuid(q) ? q : null;
    const [users, properties, payments, bookings] = await Promise.all([
      (id ? db.from('profiles').select(PERSON).eq('id', id) : db.from('profiles').select(PERSON).or(`first_name.ilike.${t},last_name.ilike.${t},email.ilike.${t},phone.ilike.${t}`)).limit(8),
      (id ? db.from('properties').select('id, title, area, status').eq('id', id) : db.from('properties').select('id, title, area, status').or(`title.ilike.${t},address.ilike.${t}`)).limit(8),
      (id ? db.from('payments').select('id, reference, amount_kobo, status, purpose').eq('id', id) : db.from('payments').select('id, reference, amount_kobo, status, purpose').ilike('reference', t)).limit(8),
      id ? db.from('bookings').select('id, status, scheduled_at, properties(title)').eq('id', id).limit(1) : Promise.resolve({ data: [] }),
    ]);
    res.json({ users: users.data ?? [], properties: properties.data ?? [], payments: payments.data ?? [], bookings: (bookings as any).data ?? [] });
  });

  // ───────── System health ─────────
  r.get('/system', async (_req, res) => {
    const probe = async (table: string, col = 'id') => { const { error } = await db.from(table).select(col, { head: true, count: 'exact' }).limit(1); return !error; };
    const [database, sms, bytid, pay, turn, ai, schema] = await Promise.all([
      timed(async () => { const t = Date.now(); const { error } = await db.from('profiles').select('id', { head: true, count: 'exact' }).limit(1); return error ? { ok: false, detail: error.message } : { ok: true, latencyMs: Date.now() - t }; }),
      timed(() => smsHealth()),
      timed(() => bytidHealth()),
      timed(async () => { const b = await paystack.balance(); const mode = env.PAYSTACK_SECRET_KEY.startsWith('sk_live_') ? 'live' : env.PAYSTACK_SECRET_KEY.startsWith('sk_test_') ? 'test' : 'unknown'; return { ok: true, mode, balance: b }; }),
      timed(async () => { const list = await iceServers(); const relays = list.flatMap((s) => s.urls).filter((u) => /^turns?:/.test(u)); return { ok: relays.length > 0, relays: relays.length, detail: relays.length ? undefined : 'No TURN relay: calls on mobile data may not connect' }; }),
      timed(() => (claudeEnabled() ? claudeHealth() : aiHealth())),
      (async () => {
        const checks: [string, Promise<boolean>][] = [
          ['011 admin audit log', probe('admin_actions')],
          ['012 user documents', probe('user_documents')],
          ['013 ID review evidence', probe('verifications', 'selfie_path')],
          ['013 admin notes', probe('admin_notes')],
          ['013 runtime settings', probe('app_settings', 'key')],
          ['013 announcements', probe('announcements')],
          ['014 listing AI review', probe('properties', 'ai_review')],
          ['018 support chat', probe('support_tickets', 'conversation_id')],
          ['018 mailing list', probe('mailing_contacts')],
          ['019 listing video links', probe('properties', 'video_urls')],
          ['020 assistant & live agents', probe('assistant_conversations')],
          ['023 website (slugs, legacy ids)', probe('properties', 'legacy_id')],
          ['024 scam alerts', probe('scam_alerts')],
        ];
        return Promise.all(checks.map(async ([name, p]) => ({ name, applied: await p })));
      })(),
    ]);
    const mem = process.memoryUsage();
    res.json({
      server: { ok: true, env: env.NODE_ENV, node: process.version, uptimeSec: Math.round(process.uptime()), memoryMb: Math.round(mem.rss / 1048576), time: new Date().toISOString() },
      database, sms, bytid, paystack: pay, turn, ai,
      email: { ok: !!env.RESEND_API_KEY, detail: env.RESEND_API_KEY ? `Sending as ${env.EMAIL_FROM}` : 'RESEND_API_KEY not set: emails are skipped' },
      storage: { ok: !!(env.BUNNY_STORAGE_ZONE && env.BUNNY_PRIVATE_STORAGE_ZONE && env.BUNNY_PRIVATE_TOKEN_KEY), detail: env.BUNNY_PRIVATE_STORAGE_ZONE ? undefined : 'Private storage zone not configured: ID evidence cannot be stored' },
      migrations: schema,
      settings: await getSettings(true),
    });
  });

  // ───────── Runtime settings ─────────
  r.get('/settings', async (_req, res) => res.json({ settings: await getSettings(true), envMaintenance: env.MAINTENANCE_MODE }));
  r.put('/settings', async (req, res) => {
    const b = z.object({
      maintenanceMode: z.boolean().optional(),
      maintenanceMessage: z.string().trim().max(300).optional(),
      listingAutoApprove: z.boolean().optional(),
      banner: z.object({ message: z.string().trim().min(3).max(200), tone: z.enum(['info', 'warning', 'success']).default('info'), until: z.string().datetime().nullable().optional() }).nullable().optional(),
    }).parse(req.body);
    try {
      if (b.maintenanceMode !== undefined) await setSetting('maintenance_mode', b.maintenanceMode, req.user.id);
      if (b.maintenanceMessage !== undefined) await setSetting('maintenance_message', b.maintenanceMessage, req.user.id);
      if (b.banner !== undefined) await setSetting('banner', b.banner, req.user.id);
      if (b.listingAutoApprove !== undefined) await setSetting('listing_auto_approve', b.listingAutoApprove, req.user.id);
    } catch (err: any) {
      if (/app_settings|relation|schema cache/i.test(err?.message ?? '')) throw badRequest('Apply migration 013_admin_tools.sql in Supabase to enable runtime settings', 'MIGRATION_REQUIRED');
      throw badRequest(err?.message ?? 'Could not save settings');
    }
    await audit(req, 'settings.update', 'settings', null, b);
    res.json({ settings: await getSettings(true) });
  });

  // ───────── Announcements ─────────
  r.get('/announcements', async (req, res) => {
    const { from, to } = paginate(req.query);
    const { data, error } = await db.from('announcements').select('*, admin:profiles!announcements_admin_id_fkey(first_name, last_name)').order('created_at', { ascending: false }).range(from, to);
    res.json({ announcements: error ? [] : data, available: !error });
  });
  /** dryRun returns the recipient count. A real send answers at once and delivers in the background (in-app + push, optional email). */
  r.post('/announcements', async (req, res) => {
    const b = z.object({ title: z.string().trim().min(2).max(80), body: z.string().trim().min(2).max(1000), audience: audience.default({}), email: z.boolean().default(false), dryRun: z.boolean().default(false) }).parse(req.body);
    const { count: n, error } = await audienceQuery(b.audience).limit(1);
    if (error) throw dbError(error);
    if (b.dryRun) return res.json({ recipients: n ?? 0 });
    if (!n) throw badRequest('Nobody matches that audience');
    const { data: row } = await db.from('announcements').insert({ admin_id: req.user.id, title: b.title, body: b.body, audience: { ...b.audience, email: b.email }, recipients: n }).select('id').maybeSingle();
    await audit(req, 'announcement.send', 'announcement', row?.id ?? null, { title: b.title, audience: b.audience, recipients: n, email: b.email });
    res.status(202).json({ recipients: n, id: row?.id ?? null });
    // Deliver in pages so a large audience never loads into memory at once.
    void (async () => {
      let sent = 0;
      for (let from = 0; ; from += 500) {
        const { data, error: e } = await audienceQuery(b.audience, 'id, email, first_name').order('created_at').range(from, from + 499);
        if (e) { logger.error({ err: e }, 'announcement: audience page failed'); break; }
        for (const u of (data ?? []) as any[]) {
          await notify(u.id, 'announcement', b.title, b.body, { announcementId: row?.id });
          if (b.email && u.email) await sendEmail(u.email, b.title, `<p>Hi ${String(u.first_name || 'there').replace(/[<>&"]/g, '')},</p><p>${b.body.replace(/[<>&"]/g, '').replace(/\n/g, '<br>')}</p><p>— The RentCreeb team</p>`);
          sent++;
        }
        if (!data || data.length < 500) break;
      }
      logger.info({ sent, id: row?.id }, 'announcement delivered');
    })().catch((err) => logger.error({ err }, 'announcement delivery failed'));
  });

  // ───────── Audit log ─────────
  r.get('/actions', async (req, res) => {
    const { from, to } = paginate(req.query);
    const f = z.object({ action: z.string().max(60).optional(), targetId: z.string().max(80).optional(), adminId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)) }).parse(req.query);
    let q = db.from('admin_actions').select('*, admin:profiles!admin_actions_admin_id_fkey(first_name, last_name)', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
    if (f.action) q = q.ilike('action', `${f.action.replace(/[%_]/g, '')}%`);
    if (f.targetId) q = q.eq('target_id', f.targetId);
    if (f.adminId) q = q.eq('admin_id', f.adminId);
    const { data, count: total, error } = await q;
    if (error) throw dbError(error);
    res.json({ actions: data, total: total ?? 0 });
  });
  r.get('/admins', async (_req, res) => {
    const { data, error } = await db.from('profiles').select(PERSON + ', created_at').in('role', ['admin', 'admin_manager']).order('created_at');
    if (error) throw dbError(error);
    res.json({ admins: data });
  });
}
