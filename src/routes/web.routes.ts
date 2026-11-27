import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env';
import { anonClient, db, unwrap } from '../lib/supabase';
import { badRequest, conflict, HttpError } from '../lib/errors';
import { passwordSchema } from '../lib/common';
import { authenticate, requireRole } from '../middleware/auth';
import { sendEmail } from '../lib/email';
import { logger } from '../lib/logger';
import { markWaitlistContacted, sendWaitlistWelcome } from '../services/mailing';
import { isWebUrl, makeLinkToken, readLinkToken } from '../lib/webAuth';
import { aiChat, aiEnabled } from '../lib/ai';

/**
 * Endpoints only the rentcreeb.com website needs. The website signs people up with email + password (no phone),
 * so the email address is confirmed with a link instead of an SMS code. Everything else the website does goes
 * through the same endpoints as the app.
 */
const r = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const emailHtml = (name: string, message: string, link: string, label: string) => `
<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#1f2937">
  <h2 style="margin:0 0 16px;color:#1e3a8a">RentCreeb</h2>
  <p>Hi ${esc(name || 'there')},</p><p>${esc(message).replace(/\n/g, '<br>')}</p>
  <p style="margin:28px 0"><a href="${esc(link)}" style="background:#1d4ed8;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${esc(label)}</a></p>
  <p style="font-size:12px;color:#6b7280">If the button does not work, copy this link into your browser:<br>${esc(link)}</p>
  <p style="font-size:12px;color:#6b7280">If you did not ask for this, you can ignore this email.</p>
</div>`;
const like = (email: string) => email.replace(/[\\%_]/g, (c) => '\\' + c);
/** Where a link in an email lands: a website page (validated), defaulting to the home page. */
const dest = (u?: string) => (u && isWebUrl(u) ? u : env.WEB_BASE_URL);
const webLink = (path: string, params: Record<string, string>) => `${env.WEB_BASE_URL}${path}?${new URLSearchParams(params)}`;

/** A session for a user who proved control of their email (confirm / change-email links): one-time magic link, redeemed here. */
async function sessionFor(email: string) {
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email });
  if (error || !data.properties?.hashed_token) throw new HttpError(500, 'Could not sign you in. Please sign in with your password.');
  const { data: s, error: e2 } = await anonClient().auth.verifyOtp({ type: 'magiclink', token_hash: data.properties.hashed_token });
  if (e2 || !s.session) throw new HttpError(500, 'Could not sign you in. Please sign in with your password.');
  return s.session;
}

async function sendConfirm(user: { id: string; email: string; name: string }, callbackURL?: string) {
  const token = makeLinkToken('confirm', user.id, 24 * 3600);
  const link = webLink('/api/auth/verify-email', { token, callbackURL: dest(callbackURL) });
  await sendEmail(user.email, 'Verify your email address', emailHtml(user.name, 'Please click the button below to confirm your email address and finish creating your RentCreeb account.', link, 'Confirm email'));
}

// ── Sign up (email + password) ──
r.post('/auth/register', limiter, async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(2, 'Enter your full name').max(120),
    email: z.string().trim().email('Please enter a valid email').toLowerCase(),
    password: passwordSchema,
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, 'Username: 3–30 letters, numbers, dots, dashes or underscores').optional(),
    accountType: z.enum(['renter', 'agent', 'landlord']).default('renter'),
    callbackURL: z.string().max(500).optional(),
  }).parse(req.body);
  const { data: existing } = await db.from('profiles').select('id').ilike('email', like(b.email)).limit(1);
  if (existing?.length) throw conflict('An account with this email already exists. Sign in instead, or use "Forgot password".', 'ACCOUNT_EXISTS');
  if (b.username) {
    const { data: taken } = await db.from('profiles').select('id').ilike('username', b.username).limit(1);
    if (taken?.length) throw conflict('That username is taken', 'USERNAME_TAKEN');
  }
  const [first, ...rest] = b.name.split(/\s+/);
  const role = b.accountType === 'renter' ? 'tenant' : b.accountType;
  const { data, error } = await db.auth.admin.createUser({
    email: b.email, password: b.password, email_confirm: false,
    user_metadata: { first_name: first, last_name: rest.join(' ') || null, role, signup_source: 'website' },
  });
  if (error || !data.user) throw badRequest(error?.message ?? 'Could not create account', 'SIGNUP_FAILED');
  if (b.username) await db.from('profiles').update({ username: b.username }).eq('id', data.user.id);
  await sendConfirm({ id: data.user.id, email: b.email, name: first }, b.callbackURL);
  res.status(201).json({ message: 'Account created. Check your email to confirm it.', nextStep: 'CONFIRM_EMAIL' });
});

