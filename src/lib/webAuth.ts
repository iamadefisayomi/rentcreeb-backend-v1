import { createHmac, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { env } from '../config/env';

const scrypt = promisify(scryptCb) as (pw: string, salt: string, len: number, opts: object) => Promise<Buffer>;

/**
 * Passwords imported from the old website (better-auth): "<hex salt>:<hex key>", scrypt N=16384 r=16 p=1 dkLen=64,
 * with the salt string itself (not its bytes) as the salt and the password NFKC-normalised.
 */
export async function verifyBetterAuthHash(password: string, hash: string) {
  const [salt, key] = hash.split(':');
  if (!salt || !key || !/^[0-9a-f]+$/i.test(key)) return false;
  const want = Buffer.from(key, 'hex');
  const got = await scrypt(password.normalize('NFKC'), salt, want.length, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 });
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Signed, expiring links for the website's emails (confirm email, reset password, change email). No table needed:
 * the token carries purpose, user, expiry and a "version" (e.g. the auth user's updated_at) so a reset link stops
 * working once the password has changed.
 */
type Purpose = 'confirm' | 'reset' | 'email';
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (body: string) => createHmac('sha256', `${env.OTP_PEPPER}:web-links`).update(body).digest('base64url');

export function makeLinkToken(purpose: Purpose, userId: string, ttlSeconds: number, version = '', extra = '') {
  const body = b64(JSON.stringify({ p: purpose, u: userId, e: Math.floor(Date.now() / 1000) + ttlSeconds, v: version, x: extra }));
  return `${body}.${sign(body)}`;
}

export function readLinkToken(token: string, purpose: Purpose): { userId: string; version: string; extra: string } | null {
  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body)); const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (d.p !== purpose || typeof d.u !== 'string' || d.e < Date.now() / 1000) return null;
    return { userId: d.u, version: d.v ?? '', extra: d.x ?? '' };
  } catch { return null; }
}

/** Website origins allowed as OAuth / payment / email-link destinations. */
export function webOrigins() {
  const list = [env.WEB_BASE_URL, ...String(env.WEB_ORIGINS ?? '').split(',')].map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (env.NODE_ENV !== 'production') list.push('http://localhost:3000');
  return [...new Set(list)];
}
export const isWebUrl = (u: string) => { try { const o = new URL(u).origin; return webOrigins().includes(o); } catch { return false; } };

/** Strip phone numbers from enquiry messages (the website did this so deals stay in the app). */
export const removePhoneNumbers = (s: string) => s.replace(/(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,4}\d{2,4}/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '[removed]' : m));
