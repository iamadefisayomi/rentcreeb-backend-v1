import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { anonClient, db, unwrap } from '../lib/supabase';
import { badRequest, conflict, HttpError, unauthorized } from '../lib/errors';
import { passwordSchema, phoneSchema } from '../lib/common';
import { issueOtp, verifyOtp } from '../lib/otp';
import { sendSms } from '../lib/sms';
import { authenticate } from '../middleware/auth';

const r = Router();

const registerSchema = z.object({
  firstName: z.string().min(2, 'Min 2 characters'),
  lastName: z.string().min(2, 'Min 2 characters'),
  phone: phoneSchema,
  email: z.string().email('Please enter a valid email').toLowerCase(),
  password: passwordSchema,
  confirmPassword: z.string(),
  role: z.enum(['tenant', 'landlord', 'estate_manager', 'artisan', 'agent']),
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

  // Check whether email or phone is already registered.
  const { data: taken, error: checkError } = await db
    .from('profiles')
    .select('id')
    .or(`phone.eq.${b.phone},email.eq.${b.email}`)
    .maybeSingle();

  if (checkError) {
    throw new HttpError(500, 'Could not verify account details');
  }

  if (taken) {
    throw conflict(
      'An account with this email or phone already exists',
      'ACCOUNT_EXISTS'
    );
  }

  // Create Supabase Auth user.
  const { data, error } = await db.auth.admin.createUser({
    email: b.email,
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
      email: b.email,
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
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
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