/** The link in the confirmation email: marks the email confirmed and signs the user in. */
r.post('/auth/confirm', async (req, res) => {
  const { token } = z.object({ token: z.string().max(1000) }).parse(req.body);
  const t = readLinkToken(token, 'confirm');
  if (!t) throw badRequest('This confirmation link is invalid or has expired. Request a new one from the sign-in page.', 'BAD_LINK');
  const { data: u, error } = await db.auth.admin.updateUserById(t.userId, { email_confirm: true });
  if (error || !u.user?.email) throw badRequest('This confirmation link is invalid or has expired.', 'BAD_LINK');
  const session = await sessionFor(u.user.email);
  const profile = unwrap(await db.from('profiles').select('*').eq('id', t.userId).single());
  res.json({ profile, session });
});

r.post('/auth/resend-confirmation', limiter, async (req, res) => {
  const { email, callbackURL } = z.object({ email: z.string().trim().email().toLowerCase(), callbackURL: z.string().max(500).optional() }).parse(req.body);
  const { data: p } = await db.from('profiles').select('id, first_name').ilike('email', like(email)).maybeSingle();
  if (p) {
    const { data: u } = await db.auth.admin.getUserById(p.id);
    if (u.user && !u.user.email_confirmed_at) await sendConfirm({ id: p.id, email, name: p.first_name ?? '' }, callbackURL);
  }
  res.json({ message: 'If that account is waiting for confirmation, we sent a new link.' });
});

