import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { anonClient, db, unwrap } from '../lib/supabase';
import { badRequest, conflict, HttpError, unauthorized } from '../lib/errors';
import { passwordSchema, phoneSchema } from '../lib/common';
import { issueOtp, verifyOtp } from '../lib/otp';
import { sendSms } from '../lib/sms';
import { authenticate } from '../middleware/auth';
import { logger } from '../lib/logger';
import { isWebUrl, verifyBetterAuthHash } from '../lib/webAuth';

/**
 * Accounts imported from the old website keep their password: if Supabase rejects it and the account still has an
 * imported hash that matches, the password is moved into Supabase Auth (and the old hash deleted).
 */
async function tryLegacyPassword(email: string, password: string) {
  const { data: p } = await db.from('profiles').select('id').ilike('email', email.replace(/[\\%_]/g, (c) => '\\' + c)).maybeSingle();
  if (!p) return false;
  const { data: cred, error } = await db.from('legacy_credentials').select('hash').eq('user_id', p.id).maybeSingle();
  if (error || !cred || !(await verifyBetterAuthHash(password, cred.hash))) return false;
  const { error: ue } = await db.auth.admin.updateUserById(p.id, { password, email_confirm: true });
  if (ue) { logger.error({ err: ue }, 'legacy password: could not move into Supabase'); return false; }
  await db.from('legacy_credentials').delete().eq('user_id', p.id);
  return true;
}

const r = Router();

const registerSchema = z.object({
  firstName: z.string().min(2, 'Min 2 characters'),
  lastName: z.string().min(2, 'Min 2 characters'),
  phone: phoneSchema,
  email: z.string().email('Please enter a valid email').toLowerCase(),
  password: passwordSchema,
  confirmPassword: z.string(),
  role: z.enum(['tenant', 'landlord', 'estate_manager', 'artisan', 'agent', 'developer', 'investor']),
}).refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

async function sendPhoneOtp(userId: string, phone: string) {
  const code = await issueOtp({ purpose: 'phone_verify', userId, phone });
  await sendSms(phone, `RentCreeb: your verification code is ${code}. It expires in 10 minutes.`);
}

/** Sign up. Email confirmation is skipped — the phone OTP is the verification step. */

r.post('/register', async (req, res) => {
  const b = registerSchema.parse(req.body);

  // Phone must be in international E.164 format.
  if (!/^\+[1-9]\d{7,14}$/.test(b.phone)) {
    throw badRequest(
      'Enter a valid international phone number',
      'INVALID_PHONE'
    );
  }

  // Check whether email or phone is already registered. Two separate lookups: a combined OR with
  // maybeSingle() errors when the email and the phone belong to two different accounts.
  const email = b.email.trim().toLowerCase();
  const [byPhone, byEmail] = await Promise.all([
    db.from('profiles').select('id').eq('phone', b.phone).limit(1),
    db.from('profiles').select('id').ilike('email', email.replace(/[\\%_]/g, (c) => '\\' + c)).limit(1),
  ]);
  const checkError = byPhone.error ?? byEmail.error;
  if (checkError) {
    logger.error({ err: checkError }, 'register: duplicate check failed');
    throw new HttpError(500, 'Could not verify account details. Please try again.');
  }
  if (byEmail.data?.length) throw conflict('An account with this email already exists. Sign in instead, or use “Forgot password”.', 'ACCOUNT_EXISTS');
  if (byPhone.data?.length) throw conflict('This phone number is already linked to another account.', 'PHONE_IN_USE');

  // Create Supabase Auth user.
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: b.password,
    email_confirm: true,
    user_metadata: {
      first_name: b.firstName,
      last_name: b.lastName,
      phone: b.phone,
      role: b.role,
    },
  });

  if (error || !data.user) {
    throw badRequest(
      error?.message ?? 'Could not create account',
      'SIGNUP_FAILED'
    );
  }

  // Sign in the newly created user.
  const { data: s, error: se } = await anonClient()
    .auth.signInWithPassword({
      email,
      password: b.password,
    });

  if (se || !s.session) {
    throw new HttpError(
      500,
      'Account created but sign-in failed'
    );
  }

  // Send verification OTP to the international phone number.
  await sendPhoneOtp(data.user.id, b.phone);

  // Retrieve profile.
  const profile = unwrap(
    await db
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single()
  );

  res.status(201).json({
    profile,
    session: s.session,
    nextStep: 'VERIFY_PHONE',
  });
});


