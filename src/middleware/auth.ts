import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db } from '../lib/supabase';
import { forbidden, HttpError, unauthorized } from '../lib/errors';
import { markSeen } from '../services/presence';

type Role = Profile['role'];

/**
 * Verified access tokens, remembered for 30 seconds (never past the token's own expiry) so a burst of API calls doesn't
 * ask Supabase Auth about the same token every time: that check is a network round trip on each request.
 * Only the token check is cached; the profile (role, suspension) is still read fresh on every request.
 */
type Verified = { id: string; webEmailConfirmed: boolean; until: number };
const verified = new Map<string, Verified>();
const TOKEN_TTL = 30_000;
const keyOf = (token: string) => createHash('sha256').update(token).digest('base64url');
function tokenExpiry(token: string) {
  try { return Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp) * 1000 || 0; } catch { return 0; }
}
async function verifyToken(token: string): Promise<Verified | null> {
  const k = keyOf(token); const hit = verified.get(k);
  if (hit && hit.until > Date.now()) return hit;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) { verified.delete(k); return null; }
  const v = { id: data.user.id, webEmailConfirmed: data.user.user_metadata?.signup_source === 'website' && !!data.user.email_confirmed_at,
    until: Math.min(Date.now() + TOKEN_TTL, tokenExpiry(token) || Date.now() + TOKEN_TTL) };
  if (verified.size > 5000) for (const [key, x] of verified) if (x.until <= Date.now() || verified.size > 4000) verified.delete(key);
  verified.set(k, v);
  return v;
}
/** Forget a token at sign-out so it stops working at once, not up to 30 seconds later. */
export const forgetToken = (token: string) => { verified.delete(keyOf(token)); };

/** Verifies the Supabase access token, then loads the profile. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw unauthorized('Missing bearer token');
  const v = await verifyToken(token);
  if (!v) throw unauthorized('Invalid or expired token');
  const { data: profile } = await db.from('profiles').select('*').eq('id', v.id).maybeSingle();
  if (!profile) throw new HttpError(403, 'Profile not found', 'NO_PROFILE');
  if (profile.is_suspended) throw forbidden('Account suspended', 'SUSPENDED');
  req.user = profile as Profile;
  req.webEmailConfirmed = v.webEmailConfirmed;
  markSeen(profile.id);
  next();
}

/** Attaches req.user when a valid bearer token is sent; otherwise continues anonymously (public endpoints). */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (token) {
    const v = await verifyToken(token);
    if (v) {
      const { data: profile } = await db.from('profiles').select('*').eq('id', v.id).maybeSingle();
      if (profile && !profile.is_suspended) req.user = profile as Profile;
    }
  }
  next();
}

export const requireRole = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!roles.includes(req.user.role)) throw forbidden(`Requires role: ${roles.join(' or ')}`);
  next();
};

/** Phone verified (partially verified or better). */
export function requirePhoneVerified(req: Request, _res: Response, next: NextFunction) {
  // Website accounts (email + password, no phone at sign-up) count as verified once their email is confirmed.
  if (!req.user.phone_verified && !req.webEmailConfirmed) throw forbidden('Verify your phone number first', 'PHONE_VERIFICATION_REQUIRED');
  next();
}

/** NIN + selfie verified: required to book, pay, review and list. */
export function requireVerified(req: Request, _res: Response, next: NextFunction) {
  if (req.user.verification_status !== 'verified')
    throw forbidden('Identity verification required', 'VERIFICATION_REQUIRED');
  next();
}