// ── Password reset by email link (always 200, so it never reveals which emails have accounts) ──
r.post('/auth/forgot-password', limiter, async (req, res) => {
  const { email, redirectTo } = z.object({ email: z.string().trim().email().toLowerCase(), redirectTo: z.string().max(500).optional() }).parse(req.body);
  const { data: p } = await db.from('profiles').select('id, first_name').ilike('email', like(email)).maybeSingle();
  if (p) {
    const { data: u } = await db.auth.admin.getUserById(p.id);
    if (u.user) {
      const token = makeLinkToken('reset', p.id, 3600, u.user.updated_at ?? '');
      const base = redirectTo && isWebUrl(redirectTo) ? redirectTo : `${env.WEB_BASE_URL}/reset/password/new`;
      const link = `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      await sendEmail(email, 'Reset your password', emailHtml(p.first_name ?? '', 'Click the button below to choose a new password. The link expires in one hour.', link, 'Reset password'));
    }
  }
  res.json({ status: true, message: 'If an account exists, a reset link has been sent.' });
});

r.post('/auth/reset-password', limiter, async (req, res) => {
  const { token, password } = z.object({ token: z.string().max(1000), password: passwordSchema }).parse(req.body);
  const t = readLinkToken(token, 'reset');
  const { data: u } = t ? await db.auth.admin.getUserById(t.userId) : { data: { user: null } };
  if (!t || !u.user || (u.user.updated_at ?? '') !== t.version) throw badRequest('This reset link is invalid or has already been used. Request a new one.', 'BAD_LINK');
  const { error } = await db.auth.admin.updateUserById(t.userId, { password, email_confirm: true });
  if (error) throw badRequest(error.message);
  await db.from('legacy_credentials').delete().eq('user_id', t.userId).then(() => undefined, () => undefined);
  res.json({ status: true, message: 'Password updated' });
});

// ── Change email: a link is sent to the new address; the change happens when it is opened ──
r.post('/auth/change-email', authenticate, async (req, res) => {
  const { newEmail, callbackURL } = z.object({ newEmail: z.string().trim().email().toLowerCase(), callbackURL: z.string().max(500).optional() }).parse(req.body);
  if (newEmail === String(req.user.email ?? '').toLowerCase()) throw badRequest('That is already your email address');
  const { data: used } = await db.from('profiles').select('id').ilike('email', like(newEmail)).neq('id', req.user.id).limit(1);
  if (used?.length) throw conflict('Another account uses that email address', 'EMAIL_IN_USE');
  const token = makeLinkToken('email', req.user.id, 24 * 3600, '', newEmail);
  const link = webLink('/api/auth/change-email', { token, callbackURL: dest(callbackURL) });
  await sendEmail(newEmail, 'Confirm your new email address', emailHtml(req.user.first_name ?? '', 'Click the button below to use this address for your RentCreeb account.', link, 'Confirm email change'));
  res.json({ status: true, message: 'Check your new inbox to confirm the change.' });
});

r.post('/auth/change-email/confirm', async (req, res) => {
  const { token } = z.object({ token: z.string().max(1000) }).parse(req.body);
  const t = readLinkToken(token, 'email');
  if (!t || !t.extra) throw badRequest('This link is invalid or has expired.', 'BAD_LINK');
  const { error } = await db.auth.admin.updateUserById(t.userId, { email: t.extra, email_confirm: true });
  if (error) throw badRequest(/already/i.test(error.message) ? 'Another account uses that email address' : error.message);
  await db.from('profiles').update({ email: t.extra, updated_at: new Date().toISOString() }).eq('id', t.userId);
  const session = await sessionFor(t.extra);
  res.json({ profile: unwrap(await db.from('profiles').select('*').eq('id', t.userId).single()), session });
});

/** Google-only accounts can add a password (Account → Password). Accounts that already have one change it with the current password. */
r.post('/auth/set-password', authenticate, async (req, res) => {
  const { password } = z.object({ password: passwordSchema }).parse(req.body);
  const { data } = await db.auth.admin.getUserById(req.user.id);
  const hasPassword = (data.user?.identities ?? []).some((i) => i.provider === 'email')
    || !!(await db.from('legacy_credentials').select('user_id').eq('user_id', req.user.id).maybeSingle()).data;
  if (hasPassword) throw badRequest('Your account already has a password. Use "Change password" instead.', 'HAS_PASSWORD');
  const { error } = await db.auth.admin.updateUserById(req.user.id, { password });
  if (error) throw badRequest(error.message);
  res.json({ status: true });
});

// ── Linked sign-in methods (Account → Connected accounts) ──
r.get('/auth/accounts', authenticate, async (req, res) => {
  const { data } = await db.auth.admin.getUserById(req.user.id);
  const ids = data.user?.identities ?? [];
  const { data: legacy } = await db.from('legacy_credentials').select('user_id').eq('user_id', req.user.id).maybeSingle().then((x) => x, () => ({ data: null }));
  const accounts = ids.map((i) => ({ id: i.identity_id ?? i.id, providerId: i.provider === 'email' ? 'credential' : i.provider, accountId: i.id, createdAt: i.created_at }));
  if (legacy && !accounts.some((a) => a.providerId === 'credential')) accounts.push({ id: 'legacy', providerId: 'credential', accountId: req.user.id, createdAt: undefined });
  res.json({ accounts });
});

r.post('/auth/unlink', authenticate, async (req, res) => {
  const { provider } = z.object({ provider: z.string().min(2).max(30) }).parse(req.body);
  const { data } = await db.auth.admin.getUserById(req.user.id);
  const ids = data.user?.identities ?? [];
  const target = ids.find((i) => i.provider === (provider === 'credential' ? 'email' : provider));
  if (!target) throw badRequest('That sign-in method is not connected');
  if (ids.length < 2) throw badRequest('This is your only way to sign in. Add another one first.', 'LAST_IDENTITY');
  // GoTrue lets the user (not the service role) unlink an identity: call it with their own access token.
  const r1 = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user/identities/${target.identity_id ?? target.id}`, {
    method: 'DELETE', headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: req.headers.authorization! },
  });
  if (!r1.ok) throw badRequest(r1.status === 404 ? 'Identity linking is turned off in Supabase (Auth → Settings → Manual linking).' : 'Could not disconnect it. Please try again.');
  res.json({ status: true });
});