/** identifier = email OR phone */
r.post('/login', async (req, res) => {
  const { identifier, password } = z.object({ identifier: z.string().min(3), password: z.string().min(1) }).parse(req.body);
  let email = identifier.toLowerCase();
  if (!identifier.includes('@')) {
    const phone = phoneSchema.parse(identifier);
    const { data } = await db.from('profiles').select('email').eq('phone', phone).maybeSingle();
    if (!data?.email) throw unauthorized('Invalid credentials');
    email = data.email;
  }
  let { data, error } = await anonClient().auth.signInWithPassword({ email, password });
  if (error && /not confirmed/i.test(error.message)) throw unauthorized('Confirm your email first: open the link we emailed you, or request a new one.', 'EMAIL_NOT_CONFIRMED');
  if ((error || !data.session) && await tryLegacyPassword(email, password)) ({ data, error } = await anonClient().auth.signInWithPassword({ email, password }));
  if (error || !data.session) throw unauthorized('Invalid credentials');
  const profile = unwrap(await db.from('profiles').select('*').eq('id', data.user.id).single());
  res.json({ profile, session: data.session });
});

r.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) throw unauthorized('Session expired');
  res.json({ session: data.session });
});

r.post('/logout', authenticate, async (req, res) => {
  const token = req.headers.authorization!.slice(7);
  await db.auth.admin.signOut(token);
  res.status(204).end();
});

/**
 * Google / Apple social authentication.
 *
 * Supabase verifies the provider identity token and issues
 * the normal Supabase access and refresh tokens.
 */
r.post('/social', async (req, res) => {
  const { provider, idToken } = z.object({
    provider: z.enum(['google', 'apple']),
    idToken: z.string().min(20),
  }).parse(req.body);

  const { data, error } = await anonClient().auth.signInWithIdToken({
    provider,
    token: idToken,
  });

  if (error || !data.user || !data.session) {
    throw unauthorized('Social authentication failed');
  }

  // Your profiles table should be populated by your
  // existing Supabase auth.users profile trigger.
  const profile = unwrap(
    await db
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single()
  );

  res.json({
    profile,
    session: data.session,
    isNewUser:
      data.user.created_at === data.user.last_sign_in_at,
  });
});

/**
 * Browser-based OAuth through Supabase (works in Expo Go, unlike Google's native flow, which rejects exp:// redirects).
 * 1) /oauth/start returns Supabase's authorize URL (PKCE: the app keeps the verifier, sends only the challenge).
 * 2) Google sends the user back to Supabase's own https callback, which redirects to the app with ?code=…
 * 3) /oauth/finish swaps code + verifier for a session and fills in the profile from the Google account.
 */
// Only the app may receive the code: Expo Go (exp://…) in development, the app scheme in builds.
const APP_REDIRECT = /^(exp|exps):\/\/[^\s]+$|^rentcreeb:\/\/[^\s]*$/;

r.post('/oauth/start', async (req, res) => {
  const b = z.object({
    provider: z.enum(['google', 'facebook']), // facebook: enable the provider in Supabase Auth first
    redirectTo: z.string().max(500).refine((u) => APP_REDIRECT.test(u) || isWebUrl(u), 'Unsupported redirect'),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  }).parse(req.body);
  const url = new URL(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/authorize`);
  url.searchParams.set('provider', b.provider);
  url.searchParams.set('redirect_to', b.redirectTo);
  url.searchParams.set('code_challenge', b.codeChallenge);
  url.searchParams.set('code_challenge_method', 's256');
  res.json({ url: url.toString() });
});

r.post('/oauth/finish', async (req, res) => {
  const b = z.object({ code: z.string().min(10).max(500), codeVerifier: z.string().regex(/^[A-Za-z0-9_~.-]{43,128}$/), source: z.enum(["app", "website"]).optional() }).parse(req.body);
  const r1 = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/token?grant_type=pkce`, {
    method: 'POST', headers: { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_code: b.code, code_verifier: b.codeVerifier }),
  });
  const session: any = await r1.json().catch(() => null);
  if (!r1.ok || !session?.access_token || !session?.user) throw unauthorized('Google sign-in could not be completed. Please try again.');
  const u = session.user;
  // The signup trigger reads first/last name from metadata; Google sends given/family/full name instead.
  const meta = u.user_metadata ?? {};
  const full = String(meta.full_name ?? meta.name ?? '').trim();
  const first = meta.given_name ?? meta.first_name ?? (full ? full.split(/\s+/)[0] : null);
  const last = meta.family_name ?? meta.last_name ?? (full.includes(' ') ? full.split(/\s+/).slice(1).join(' ') : null);
  let { data: existing } = await db.from('profiles').select('*').eq('id', u.id).maybeSingle();
  // A login whose profile is missing (e.g. removed by hand) gets a fresh one, as the sign-up trigger would have made.
  let repaired = false;
  if (!existing) {
    const role = ['tenant', 'landlord', 'estate_manager', 'artisan', 'agent', 'developer', 'investor'].includes(meta.role) ? meta.role : 'tenant';
    const ins = await db.from('profiles').insert({ id: u.id, email: u.email ?? null, first_name: first, last_name: last, role, avatar_url: meta.avatar_url ?? meta.picture ?? null }).select('*').single();
    if (ins.error) {
      logger.error({ err: ins.error, userId: u.id }, 'oauth: could not recreate missing profile');
      throw unauthorized('Your account could not be created. Please try again.');
    }
    await db.from('wallets').upsert({ user_id: u.id }, { onConflict: 'user_id', ignoreDuplicates: true });
    existing = ins.data;
    repaired = true;
    logger.warn({ userId: u.id }, 'oauth: recreated a missing profile');
  }
  const patch: Record<string, unknown> = {};
  if (!existing.first_name && first) patch.first_name = first;
  if (!existing.last_name && last) patch.last_name = last;
  if (!existing.avatar_url && (meta.avatar_url || meta.picture)) patch.avatar_url = meta.avatar_url ?? meta.picture;
  if (!existing.email && u.email) patch.email = u.email;
  const profile = Object.keys(patch).length ? unwrap(await db.from('profiles').update(patch).eq('id', u.id).select('*').single()) : existing;
  const isNewUser = (repaired || Date.now() - Date.parse(u.created_at) < 5 * 60 * 1000) && !profile.onboarding_completed;
  // Google accounts created on the website: Google confirmed the email, which counts instead of a phone code there.
  if (isNewUser && b.source === "website" && !meta.signup_source) await db.auth.admin.updateUserById(u.id, { user_metadata: { ...meta, signup_source: "website" } });
  res.json({
    profile,
    session: { access_token: session.access_token, refresh_token: session.refresh_token, expires_in: session.expires_in, expires_at: session.expires_at, token_type: session.token_type },
    isNewUser,
  });
});

