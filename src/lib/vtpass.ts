import { randomBytes } from 'crypto';
import { env } from '../config/env';
import { HttpError } from './errors';

/**
 * VTpass bill-payment API (https://www.vtpass.com/documentation). GET calls use api-key + public-key, POST calls use
 * api-key + secret-key. Sandbox by default (VTPASS_BASE_URL).
 */
export const vtpassReady = () => !!(env.VTPASS_API_KEY && env.VTPASS_SECRET_KEY && env.VTPASS_PUBLIC_KEY);

async function call<T = any>(path: string, body?: unknown): Promise<T> {
  if (!vtpassReady()) throw new HttpError(503, 'Bill payments are not available yet', 'UTILITIES_UNAVAILABLE');
  const headers: Record<string, string> = { 'api-key': env.VTPASS_API_KEY!, 'Content-Type': 'application/json' };
  if (body) headers['secret-key'] = env.VTPASS_SECRET_KEY!; else headers['public-key'] = env.VTPASS_PUBLIC_KEY!;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(env.VTPASS_BASE_URL + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok && !json?.code) throw new HttpError(502, json?.response_description ?? 'Bill provider error', 'VTPASS_ERROR');
    return json as T;
  } finally { clearTimeout(t); }
}

/** VTpass wants request_id to start with the Lagos date-time (YYYYMMDDHHmm, UTC+1), then anything unique. */
export function requestId() {
  const d = new Date(Date.now() + 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${randomBytes(6).toString('hex')}`;
}

export type VtVariation = { variation_code: string; name: string; variation_amount: string; fixedPrice: string };
export type VtPayResult = {
  code: string; response_description?: string; requestId?: string;
  content?: { transactions?: { status?: string; transactionId?: string; product_name?: string } ; errors?: unknown };
  purchased_code?: string; mainToken?: string; mainTokenUnits?: string | number; token?: string; units?: string | number;
  cards?: { Serial?: string; Pin?: string }[]; Pin?: string;
};

export const vtpass = {
  variations: async (serviceID: string) => {
    const j = await call<{ content?: { variations?: VtVariation[]; varations?: VtVariation[] } }>(`/service-variations?serviceID=${encodeURIComponent(serviceID)}`);
    return j.content?.variations ?? j.content?.varations ?? []; // VTpass misspells it on some services
  },
  verify: (p: { serviceID: string; billersCode: string; type?: string }) =>
    call<{ code: string; content?: Record<string, any> & { error?: string; WrongBillersCode?: boolean } }>('/merchant-verify', p),
  pay: (p: { request_id: string; serviceID: string; billersCode?: string; variation_code?: string; amount?: number; phone: string; subscription_type?: string; quantity?: number }) =>
    call<VtPayResult>('/pay', p),
  requery: (request_id: string) => call<VtPayResult>('/requery', { request_id }),
};
