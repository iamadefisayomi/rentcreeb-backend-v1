import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error';

import authRoutes from './routes/auth.routes';
import usersRoutes from './routes/users.routes';
import verificationRoutes from './routes/verification.routes';
import uploadsRoutes from './routes/uploads.routes';
import notificationsRoutes from './routes/notifications.routes';
import propertiesRoutes from './routes/properties.routes';
import bookingsRoutes from './routes/bookings.routes';
import reviewsRoutes from './routes/reviews.routes';
import reportsRoutes from './routes/reports.routes';
import chatRoutes from './routes/chat.routes';
import callsRoutes from './routes/calls.routes';
import paymentsRoutes, { webhookRouter } from './routes/payments.routes';
import subscriptionsRoutes from './routes/subscriptions.routes';
import walletRoutes from './routes/wallet.routes';
import tenanciesRoutes from './routes/tenancies.routes';
import rentsaveRoutes from './routes/rentsave.routes';
import maintenanceRoutes from './routes/maintenance.routes';
import { getSettings } from './services/settings';
import jobsRoutes from './routes/jobs.routes';
import artisanRoutes from './routes/artisan.routes';
import dashboardRoutes from './routes/dashboard.routes';
import adminRoutes from './routes/admin.routes';
import webRoutes from './routes/web.routes';
import supportRoutes from './routes/support.routes';
import documentsRoutes from './routes/documents.routes';
import keepAliveRoutes from './routes/keep-alive.routes';
import mailRoutes from './routes/mail.routes';
import assistantRoutes from './routes/assistant.routes';
import tenancyExtrasRoutes from './routes/tenancyExtras.routes';
import savedSearchesRoutes from './routes/savedSearches.routes';
import { listingTools, sharePages } from './routes/listingTools.routes';
import { rentRules, verifyPages } from './routes/rentRules.routes';
import screeningRoutes from './routes/screening.routes';
import roommatesRoutes from './routes/roommates.routes';
import billsRoutes from './routes/bills.routes';
import utilitiesRoutes from './routes/utilities.routes';
import { developmentsRouter, developerRouter, investorRouter } from './routes/developments.routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',') }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' || !!req.url?.startsWith('/api/v1/cron/keep-alive') } }));
  // Keep the raw body: Paystack webhook signatures are computed over it.
  app.use(express.json({ limit: '1mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Logo in the header of mailing emails (services/mailing.ts). Served before the admin's helmet so webmail on other
  // origins may load it (helmet's default Cross-Origin-Resource-Policy is same-origin).
  app.get('/admin/logo-email.png', (_req, res) => {
    res.set({ 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'public, max-age=604800' });
    res.sendFile(path.resolve(__dirname, '..', 'admin', 'logo-email.png'));
  });
  // Admin dashboard (static files in backend/admin). It calls /api/v1/admin/* on this same origin, so no CORS.
  // Own CSP: scripts/styles only from here; images from https (listing photos, avatars, evidence on the CDN).
  app.use('/admin', helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:', 'https:'], // blob: = preview of a photo before it is sent
      connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"],
    } },
    referrerPolicy: { policy: 'no-referrer' },
  }), express.static(path.resolve(__dirname, '..', 'admin'), {
    index: 'index.html', maxAge: '5m',
    // The page and its script are re-checked on every load (cheap 304s via ETag), so a deploy reaches admins at once
    // instead of an old admin.js running for up to 5 minutes. Images and fonts keep the 5-minute cache.
    setHeaders: (res, file) => { if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
  }));

  const general = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const strict = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

  app.use('/webhooks', webhookRouter);
  // Links inside emails (unsubscribe, tracking), the sign-up form and the Resend webhook. Own limits inside.
  app.use('/mail', mailRoutes);
  // Before the rate limiter, so a scheduler's pings never get throttled.
  app.use('/api/v1/cron', keepAliveRoutes);
  app.use(general);
  // Public pages: shared listing links (with QR) and rental-certificate checks.
  app.use('/p', sharePages);
  app.use('/verify', verifyPages);

  const v1 = express.Router();
  /**
   * Public client config. The Supabase URL + anon key are public by design (Row Level Security protects data);
   * the app uses them for Realtime with the user's own access token.
   */
  v1.get('/config', async (_req, res) => {
    const s = await getSettings();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ realtime: { url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY }, vatPct: env.VAT_PCT, banner: s.banner, maintenance: s.maintenanceMode });
  });
  v1.use('/auth', strict, authRoutes);
  v1.use('/users', usersRoutes);
  v1.use('/verification', verificationRoutes);
  v1.use('/uploads', uploadsRoutes);
  v1.use('/notifications', notificationsRoutes);
  v1.use('/properties', propertiesRoutes);
  v1.use('/listings', listingTools);
  v1.use('/rent-rules', rentRules);
  v1.use('/bookings', bookingsRoutes);
  v1.use('/reviews', reviewsRoutes);
  v1.use('/reports', reportsRoutes);
  v1.use('/conversations', chatRoutes);
  v1.use('/calls', callsRoutes);
  v1.use('/payments', paymentsRoutes);
  v1.use('/subscriptions', subscriptionsRoutes);
  v1.use('/wallet', walletRoutes);
  v1.use('/tenancies', tenancyExtrasRoutes); // instalments, receipts, history, condition reports, agreements (before /:id)
  v1.use('/tenancies', tenanciesRoutes);
  v1.use('/saved-searches', savedSearchesRoutes);
  v1.use('/screening', screeningRoutes);
  v1.use('/roommates', roommatesRoutes);
  v1.use('/bills', billsRoutes);
v1.use('/developments', developmentsRouter); // property development projects (developers & investors)
v1.use('/developer', developerRouter);
v1.use('/investor', investorRouter);
v1.use('/utilities', utilitiesRoutes); // airtime, data, electricity, TV, internet, exam PINs (VTpass)
  v1.use('/rentsave', rentsaveRoutes);
  v1.use('/maintenance', maintenanceRoutes);
  v1.use('/jobs', jobsRoutes);
  v1.use('/artisan', artisanRoutes);
  v1.use('/dashboard', dashboardRoutes);
  v1.use('/support', supportRoutes);
  v1.use('/assistant', assistantRoutes);
  v1.use('/documents', documentsRoutes);
  v1.use('/web', strict, webRoutes); // rentcreeb.com website: email sign-up, reset links, waitlist
  v1.use('/admin', adminRoutes);
  // Maintenance mode (env MAINTENANCE_MODE or the admin dashboard switch). Admins can still sign in and work.
  const MAINTENANCE_OPEN = /^\/(admin|auth\/(login|refresh|logout)|users\/me$|config$)/;
  app.use('/api/v1', async (req, res, next) => {
    if (MAINTENANCE_OPEN.test(req.path)) return next();
    const s = await getSettings().catch(() => null);
    if (!s?.maintenanceMode) return next();
    res.status(503).json({ error: { code: 'MAINTENANCE', message: s.maintenanceMessage } });
  }, v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