/** Always 200 to avoid leaking which accounts exist. Supabase emails the reset link (configure Resend SMTP in Supabase). */
r.post('/forgot-password', async (req, res) => {
  const { identifier } = z.object({ identifier: z.string().min(3) }).parse(req.body);
  let email: string | null = identifier.includes('@') ? identifier.toLowerCase() : null;
  if (!email) {
    const { data } = await db.from('profiles').select('email').eq('phone', phoneSchema.parse(identifier)).maybeSingle();
    email = data?.email ?? null;
  }
  if (email) await anonClient().auth.resetPasswordForEmail(email, { redirectTo: env.PASSWORD_RESET_REDIRECT_URL });
  res.json({ message: 'If an account exists, a reset link has been sent.' });
});

/** Call with the recovery access_token (from the deep link) as the Bearer token. */
r.post('/reset-password', authenticate, async (req, res) => {
  const { password } = z.object({ password: passwordSchema }).parse(req.body);
  const { error } = await db.auth.admin.updateUserById(req.user.id, { password });
  if (error) throw badRequest(error.message);
  res.json({ message: 'Password updated' });
});

/** Settings → Password & Security. Re-checks the current password, then signs out every other session. */
r.post('/change-password', authenticate, async (req, res) => {
  const b = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
    .refine((d) => d.currentPassword !== d.newPassword, { path: ['newPassword'], message: 'New password must be different' })
    .parse(req.body);
  if (!req.user.email) throw badRequest('This account has no password sign-in');
  const { error: bad } = await anonClient().auth.signInWithPassword({ email: req.user.email, password: b.currentPassword });
  if (bad) throw badRequest('Current password is incorrect', 'WRONG_PASSWORD');
  const { error } = await db.auth.admin.updateUserById(req.user.id, { password: b.newPassword });
  if (error) throw badRequest(error.message);
  await db.auth.admin.signOut(req.headers.authorization!.slice(7), 'others');
  res.json({ message: 'Password updated' });
});

/** Settings → Active Sessions: revoke every refresh token except the one making this request. */
r.post('/logout-others', authenticate, async (req, res) => {
  const { error } = await db.auth.admin.signOut(req.headers.authorization!.slice(7), 'others');
  if (error) throw badRequest(error.message);
  res.status(204).end();
});

r.post('/phone/send-otp', authenticate, async (req, res) => {
  const body = z.object({ phone: phoneSchema.optional() }).parse(req.body ?? {});
  const phone = body.phone ?? req.user.phone;
  if (!phone) throw badRequest('Phone number required');
  if (body.phone && body.phone !== req.user.phone) {
    const { data: taken } = await db.from('profiles').select('id').eq('phone', phone).neq('id', req.user.id).maybeSingle();
    if (taken) throw conflict('Phone number already in use');
    await db.from('profiles').update({ phone, phone_verified: false }).eq('id', req.user.id);
  }
  await sendPhoneOtp(req.user.id, phone);
  res.json({ message: 'Code sent', resendInSeconds: 45 });
});

r.post('/phone/verify-otp', authenticate, async (req, res) => {
  const { code } = z.object({ code: z.string().length(6) }).parse(req.body);
  await verifyOtp({ purpose: 'phone_verify', userId: req.user.id }, code);
  const profile = unwrap(await db.from('profiles').update({ phone_verified: true, updated_at: new Date().toISOString() }).eq('id', req.user.id).select().single());
  res.json({ profile });
});

export default r;
