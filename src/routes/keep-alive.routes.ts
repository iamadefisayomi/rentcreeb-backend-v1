import { Router, type Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { db } from '../lib/supabase';
import { logger } from '../lib/logger';
import { sendSms, smsConfigSummary } from '../lib/sms';

/**
 * GET /api/v1/cron/keep-alive
 *
 * Ping this from an external scheduler (e.g. cron-job.org) every 10 minutes so:
 *   - Render's free plan doesn't put the server to sleep after 15 minutes without traffic, and
 *   - Supabase's free plan doesn't pause the database after a week without activity (we run a tiny query).
 *
 * If CRON_JOB_TOKEN is set, the caller must send it as "Authorization: Bearer <token>"
 * (or ?token=<token> for schedulers that can't set headers).
 */
const r = Router();

function authorised(req: Request) {
  const expected = env.CRON_JOB_TOKEN;
  if (!expected) return true;
  const given = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? (typeof req.query.token === 'string' ? req.query.token : '');
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

r.get('/keep-alive', async (req, res) => {
  if (!authorised(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const started = Date.now();
  try {
    // A tiny real query, so the database counts as active.
    const { error } = await db.from('profiles').select('id', { head: true, count: 'exact' }).limit(1);
    if (error) throw error;
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, server: 'Online', database: 'Online', dbMs: Date.now() - started, uptimeSec: Math.round(process.uptime()) });
  } catch (err) {
    logger.error({ err }, 'keep-alive: database check failed');
    return res.status(500).json({ success: false, server: 'Online', database: 'Unreachable' });
  }
});

/**
 * POST /api/v1/cron/sms-test  { "to": "2348012345678" }
 * Sends one test SMS from this server and returns the provider's verdict. Needs CRON_JOB_TOKEN (disabled without it).
 */
r.post('/sms-test', async (req, res) => {
  if (!env.CRON_JOB_TOKEN) return res.status(404).json({ success: false, message: 'Set CRON_JOB_TOKEN to enable this route' });
  if (!authorised(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const to = String(req.body?.to ?? '').trim();
  if (!/^\+?\d{10,15}$/.test(to)) return res.status(400).json({ success: false, message: 'Send { "to": "2348012345678" }' });
  const config = smsConfigSummary();
  const result = await sendSms(to, 'RentCreeb: test message from the server. SMS is working.');
  logger.info({ to: to.slice(-4), result: { ok: result.ok, status: result.status } }, 'sms-test');
  return res.status(result.ok ? 200 : 502).json({ success: result.ok, config, result });
});

export default r;