// ── Waitlist (website "Join the waitlist"): stored as mailing contacts tagged "waitlist" ──
const waitlistBody = z.object({
  name: z.string().trim().min(1).max(120), email: z.string().trim().email().toLowerCase(), phone: z.string().trim().max(30).optional().default(''),
  state: z.string().trim().max(60).optional(), lga: z.string().trim().max(80).optional(), city: z.string().trim().max(80).optional(),
  interest: z.array(z.string().max(120)).max(20).optional().default([]), iAm: z.string().trim().max(80).optional().default(''),
  message: z.string().trim().max(2000).optional().default(''), source: z.string().max(40).optional().default('website'),
});
r.post('/waitlist', limiter, async (req, res) => {
  const b = waitlistBody.parse(req.body);
  const { data: existing } = await db.from('mailing_contacts').select('id, tags, status, attributes').eq('email', b.email).maybeSingle();
  if (existing?.tags?.includes('waitlist')) return res.status(409).json({ success: false, message: 'This email has already joined the waitlist.' });
  const [first, ...rest] = b.name.split(/\s+/);
  const attributes = { phone: b.phone, state: b.state ?? '', lga: b.lga ?? '', city: b.city ?? '', interest: b.interest, iAm: b.iAm, message: b.message, waitlistStatus: 'pending', waitlistSource: b.source, waitlistJoinedAt: new Date().toISOString() };
  const row = existing
    ? unwrap(await db.from('mailing_contacts').update({
      tags: [...new Set([...(existing.tags ?? []), 'waitlist'])], attributes: { ...(existing.attributes ?? {}), ...attributes }, updated_at: new Date().toISOString(),
      // Joining the waitlist is a fresh opt-in for someone who had unsubscribed (never for bounced / spam-complaint addresses).
      ...(existing.status === 'unsubscribed' ? { status: 'subscribed', consent_at: new Date().toISOString() } : {}),
    }).eq('id', existing.id).select().single())
    : unwrap(await db.from('mailing_contacts').insert({ email: b.email, first_name: first, last_name: rest.join(' ') || null, source: 'signup_form', status: 'subscribed', consent_at: new Date().toISOString(), confirmed_at: new Date().toISOString(), tags: ['waitlist'], attributes }).select().single());
  // Welcome email straight away: the "Waitlist welcome" automation (Admin → Mailing → Automations), or a plain fallback
  // if it's switched off or mailing isn't set up. And a note to the RentCreeb inbox.
  // Either way, a delivered welcome moves them from "pending" to "contacted" in Admin → Waitlist.
  void sendWaitlistWelcome(row.id).then((done) => done ? undefined :
    sendEmail(b.email, "🎉 You're on the RentCreeb waitlist!", emailHtml(first, "Thanks for joining the RentCreeb waitlist. We'll let you know as soon as it's ready for you.", env.WEB_BASE_URL, 'Visit RentCreeb'))
      .then((sent) => sent ? markWaitlistContacted([row.id]) : undefined))
    .catch((err) => logger.warn({ err: err?.message }, 'waitlist welcome email failed'));
  void sendEmail(env.WEB_CONTACT_EMAIL, `New Waitlist Signup • ${b.name}`, plainHtml([
    ['Name', b.name], ['Email', b.email], ['Phone', b.phone], ['State', b.state ?? ''], ['LGA', b.lga ?? ''], ['City', b.city ?? ''],
    ['Interest', b.interest.join(', ')], ['I am', b.iAm], ['Message', b.message || 'None'],
  ]), { replyTo: b.email });
  res.status(201).json({ success: true, data: { id: row.id, ...b, status: 'pending', createdAt: row.created_at } });
});

