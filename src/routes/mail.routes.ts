import express, { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../lib/supabase';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import {
  handleProviderEvent, isEmail, normalizeEmail, recordClick, recordOpen, render, resubscribeContact, sendConfirmation,
  unsubscribeContact, verifyProviderSignature, verifySig,
} from '../services/mailing';

/**
 * Public mailing endpoints (no sign-in): links inside emails, the preferences page, the website sign-up form and the
 * Resend webhook. Mounted at /mail, outside /api/v1 and its rate limiter (mail clients fetch pixels in bursts).
 */
const r = Router();
r.use(express.urlencoded({ extended: false, limit: '20kb' }));
r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex'); next(); });

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(res: Response, title: string, body: string, status = 200) {
  res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · RentCreeb</title>
<style>body{margin:0;background:#f4f6fb;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111a33}main{max-width:520px;margin:48px auto;padding:0 16px}
.card{background:#fff;border:1px solid #e3e7f0;border-radius:14px;padding:26px}h1{font-size:22px;margin:0 0 10px}.brand{font-weight:700;font-size:19px;margin-bottom:18px}.brand b{color:#2563eb}
label{display:flex;gap:10px;align-items:flex-start;margin:10px 0}button{background:#2563eb;color:#fff;border:0;border-radius:9px;padding:11px 18px;font:600 15px inherit;cursor:pointer}
button.ghost{background:#fff;color:#dc2626;border:1px solid #e3e7f0}select,input[type=text],input[type=email]{width:100%;box-sizing:border-box;border:1px solid #e3e7f0;border-radius:9px;padding:9px 11px;font:inherit}
.muted{color:#5b6680;font-size:13.5px}.ok{color:#15803d}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
@media (prefers-color-scheme:dark){body{background:#0b1020;color:#e8ecf6}.card{background:#141b2e;border-color:#263049}.muted{color:#a3adc4}button.ghost{background:#141b2e}select,input{background:#0b1020;color:#e8ecf6;border-color:#263049}}</style></head>
<body><main><div class="brand">Rent<b>Creeb</b></div><div class="card">${body}</div></main></body></html>`);
}

async function contactByToken(token: string) {
  if (!/^[a-f0-9]{20,64}$/.test(token)) return null;
  const { data } = await db.from('mailing_contacts').select('id, email, first_name, status, user_id, token').eq('token', token).maybeSingle();
  return data;
}
const sendIdOf = (v: unknown) => (typeof v === 'string' && uuidRe.test(v) ? v : null);

// ── open pixel ──
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
r.get('/o/:id.gif', (req, res) => {
  const id = sendIdOf(req.params.id);
  if (id) void recordOpen(id).catch(() => {});
  res.type('gif').send(GIF);
});

// ── click redirect (signed: only links we put in an email can be followed) ──
r.get('/c/:id', async (req, res) => {
  const id = sendIdOf(req.params.id); const url = String(req.query.u ?? ''); const s = String(req.query.s ?? '');
  if (!id || !/^https?:\/\//i.test(url) || !verifySig(id + '|' + url, s)) return page(res, 'Link not valid', '<h1>This link is not valid</h1><p class="muted">It may have been copied incorrectly.</p>', 400);
  void recordClick(id, url).catch(() => {});
  res.redirect(302, url);
});

// ── view in browser ──
r.get('/v/:id', async (req, res) => {
  const id = sendIdOf(req.params.id);
  if (!id || !verifySig('view|' + id, String(req.query.s ?? ''))) return page(res, 'Not found', '<h1>Email not found</h1>', 404);
  const { data: s } = await db.from('mailing_sends').select('campaign_id, automation_id, contact:mailing_contacts(email, first_name, last_name, attributes, token)').eq('id', id).maybeSingle();
  const table = s?.campaign_id ? 'mailing_campaigns' : 'mailing_automations';
  const { data: content } = s ? await db.from(table).select('subject, preheader, html, kind').eq('id', s.campaign_id ?? s.automation_id).maybeSingle() : { data: null };
  if (!s?.contact || !content) return page(res, 'Not found', '<h1>Email not found</h1>', 404);
  res.type('html').send(render({ ...(content as any), track: false }, s.contact as any).html);
});

// ── preferences / unsubscribe page ──
r.get('/u/:token', async (req, res) => {
  const c = await contactByToken(req.params.token);
  if (!c) return page(res, 'Link not valid', '<h1>This link is not valid</h1><p class="muted">It may have expired or been copied incorrectly.</p>', 404);
  const [{ data: lists }, { data: mine }] = await Promise.all([
    db.from('mailing_lists').select('id, name, description').eq('is_public', true).order('name'),
    db.from('mailing_list_members').select('list_id, status').eq('contact_id', c.id),
  ]);
  const on = new Set((mine ?? []).filter((m) => m.status === 'subscribed').map((m) => m.list_id));
  const subscribed = c.status === 'subscribed';
  const s = esc(String(req.query.s ?? ''));
  const listBoxes = (lists ?? []).map((l) => `<label><input type="checkbox" name="list" value="${esc(l.id)}"${on.has(l.id) && subscribed ? ' checked' : ''}><span><b>${esc(l.name)}</b>${l.description ? `<br><span class="muted">${esc(l.description)}</span>` : ''}</span></label>`).join('');
  page(res, 'Email preferences', `<h1>Email preferences</h1><p class="muted">For ${esc(c.email)}</p>
${c.status === 'bounced' || c.status === 'complained' ? '<p>We no longer send email to this address.</p>' : subscribed ? '' : '<p><b>You are unsubscribed</b> from RentCreeb marketing emails.</p>'}
<form method="post" action="/mail/u/${esc(c.token)}">
<input type="hidden" name="s" value="${s}">
${listBoxes ? `<p style="margin-top:18px"><b>Choose what you get</b></p>${listBoxes}<div class="row"><button name="action" value="save">Save preferences</button></div>` : ''}
${subscribed ? `<p style="margin-top:22px"><b>Unsubscribe from everything</b></p>
<select name="reason" aria-label="Reason (optional)"><option value="">Reason (optional)</option><option>Too many emails</option><option>Not relevant to me</option><option>I never signed up</option><option>Other</option></select>
<div class="row"><button class="ghost" name="action" value="unsubscribe">Unsubscribe from all marketing</button></div>` : `<div class="row"><button name="action" value="resubscribe">Subscribe again</button></div>`}
<p class="muted" style="margin-top:18px">You'll still get important messages about your account, payments and bookings if you use the RentCreeb app.</p>
</form>`);
});

r.post('/u/:token', async (req, res) => {
  const c = await contactByToken(req.params.token);
  if (!c) return page(res, 'Link not valid', '<h1>This link is not valid</h1>', 404);
  const action = String(req.body?.action ?? 'unsubscribe');
  const sendId = sendIdOf(req.body?.s);
  if (action === 'resubscribe') {
    await resubscribeContact(c.id);
    return page(res, 'Subscribed', '<h1 class="ok">You are subscribed again</h1><p>Thanks! You can change this any time from the link in our emails.</p>');
  }
  if (action === 'save') {
    const chosen = new Set(([] as string[]).concat(req.body?.list ?? []).filter((x) => uuidRe.test(x)));
    const { data: lists } = await db.from('mailing_lists').select('id').eq('is_public', true);
    for (const l of lists ?? []) {
      await db.from('mailing_list_members').upsert({ list_id: l.id, contact_id: c.id, status: chosen.has(l.id) ? 'subscribed' : 'unsubscribed' }, { onConflict: 'list_id,contact_id' });
    }
    if (chosen.size && c.status !== 'subscribed') await resubscribeContact(c.id);
    if (!chosen.size && (lists ?? []).length) await unsubscribeContact(c.id, { sendId, reason: 'Unticked every list' });
    return page(res, 'Saved', '<h1 class="ok">Preferences saved</h1><p>Thanks, we have updated what you receive.</p>');
  }
  await unsubscribeContact(c.id, { sendId, reason: String(req.body?.reason ?? '').slice(0, 200) || null });
  page(res, 'Unsubscribed', `<h1>You're unsubscribed</h1><p>${esc(c.email)} won't get RentCreeb marketing emails any more.</p>
<form method="post" action="/mail/u/${esc(c.token)}"><div class="row"><button name="action" value="resubscribe">Undo, keep me subscribed</button></div></form>`);
});

// RFC 8058 one-click unsubscribe (mail apps POST here from their own "Unsubscribe" button).
r.post('/u/:token/one-click', async (req, res) => {
  const c = await contactByToken(req.params.token);
  if (c) await unsubscribeContact(c.id, { sendId: sendIdOf(req.query.s), reason: 'One-click unsubscribe' });
  res.status(200).send('Unsubscribed');
});
r.get('/u/:token/one-click', (req, res) => res.redirect(302, `/mail/u/${encodeURIComponent(req.params.token)}`));

// ── public sign-up (website newsletter forms) ──
const signupLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
r.post('/subscribe', signupLimit, async (req, res) => {
  const b = z.object({
    email: z.string().trim().max(254), firstName: z.string().trim().max(80).optional(), lastName: z.string().trim().max(80).optional(),
    listId: z.string().uuid().optional(), tags: z.array(z.string().trim().max(40)).max(5).optional(), company: z.string().max(0).optional(), // `company` = honeypot
  }).safeParse({ ...req.body, tags: typeof req.body?.tags === 'string' ? [req.body.tags] : req.body?.tags });
  const wantsHtml = !req.is('application/json');
  const done = (ok: boolean, msg: string) => (wantsHtml ? page(res, ok ? 'Check your inbox' : 'Sign-up failed', `<h1>${ok ? 'Almost done' : 'Sign-up failed'}</h1><p>${esc(msg)}</p>`, ok ? 200 : 400) : res.status(ok ? 200 : 400).json({ ok, message: msg }));
  if (!b.success || !isEmail(b.data.email)) return done(false, 'Please enter a valid email address.');
  if (b.data.company) return done(true, 'Check your inbox to confirm.'); // bot
  const email = normalizeEmail(b.data.email);
  let list: { id: string; double_opt_in: boolean } | null = null;
  if (b.data.listId) {
    const { data } = await db.from('mailing_lists').select('id, double_opt_in').eq('id', b.data.listId).eq('is_public', true).maybeSingle();
    if (!data) return done(false, 'That mailing list is not available.');
    list = data;
  }
  const doubleOptIn = list ? list.double_opt_in : true;
  const { data: existing } = await db.from('mailing_contacts').select('id, status, token, first_name, tags').eq('email', email).maybeSingle();
  if (existing && ['bounced', 'complained'].includes(existing.status)) return done(true, 'Thanks! Check your inbox to confirm.');
  let contact = existing;
  if (!contact) {
    const { data, error } = await db.from('mailing_contacts').insert({ email, first_name: b.data.firstName || null, last_name: b.data.lastName || null, source: 'signup_form',
      status: doubleOptIn ? 'pending' : 'subscribed', consent_at: new Date().toISOString(), tags: b.data.tags ?? [] }).select('id, status, token, first_name, tags').single();
    if (error) { logger.error({ err: error }, 'signup failed'); return done(false, 'Something went wrong. Please try again.'); }
    contact = data;
  } else if (b.data.tags?.length) {
    await db.from('mailing_contacts').update({ tags: [...new Set([...(existing!.tags ?? []), ...b.data.tags])] }).eq('id', existing!.id);
  }
  if (list) await db.from('mailing_list_members').upsert({ list_id: list.id, contact_id: contact!.id, status: 'subscribed' }, { onConflict: 'list_id,contact_id' });
  if (contact!.status === 'subscribed') return done(true, "You're subscribed. Thanks for joining!");
  if (contact!.status === 'unsubscribed' && !doubleOptIn) { await resubscribeContact(contact!.id); return done(true, "You're subscribed again. Welcome back!"); }
  await sendConfirmation({ email, first_name: contact!.first_name, token: contact!.token });
  done(true, 'We sent you an email. Click the link inside to confirm your subscription.');
});

r.get('/confirm/:token', async (req, res) => {
  const c = await contactByToken(req.params.token);
  if (!c) return page(res, 'Link not valid', '<h1>This link is not valid</h1>', 404);
  if (c.status === 'pending' || c.status === 'unsubscribed') {
    const at = new Date().toISOString();
    await db.from('mailing_contacts').update({ status: 'subscribed', confirmed_at: at, consent_at: at, unsubscribed_at: null, updated_at: at }).eq('id', c.id);
    await db.from('mailing_events').insert({ contact_id: c.id, type: 'confirm' });
  }
  page(res, 'Subscribed', `<h1 class="ok">You're subscribed</h1><p>Thanks for confirming. Welcome to RentCreeb!</p><p><a href="${esc(env.APP_BASE_URL)}">Visit RentCreeb →</a></p>`);
});

// ── Resend webhook: delivered / bounced / complained ──
r.post('/webhooks/resend', async (req: any, res) => {
  if (!verifyProviderSignature(req.rawBody, req.headers)) return res.status(401).json({ error: 'bad signature' });
  try { await handleProviderEvent(req.body); } catch (err) { logger.error({ err }, 'resend webhook failed'); }
  res.json({ ok: true });
});

export default r;
