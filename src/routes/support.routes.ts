import { Router } from 'express';
import { z } from 'zod';
import { db, dbError, unwrap, unwrapMaybe } from '../lib/supabase';
import { conflict } from '../lib/errors';
import { sendEmail } from '../lib/email';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { authenticate } from '../middleware/auth';
import { ensureTicketConversation } from '../services/supportChat';

/** Settings → Support (Contact Support, Report a Bug, Rate RentCreeb) and Privacy / Cookie preferences. */
const r = Router();
r.use(authenticate);

/** Consent keys. `essential` is always on and cannot be changed (needed for sign-in, payments and security). */
export const PRIVACY_DEFAULTS = {
  essential: true,
  analytics: true,
  personalisation: true,
  marketing: false,
  /** Show when I'm online, typing or on a call. Turning it off also hides other people's status from me. */
  activity_status: true,
} as const;
export type PrivacyPrefKey = keyof typeof PRIVACY_DEFAULTS;
const resolvePrivacy = (saved: unknown) => ({ ...PRIVACY_DEFAULTS, ...((saved as object) ?? {}), essential: true });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

r.post('/tickets', async (req, res) => {
  const b = z.object({
    kind: z.enum(['support', 'bug', 'data_request']),
    category: z.string().trim().min(2).max(60),
    subject: z.string().trim().min(3).max(120),
    message: z.string().trim().min(10, 'Please describe the issue in at least 10 characters').max(4000),
    severity: z.enum(['low', 'medium', 'high']).optional(),
    meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  }).parse(req.body);

  if (b.kind === 'data_request') {
    const pending = unwrap(await db.from('support_tickets').select('id').eq('user_id', req.user.id)
      .eq('kind', 'data_request').in('status', ['open', 'in_progress']).limit(1));
    if (pending.length) throw conflict('You already have a data request in progress. We will email you when it is ready.', 'REQUEST_PENDING');
  }

  const ticket = unwrap(await db.from('support_tickets').insert({
    user_id: req.user.id, kind: b.kind, category: b.category, subject: b.subject, message: b.message,
    severity: b.kind === 'bug' ? b.severity ?? 'medium' : null, meta: b.meta ?? {},
  }).select().single());
  // The request opens as a chat thread in Messages, where support's answers arrive and the user can reply.
  try { await ensureTicketConversation(ticket); } catch (err) { logger.error({ err, ticket: ticket.id }, 'support thread not created (apply migration 018)'); }

  if (env.SUPPORT_EMAIL) {
    const who = `${req.user.first_name ?? ''} ${req.user.last_name ?? ''}`.trim() || req.user.id;
    sendEmail(env.SUPPORT_EMAIL, `[${b.kind}] ${b.subject}`,
      `<p><b>From:</b> ${esc(who)} (${esc(req.user.email ?? 'no email')}, ${esc(req.user.role)})</p>
       <p><b>Category:</b> ${esc(b.category)}${b.severity ? ` · <b>Severity:</b> ${b.severity}` : ''}</p>
       <p>${esc(b.message).replace(/\n/g, '<br/>')}</p>
       <pre>${esc(JSON.stringify(b.meta ?? {}, null, 2))}</pre>
       <p>Ticket ${ticket.id}</p>`).catch((err) => logger.error({ err }, 'support email failed'));
  }
  res.status(201).json({ ticket });
});

r.get('/tickets', async (req, res) => {
  const tickets = unwrap(await db.from('support_tickets').select('id, kind, category, subject, status, created_at, conversation_id, awaiting, last_message_at')
    .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(20));
  res.json({ tickets });
});

r.post('/feedback', async (req, res) => {
  const b = z.object({
    rating: z.number().int().min(1).max(5),
    tags: z.array(z.string().trim().max(40)).max(10).optional(),
    comment: z.string().trim().max(2000).optional(),
    platform: z.string().max(20).optional(),
    appVersion: z.string().max(40).optional(),
  }).parse(req.body);
  const feedback = unwrap(await db.from('app_feedback').insert({
    user_id: req.user.id, rating: b.rating, tags: b.tags ?? [], comment: b.comment || null, platform: b.platform, app_version: b.appVersion,
  }).select().single());
  res.status(201).json({ feedback });
});

r.get('/feedback/latest', async (req, res) => {
  const feedback = unwrapMaybe(await db.from('app_feedback').select('rating, tags, comment, created_at')
    .eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(1).maybeSingle());
  res.json({ feedback: feedback ?? null });
});

r.get('/privacy-prefs', async (req, res) => {
  res.json({ prefs: resolvePrivacy((req.user as any).privacy_prefs) });
});

r.put('/privacy-prefs', async (req, res) => {
  const keys = Object.keys(PRIVACY_DEFAULTS).filter((k) => k !== 'essential') as [PrivacyPrefKey, ...PrivacyPrefKey[]];
  const b = z.record(z.enum(keys), z.boolean()).parse(req.body?.prefs ?? {});
  const merged = { ...((req.user as any).privacy_prefs ?? {}), ...b };
  delete (merged as any).essential;
  const { error } = await db.from('profiles').update({ privacy_prefs: merged, updated_at: new Date().toISOString() }).eq('id', req.user.id);
  if (error) throw dbError(error);
  res.json({ prefs: resolvePrivacy(merged) });
});

export default r;