// ── Contact form: the message goes to the RentCreeb inbox and the sender gets a confirmation ──
const plainHtml = (rows: [string, string][]) => `<div style="font-family:Arial,sans-serif;color:#1f2937">${rows.map(([k, v]) => `<p><b>${esc(k)}:</b><br>${esc(v).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
r.post('/contact', limiter, async (req, res) => {
  const b = z.object({
    name: z.string().trim().min(1).max(120), email: z.string().trim().email().toLowerCase(), message: z.string().trim().min(1).max(5000),
    phone: z.string().trim().max(30).optional(), subject: z.string().trim().max(200).optional(),
    desiredDate: z.string().max(40).optional(), desiredTime: z.string().max(40).optional(),
  }).parse(req.body);
  const first = b.name.split(/\s+/)[0];
  await sendEmail(env.WEB_CONTACT_EMAIL, `New message from ${b.name}`, plainHtml([
    ['Name', b.name], ['Email', b.email], ...(b.phone ? [['Phone', b.phone] as [string, string]] : []), ...(b.subject ? [['Subject', b.subject] as [string, string]] : []),
    ...(b.desiredDate || b.desiredTime ? [['Preferred time', `${b.desiredDate ?? ''} ${b.desiredTime ?? ''}`.trim()] as [string, string]] : []), ['Message', b.message],
  ]), { replyTo: b.email });
  await sendEmail(b.email, `Dear ${first}, we got your message.`, emailHtml(first, `Thanks for contacting RentCreeb. We received your message and will reply soon.\n\nYour message: "${b.message.slice(0, 500)}"`, env.WEB_BASE_URL, 'Visit RentCreeb'));
  res.json({ success: true });
});

// ── AI: polish a listing description (website "Generate description") ──
r.post('/ai/property-description', authenticate, requireRole('agent', 'landlord', 'estate_manager', 'admin'), async (req, res) => {
  const b = z.object({ description: z.string().trim().min(20, 'Write at least 20 characters first').max(5000), property: z.unknown().optional() }).parse(req.body);
  if (!aiEnabled()) throw new HttpError(503, 'AI writing is not available right now', 'AI_DISABLED');
  const facts = JSON.stringify(b.property ?? {}).slice(0, 4000);
  const text = await aiChat([
    { role: 'system', content: 'You write property listing descriptions for RentCreeb, a Nigerian rental marketplace. Rewrite the description to be polished, detailed and professional, clearly highlighting the key features, easy for renters or buyers to understand. Use only facts given; never invent amenities, prices or locations. Reply with the description text only: no title, no preamble, no markdown headings.' },
    { role: 'user', content: `Property data: ${facts}\n\nCurrent description: """${b.description}"""` },
  ], { maxTokens: 900, temperature: 0.5, timeoutMs: 60_000 });
  if (!text?.trim()) throw new HttpError(503, 'Could not write a description right now. Please try again.', 'AI_FAILED');
  res.json({ description: text.replace(/<\|[^|]*\|>/g, '').trim() });
});

/** Website admin → Waitlist. */
r.get('/admin/waitlist', authenticate, requireRole('admin'), async (req, res) => {
  const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50), search: z.string().max(100).optional() }).parse(req.query);
  let query = db.from('mailing_contacts').select('*', { count: 'exact' }).contains('tags', ['waitlist']).order('created_at', { ascending: false });
  const term = q.search?.replace(/[,()*:%."\\]/g, ' ').trim();
  if (term) query = query.or(`email.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%`);
  const { data, count, error } = await query.range((q.page - 1) * q.limit, q.page * q.limit - 1);
  if (error) throw badRequest(error.message);
  res.json({ items: (data ?? []).map((c: any) => ({ _id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email, ...c.attributes, status: c.attributes?.waitlistStatus ?? 'pending', source: c.attributes?.waitlistSource ?? 'website', notes: c.attributes?.notes ?? '', createdAt: c.created_at, updatedAt: c.updated_at })), total: count ?? 0, page: q.page, limit: q.limit });
});

r.patch('/admin/waitlist/:id', authenticate, requireRole('admin'), async (req, res) => {
  const b = z.object({ status: z.string().max(30).optional(), notes: z.string().max(2000).optional() }).parse(req.body);
  const { data: c } = await db.from('mailing_contacts').select('attributes').eq('id', req.params.id).maybeSingle();
  if (!c) throw badRequest('Not found');
  const attributes = { ...(c.attributes ?? {}), ...(b.status ? { waitlistStatus: b.status } : {}), ...(b.notes !== undefined ? { notes: b.notes } : {}) };
  await db.from('mailing_contacts').update({ attributes, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  res.json({ success: true });
});

r.delete('/admin/waitlist/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { data: c } = await db.from('mailing_contacts').select('tags').eq('id', req.params.id).maybeSingle();
  if (c) await db.from('mailing_contacts').update({ tags: (c.tags ?? []).filter((t: string) => t !== 'waitlist') }).eq('id', req.params.id);
  res.status(204).end();
});

export default r;
