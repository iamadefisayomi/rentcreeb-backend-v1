import { randomUUID } from 'crypto';
import AfricasTalking from 'africastalking';
import { env, isProd } from '../config/env';
import { logger } from './logger';

/**
 * SMS goes through SmartSMS Nigeria's JSON API (https://www.smartsms.ng/pages/json-api) when
 * SMARTSMS_USERNAME + SMARTSMS_API_KEY are set. Africa's Talking is the fallback when only AT_API_KEY is set.
 * With neither, SMS is printed to the log in development.
 */
const SMARTSMS = 'https://www.smartsms.ng/api';
const smartReady = () => !!(env.SMARTSMS_USERNAME && env.SMARTSMS_API_KEY);
const at = !smartReady() && env.AT_API_KEY ? AfricasTalking({ apiKey: env.AT_API_KEY, username: env.AT_USERNAME }) : null;

/** SmartSMS wants full international format without "+": 2348012345678. */
export function toIntl(phone: string) {
  const d = phone.replace(/\D/g, '');
  if (/^2340\d{10}$/.test(d)) return '234' + d.slice(4); // "+234 0803…" typed with the trunk 0
  if (d.startsWith('234')) return d;
  if (d.startsWith('0') && d.length === 11) return '234' + d.slice(1);
  if (d.length === 10) return '234' + d;
  return d;
}

/** The host sits behind a bot check; if that page comes back instead of JSON, say so plainly in the logs. */
async function readJson(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch {
    const blocked = /sgcaptcha|Robot Challenge/i.test(text) || res.status === 202;
    logger.error({ status: res.status, blocked }, blocked
      ? 'SmartSMS returned its bot-check page instead of the API: ask SmartSMS support to allowlist API calls from this server'
      : 'SmartSMS returned a non-JSON response');
    return null;
  }
}

export type SmsResult = { ok: boolean; provider: 'smartsms' | 'africastalking' | 'none'; status?: string; detail?: unknown };

async function sendViaSmartSms(to: string, message: string): Promise<SmsResult> {
  const msidn = toIntl(to);
  const res = await fetch(`${SMARTSMS}/sendsms.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      SMS: {
        auth: { username: env.SMARTSMS_USERNAME, apikey: env.SMARTSMS_API_KEY },
        message: { sender: env.SMARTSMS_SENDER_ID, messagetext: message, flash: '0' },
        recipients: { gsm: [{ msidn, msgid: randomUUID().replace(/-/g, '') }] },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await readJson(res);
  const r = json?.response ?? {};
  if (r.status === 'SUCCESS') {
    logger.info({ to: msidn.slice(-4), totalsent: r.totalsent, cost: r.cost }, 'sms sent (smartsms)');
    return { ok: true, provider: 'smartsms', status: r.status, detail: { totalsent: r.totalsent, cost: r.cost } };
  }
  if (json) logger.error({ status: r.status, to: msidn.slice(-4) }, r.status === 'INSUFFICIENT_CREDIT'
    ? 'SmartSMS credit is too low: top up to resume SMS'
    : 'SmartSMS did not send the message');
  return { ok: false, provider: 'smartsms', status: json ? r.status ?? 'UNKNOWN' : 'NON_JSON_RESPONSE', detail: json ? undefined : { httpStatus: res.status } };
}

/** Never throws: SMS problems are logged (and returned) but don't break the request that triggered them. */
export async function sendSms(to: string, message: string): Promise<SmsResult> {
  try {
    if (smartReady()) return await sendViaSmartSms(to, message);
    if (at) {
      const res = await at.SMS.send({ to: [to], message, ...(env.AT_SENDER_ID ? { from: env.AT_SENDER_ID } : {}) });
      logger.info({ res }, 'sms sent (africastalking)');
      return { ok: true, provider: 'africastalking', detail: res };
    }
    if (isProd) logger.error('No SMS provider configured (set SMARTSMS_USERNAME and SMARTSMS_API_KEY); SMS not sent');
    else logger.info({ to, message }, '[DEV SMS]');
    return { ok: false, provider: 'none', status: 'NOT_CONFIGURED' };
  } catch (err) {
    logger.error({ err }, 'sms failed');
    return { ok: false, provider: smartReady() ? 'smartsms' : at ? 'africastalking' : 'none', status: 'EXCEPTION', detail: String((err as Error)?.message ?? err) };
  }
}

/** What's configured (no secrets): for the protected diagnostics route. */
export function smsConfigSummary() {
  return {
    provider: smartReady() ? 'smartsms' : at ? 'africastalking' : 'none',
    smartsmsUsernameSet: !!env.SMARTSMS_USERNAME, smartsmsApiKeySet: !!env.SMARTSMS_API_KEY, senderId: env.SMARTSMS_SENDER_ID,
  };
}

export type SmsHealth = { ok: boolean; state: 'ok' | 'blocked' | 'auth_failure' | 'unreachable' | 'not_configured'; provider: string; balance?: unknown; detail?: string };

/** Free check against SmartSMS's balance endpoint: wrong key, blocked server (bot check) or credit. */
export async function smsHealth(): Promise<SmsHealth> {
  if (!smartReady()) return at ? { ok: true, state: 'ok', provider: 'africastalking', detail: 'Africa’s Talking configured (not checked)' } : { ok: false, state: 'not_configured', provider: 'none' };
  try {
    const res = await fetch(`${SMARTSMS}/balance/${encodeURIComponent(env.SMARTSMS_USERNAME!)}/${encodeURIComponent(env.SMARTSMS_API_KEY!)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (/sgcaptcha|Robot Challenge/i.test(text) || res.status === 202)
      return { ok: false, state: 'blocked', provider: 'smartsms', detail: 'SmartSMS’s bot check is blocking this server. Ask SmartSMS support to allowlist API calls from it.' };
    let body: any = text.trim();
    try { body = JSON.parse(text); } catch { /* plain-text balance */ }
    const status = body?.response?.status ?? (typeof body === 'string' && /AUTH_FAILURE/.test(body) ? 'AUTH_FAILURE' : undefined);
    if (status === 'AUTH_FAILURE') return { ok: false, state: 'auth_failure', provider: 'smartsms', detail: 'Username or API key rejected' };
    return { ok: true, state: 'ok', provider: 'smartsms', balance: body?.response?.balance ?? body?.balance ?? body };
  } catch (err) { return { ok: false, state: 'unreachable', provider: 'smartsms', detail: String((err as Error)?.message ?? err) }; }
}

/** Startup self-check (free): shows a wrong key, a blocked server or low credit in the logs right away. */
export async function checkSmsCredentials() {
  if (!smartReady()) return;
  const h = await smsHealth();
  if (h.state === 'blocked') logger.error('SmartSMS bot check blocked this server: ask SmartSMS support to allowlist API calls');
  else if (h.state === 'auth_failure') logger.error('SmartSMS username/API key REJECTED: SMS will not send until they are fixed');
  else if (h.state === 'unreachable') logger.warn({ detail: h.detail }, 'SmartSMS credential check could not reach SmartSMS');
  else logger.info({ balance: h.balance, sender: env.SMARTSMS_SENDER_ID }, 'SmartSMS credentials OK');
}
