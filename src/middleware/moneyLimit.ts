import rateLimit from 'express-rate-limit';

/**
 * Per-account limit on endpoints that move or request money (top-ups, withdrawals, bill purchases, payout account).
 * The app-wide limiter is per IP; this one follows the signed-in user, so many IPs (or one shared NAT) can't be used to
 * hammer payments. Mount after `authenticate`. Read-only (GET) requests are not counted.
 */
export const moneyLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET',
  keyGenerator: (req: any) => `money:${req.user?.id ?? req.ip}`,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many payment requests. Please wait a few minutes and try again.' } },
});

/** Tighter limit for withdrawals and payout-account changes. */
export const payoutLimit = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => `payout:${req.user?.id ?? req.ip}`,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many withdrawal attempts. Please try again later.' } },
});
