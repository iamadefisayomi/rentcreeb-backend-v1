import { Router } from 'express';
import { z } from 'zod';
import { closeAccount } from '../services/accounts';
import { responseTime } from '../services/responseTime';
import { db, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { authenticate } from '../middleware/auth';
import { phoneSchema } from '../lib/common';
import { NOTIFICATION_DEFAULTS, resolvePrefs, type NotificationPrefKey } from '../services/notify';

const r = Router();
const PUBLIC_COLS = 'id, role, first_name, last_name, avatar_url, bio, rating_avg, rating_count, nin_verified, created_at';

r.get('/me', authenticate, async (req, res) => {
  const wallet = (await db.from('wallets').select('available_kobo').eq('user_id', req.user.id).maybeSingle()).data;
  res.json({ profile: req.user, wallet });
});

/** Settings & profile management. Role can only be (re)chosen during onboarding (e.g. after Google/Apple sign-in). */
r.patch('/me', authenticate, async (req, res) => {
  const optText = (max: number) => z.string().trim().max(max).nullable().optional();
  const b = z.object({
    firstName: z.string().min(2).optional(), lastName: z.string().min(2).optional(),
    avatarUrl: z.string().url().nullable().optional(), bio: z.string().max(300).optional(),
    role: z.enum(['tenant', 'landlord', 'estate_manager', 'artisan', 'agent']).optional(),
    onboardingCompleted: z.boolean().optional(),
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, '3–30 characters: letters, numbers, dots, dashes or underscores').nullable().optional(),
    /** Website: WhatsApp number, social links, professional details, and a phone number that is not verified yet. */
    whatsapp: optText(20), phone: optText(20),
    socials: z.record(z.string().max(300)).optional(), professional: z.record(z.unknown()).optional(),
    gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']).nullable().optional(),
    dateOfBirth: z.string().date().nullable().optional(),
    agencyName: optText(120), licenseNumber: optText(60), location: optText(80),
  }).parse(req.body);
  if (b.role && req.user.onboarding_completed && b.role !== req.user.role) throw forbidden('Role cannot be changed after onboarding');
  if (b.dateOfBirth && b.dateOfBirth > new Date().toISOString().slice(0, 10)) throw badRequest('Date of birth cannot be in the future');
  if (b.username) {
    const { data: taken } = await db.from('profiles').select('id').ilike('username', b.username).neq('id', req.user.id).maybeSingle();
    if (taken) throw conflict('That username is taken', 'USERNAME_TAKEN');
  }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.firstName) patch.first_name = b.firstName;
  if (b.lastName) patch.last_name = b.lastName;
  if (b.avatarUrl !== undefined) patch.avatar_url = b.avatarUrl;
  if (b.bio !== undefined) patch.bio = b.bio;
  if (b.role) patch.role = b.role;
  if (b.onboardingCompleted) patch.onboarding_completed = true;
  if (b.username !== undefined) patch.username = b.username || null;
  if (b.gender !== undefined) patch.gender = b.gender;
  if (b.dateOfBirth !== undefined) patch.date_of_birth = b.dateOfBirth;
  if (b.agencyName !== undefined) patch.agency_name = b.agencyName || null;
  if (b.licenseNumber !== undefined) patch.license_number = b.licenseNumber || null;
  if (b.location !== undefined) patch.location = b.location || null;
  if (b.whatsapp !== undefined) patch.whatsapp = b.whatsapp || null;
  if (b.socials) patch.socials = b.socials;
  if (b.professional) patch.professional = b.professional;
  // A verified phone is the sign-in number and only changes through the OTP flow.
  if (b.phone !== undefined && b.phone !== req.user.phone) {
    if (req.user.phone_verified) throw badRequest('Your phone number is verified. Change it in the RentCreeb app.', 'PHONE_LOCKED');
    const phone = b.phone ? phoneSchema.safeParse(b.phone) : null;
    if (phone && !phone.success) throw badRequest('Enter a valid Nigerian phone number', 'INVALID_PHONE');
    if (phone?.success) {
      const { data: used } = await db.from('profiles').select('id').eq('phone', phone.data).neq('id', req.user.id).maybeSingle();
      if (used) throw conflict('This phone number is already linked to another account.', 'PHONE_IN_USE');
    }
    patch.phone = phone?.success ? phone.data : null; patch.phone_verified = false;
  }
  res.json({ profile: unwrap(await db.from('profiles').update(patch).eq('id', req.user.id).select().single()) });
});

/**
 * Settings → Delete Account. Deactivates and anonymises rather than hard-deleting, so payments, tenancies,
 * bookings and reviews that other users depend on stay intact. Sign-in is blocked by banning the auth user.
 */
r.delete('/me', authenticate, async (req, res) => {
  z.object({ confirm: z.literal('DELETE') }).parse(req.body ?? {});
  await closeAccount(req.user.id);
  await db.auth.admin.signOut(req.headers.authorization!.slice(7), 'global');
  res.status(204).end();
});

/** Settings → Notification Settings. Returns the full resolved map (defaults + saved overrides). */
r.get('/me/notification-prefs', authenticate, async (req, res) => {
  res.json({ prefs: resolvePrefs((req.user as any).notification_prefs) });
});

r.put('/me/notification-prefs', authenticate, async (req, res) => {
  const keys = Object.keys(NOTIFICATION_DEFAULTS) as [NotificationPrefKey, ...NotificationPrefKey[]];
  const b = z.record(z.enum(keys), z.boolean()).parse(req.body?.prefs ?? {});
  const merged = { ...((req.user as any).notification_prefs ?? {}), ...b };
  await db.from('profiles').update({ notification_prefs: merged, updated_at: new Date().toISOString() }).eq('id', req.user.id);
  res.json({ prefs: resolvePrefs(merged) });
});

r.put('/me/push-token', authenticate, async (req, res) => {
  const { token } = z.object({ token: z.string().nullable() }).parse(req.body);
  await db.from('profiles').update({ expo_push_token: token }).eq('id', req.user.id);
  res.status(204).end();
});

r.get('/:id', async (req, res) => {
  const { data } = await db.from('profiles').select(PUBLIC_COLS).eq('id', req.params.id).maybeSingle();
  if (!data) throw notFound('User not found');
  // Chat reply speed for people tenants message about listings.
  const rt = ['agent', 'landlord', 'estate_manager'].includes((data as any).role) ? await responseTime((data as any).id).catch(() => null) : null;
  res.json({ profile: { ...(data as object), responseTime: rt } });
});

export default r;
