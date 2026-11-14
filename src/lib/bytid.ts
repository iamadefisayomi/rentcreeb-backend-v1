import { env } from '../config/env';
import { HttpError } from './errors';
import { logger } from './logger';

export interface NinSelfieResult {
  match: boolean;
  confidence: number;
  firstName?: string;
  lastName?: string;
  raw: unknown;
}

const authHeaders = () => ({ Authorization: `Bearer ${env.BYTID_API_KEY}` });
const keyMode = () => (env.BYTID_API_KEY.startsWith('uvk_live_') ? 'live' : env.BYTID_API_KEY.startsWith('uvk_test_') ? 'test' : 'unknown');

const providerDown = () =>
  new HttpError(503, 'Identity verification is temporarily unavailable. You can request a manual review instead.', 'VERIFICATION_PROVIDER_ERROR');

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
  return {
    match: fm.status === 'matched',
    confidence: Number(fm.score ?? 0),
    firstName: record.first_name,
    lastName: record.last_name,
    raw: { face_match: fm, request_id: json.request_id }, // never persist the full NIN record
  };
}
