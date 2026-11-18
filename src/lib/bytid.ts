import { env } from '../config/env';
import { HttpError } from './errors';
import { logger } from './logger';

export interface NinSelfieResult {
  match: boolean;
  confidence: number;
  firstName?: string;
  lastName?: string;
  raw: unknown;
  /** The whole provider response for the admin reviewer, with every picture replaced by a placeholder (pictures are in `images`). */
  response: Record<string, unknown>;
  /** Pictures found in the response (the NIMC ID photo, a signature …): base64 data or a link, by the field they came from. */
  images: NimcImage[];
}
export type NimcImage = { field: string; base64?: string; url?: string };

const IMAGE_KEY = /photo|image|picture|portrait|face|signature|selfie/i;
const looksBase64Image = (v: string) => /^data:image\//i.test(v) || (v.length > 800 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 2000)));
const looksImageUrl = (v: string) => /^https?:\/\//i.test(v);

/** Copy of the response with pictures taken out (they are stored as files, not as JSON), plus the pictures themselves. */
export function splitImages(value: unknown, path = ''): { clean: unknown; images: NimcImage[] } {
  const images: NimcImage[] = [];
  const walk = (v: unknown, p: string, key: string): unknown => {
    if (typeof v === 'string') {
      if (looksBase64Image(v) && (IMAGE_KEY.test(key) || v.length > 5000)) { images.push({ field: p, base64: v.replace(/^data:image\/\w+;base64,/i, '') }); return '[picture: shown above]'; }
      if (IMAGE_KEY.test(key) && looksImageUrl(v)) { images.push({ field: p, url: v }); return '[picture: shown above]'; }
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${p}[${i}]`, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, p ? `${p}.${k}` : k, k)]));
    return v;
  };
  return { clean: walk(value, path, ''), images };
}

const authHeaders = () => ({ Authorization: `Bearer ${env.BYTID_API_KEY}` });
const keyMode = () => (env.BYTID_API_KEY.startsWith('uvk_live_') ? 'live' : env.BYTID_API_KEY.startsWith('uvk_test_') ? 'test' : 'unknown');

const providerDown = () =>
  new HttpError(503, 'Identity verification is temporarily unavailable. You can request a manual review instead.', 'VERIFICATION_PROVIDER_ERROR');

/** For the admin System page: key mode and wallet balance (free endpoint). */
export async function bytidHealth(): Promise<{ ok: boolean; mode: string; balance?: unknown; currency?: string; detail?: string }> {
  try {
    const res = await fetch(`${env.BYTID_BASE_URL}/balance`, { headers: authHeaders(), signal: AbortSignal.timeout(15_000) });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, mode: keyMode(), balance: json?.data?.balance, currency: json?.data?.currency };
    return { ok: false, mode: keyMode(), detail: `Rejected (${res.status}${json?.error?.code ? ' ' + json.error.code : ''})` };
  } catch (err) { return { ok: false, mode: keyMode(), detail: String((err as Error)?.message ?? err) }; }
}

/** Startup self-check against Bytid's free balance endpoint, so bad keys show in the logs immediately — not on a user's first attempt. */
export async function checkBytidCredentials() {
  try {
    const res = await fetch(`${env.BYTID_BASE_URL}/balance`, { headers: authHeaders(), signal: AbortSignal.timeout(15_000) });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) logger.info({ mode: keyMode(), balance: json?.data?.balance, currency: json?.data?.currency }, 'Bytid credentials OK');
    else logger.error({ status: res.status, code: json?.error?.code, mode: keyMode() }, 'Bytid credentials REJECTED — NIN verification will fail until BYTID_API_KEY is fixed');
  } catch (err) { logger.warn({ err }, 'Bytid credential check could not reach Bytid'); }
}

/**
 * Bytid NIN + selfie face match.
 * Docs: https://www.bytid.com/docs  (POST /v1/identity/nin/face-match  { id_number, selfie_image(base64) })
 * A check that ran always returns HTTP 200 — the outcome is in data.status (verified | not_found | failed)
 * and data.face_match.status (matched | not_matched | unavailable), score 0–100.
 * Sandbox (uvk_test_ key): NIN ending 00 → not_found, 99 → failed, 98 → face not_matched, anything else → matched.
 */
export async function verifyNinWithSelfie(nin: string, selfieBase64: string): Promise<NinSelfieResult> {
  let res: Response;
  try {
    res = await fetch(`${env.BYTID_BASE_URL}/identity/nin/face-match`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_number: nin, selfie_image: selfieBase64 }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new HttpError(504, 'Verification is taking too long. Try again shortly.', 'VERIFICATION_TIMEOUT');
  }
  const json: any = await res.json().catch(() => ({}));
  const errCode: string | undefined = json?.error?.code;

  if (!res.ok) {
    // None of these are the user's fault, so they must never count as one of their attempts.
    if (res.status === 401 || res.status === 403) {
      logger.error({ status: res.status, code: errCode, mode: keyMode(), requestId: json?.request_id }, 'Bytid rejected BYTID_API_KEY — check the key, its scopes (identity) and IP allowlist in the Bytid dashboard');
      throw providerDown();
    }
    if (res.status === 402) {
      logger.error({ code: errCode, requestId: json?.request_id }, 'Bytid wallet balance is too low — top up to resume NIN verification');
      throw providerDown();
    }
    if (res.status === 400) {
      logger.warn({ code: errCode, error: json?.error?.message, requestId: json?.request_id }, 'Bytid rejected the NIN request');
      throw new HttpError(422, 'We could not read that selfie. Retake it in good light and try again.', 'SELFIE_INVALID');
    }
    logger.warn({ status: res.status, code: errCode, requestId: json?.request_id }, 'Bytid NIN verify failed');
    throw new HttpError(502, 'Verification provider unavailable. Try again shortly.', 'VERIFICATION_PROVIDER_ERROR');
  }

  // Docs show an envelope { success, data: { status, face_match, data: {names} }, request_id }; tolerate an unwrapped body too.
  const data = json?.data?.status ? json.data : json;
  if (data.status === 'not_found') throw new HttpError(422, 'NIN not found', 'NIN_NOT_FOUND');
  if (data.status !== 'verified') {
    logger.warn({ status: data.status, requestId: json?.request_id }, 'Bytid NIN check did not complete');
    throw new HttpError(502, 'Verification provider unavailable. Try again shortly.', 'VERIFICATION_PROVIDER_ERROR');
  }

  const fm = data.face_match ?? {};
  if (fm.status === 'unavailable' || !fm.status) {
    // NIMC had no usable photo, or the face service was down — not a mismatch, so don't burn an attempt.
    logger.warn({ reason: fm.reason, requestId: json?.request_id }, 'Bytid face match unavailable');
    throw new HttpError(502, 'We could not compare your selfie right now. Try again shortly or request a manual review.', 'VERIFICATION_PROVIDER_ERROR');
  }

  const record = data.data ?? {};
  // Everything Bytid sent back, for the admin reviewer only (stored privately, deleted with the other ID evidence).
  const { clean, images } = splitImages(json);
  logger.info({ faceMatch: fm.status, score: fm.score, mode: keyMode(), requestId: json?.request_id }, 'Bytid face match result');
  return {
    match: fm.status === 'matched',
    confidence: Number(fm.score ?? 0),
    firstName: record.first_name,
    lastName: record.last_name,
    raw: { face_match: fm, request_id: json.request_id },
    response: (clean ?? {}) as Record<string, unknown>,
    images,
  };
}
