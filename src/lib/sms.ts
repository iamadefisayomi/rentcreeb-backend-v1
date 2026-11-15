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

async function sendViaSmartSms(to: string, message: string) {
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
  if (r.status === 'SUCCESS') { logger.debug({ to: msidn.slice(-4), totalsent: r.totalsent, cost: r.cost }, 'sms sent (smartsms)'); return; }
  if (json) logger.error({ status: r.status, to: msidn.slice(-4) }, r.status === 'INSUFFICIENT_CREDIT'
    ? 'SmartSMS credit is too low: top up to resume SMS'
    : 'SmartSMS did not send the message');
}

export async function sendSms(to: string, message: string) {
  try {
    if (smartReady()) return await sendViaSmartSms(to, message);
    if (at) {
      const res = await at.SMS.send({ to: [to], message, ...(env.AT_SENDER_ID ? { from: env.AT_SENDER_ID } : {}) });
      logger.debug({ res }, 'sms sent (africastalking)');
      return;
    }
    if (isProd) logger.error('No SMS provider configured (set SMARTSMS_USERNAME and SMARTSMS_API_KEY); SMS not sent');
    else logger.info({ to, message }, '[DEV SMS]');
  } catch (err) {
    logger.error({ err }, 'sms failed');
  }
}

/** Startup self-check (free): shows a wrong key, a blocked server or low credit in the logs right away. */
export async function checkSmsCredentials() {
  if (!smartReady()) return;
  try {
    const res = await fetch(`${SMARTSMS}/balance/${encodeURIComponent(env.SMARTSMS_USERNAME!)}/${encodeURIComponent(env.SMARTSMS_API_KEY!)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (/sgcaptcha|Robot Challenge/i.test(text) || res.status === 202) {
      logger.error({ status: res.status }, 'SmartSMS bot check blocked this server: ask SmartSMS support to allowlist API calls');
      return;
    }
    let body: any = text.trim();
    try { body = JSON.parse(text); } catch { /* plain-text balance */ }
    const status = body?.response?.status ?? (typeof body === 'string' && /AUTH_FAILURE/.test(body) ? 'AUTH_FAILURE' : undefined);
    if (status === 'AUTH_FAILURE') logger.error('SmartSMS username/API key REJECTED: SMS will not send until they are fixed');
    else logger.info({ balance: body?.response?.balance ?? body?.balance ?? body, sender: env.SMARTSMS_SENDER_ID }, 'SmartSMS credentials OK');
  } catch (err) { logger.warn({ err }, 'SmartSMS credential check could not reach SmartSMS'); }
}
