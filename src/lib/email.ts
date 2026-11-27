import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from './logger';

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
export const emailEnabled = () => !!resend;

export type EmailMessage = {
  to: string; subject: string; html: string; text?: string;
  /** Display name to send as, keeping the address from EMAIL_FROM ("RentCreeb Deals" <no-reply@…>). */
  fromName?: string; replyTo?: string; headers?: Record<string, string>;
};

/** EMAIL_FROM with a different display name. */
export function fromAddress(name?: string | null) {
  if (!name?.trim()) return env.EMAIL_FROM;
  const addr = /<([^>]+)>/.exec(env.EMAIL_FROM)?.[1] ?? env.EMAIL_FROM;
  return `${name.trim().replace(/["<>]/g, '')} <${addr}>`;
}

const payload = (m: EmailMessage) => ({
  from: fromAddress(m.fromName), to: m.to, subject: m.subject, html: m.html,
  ...(m.text ? { text: m.text } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.headers ? { headers: m.headers } : {}),
});

/** Transactional email. Never throws (logs instead). */
/** Never throws; resolves true when the provider accepted the email. */
export async function sendEmail(to: string, subject: string, html: string, extra: Omit<EmailMessage, 'to' | 'subject' | 'html'> = {}): Promise<boolean> {
  if (!resend) { logger.debug({ to, subject }, '[DEV EMAIL skipped]'); return false; }
  try {
    const { error } = await resend.emails.send(payload({ to, subject, html, ...extra }) as any);
    if (error) { logger.error({ err: error, subject }, 'email failed'); return false; }
    return true;
  } catch (err) { logger.error({ err }, 'email failed'); return false; }
}

/** Up to 100 emails in one API call. Returns the provider id per message (same order) or throws. */
export async function sendEmailBatch(messages: EmailMessage[]): Promise<string[]> {
  if (!resend) throw new Error('Email is not configured (RESEND_API_KEY)');
  if (!messages.length) return [];
  const { data, error } = await resend.batch.send(messages.map(payload) as any);
  if (error) throw Object.assign(new Error(error.message), { statusCode: (error as any).statusCode, name: (error as any).name });
  return (data?.data ?? []).map((d) => d.id);
}
