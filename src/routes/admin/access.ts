import type { NextFunction, Request, Response } from 'express';
import { forbidden } from '../../lib/errors';

/**
 * Two dashboard roles:
 *   admin          — everything.
 *   admin_manager  — day-to-day moderation and support only. No money movement, finance, plans, mailing,
 *                    platform settings, announcements, the audit log, AI assistant setup, private chats,
 *                    role changes, wallet changes, closing accounts or bulk exports.
 *
 * Managers get an ALLOW-list: a route added later stays admin-only until it is listed here on purpose.
 * Paths are relative to /api/v1/admin.
 */
export const ADMIN_ROLES = ['admin', 'admin_manager'] as const;

type Rule = [methods: string, path: RegExp];
const ID = '[^/]+';
const MANAGER_ALLOW: Rule[] = [
  // platform
  ['GET', /^\/overview$/],
  ['GET', /^\/search$/],
  // people: users (no export, no wallet, no close), ID verification, artisans, notes
  ['GET', /^\/users$/],
  ['GET', /^\/users\/(?!export$)[^/]+$/], // not /users/export (bulk CSV)
  ['PATCH', new RegExp(`^/users/${ID}$`)], // role changes are refused in the handler
  ['POST', new RegExp(`^/users/${ID}/(suspend|verify|revoke-verification|reset-attempts|notify|password-reset)$`)],
  ['GET', /^\/verifications(\/[^/]+)?$/],
  ['POST', new RegExp(`^/verifications/${ID}/(approve|reject)$`)],
  ['GET', /^\/artisans(\/pending)?$/],
  ['GET', new RegExp(`^/artisan-documents/${ID}/url$`)],
  ['POST', new RegExp(`^/artisans/${ID}/(decision|revoke)$`)],
  ['GET POST', /^\/notes$/],
  // content: listings, reviews, reports, support tickets, feedback (not private conversations)
  ['GET', /^\/properties(\/pending|\/[^/]+)?$/],
  ['GET', /^\/ai-reviews\/live$/],
  ['POST', /^\/properties\/bulk-decision$/],
  ['POST', new RegExp(`^/properties/${ID}/(decision|ai-review|takedown)$`)],
  ['PATCH', new RegExp(`^/properties/${ID}$`)],
  ['GET', /^\/reviews$/],
  ['POST', new RegExp(`^/reviews/${ID}/(hide|clear-flags)$`)],
  ['GET', /^\/reports$/],
  ['PATCH', new RegExp(`^/reports/${ID}$`)],
  ['GET', /^\/tickets(\/[^/]+)?$/],
  ['GET', /^\/live$/],
  ['POST', new RegExp(`^/tickets/${ID}/(typing|messages)$`)],
  ['PATCH', new RegExp(`^/tickets/${ID}$`)],
  ['GET', /^\/feedback$/],
  ['GET PATCH', /^\/scam-alerts(\/[^/]+)?$/],
  // support desk presence (live chat handover)
  ['GET', /^\/support\/agents$/],
  ['PUT', /^\/support\/me$/],
  ['POST', /^\/support\/heartbeat$/],
  // operations: read only
  ['GET', /^\/(bookings|tenancies|jobs)(\/[^/]+)?$/],
  ['GET', /^\/rentsave$/],
  ['GET', /^\/waitlist$/],
];

export const isAdminRole = (role: string | undefined) => role === 'admin' || role === 'admin_manager';

export function managerMay(method: string, path: string) {
  const m = method === 'HEAD' ? 'GET' : method;
  return MANAGER_ALLOW.some(([ms, re]) => ms.split(' ').includes(m) && re.test(path));
}

/** Mount after requireRole(...ADMIN_ROLES). Full admins pass; managers only reach allow-listed routes. */
export function limitManagers(req: Request, _res: Response, next: NextFunction) {
  if (req.user.role === 'admin_manager' && !managerMay(req.method, req.path)) throw forbidden('Your manager account cannot do this. Ask a full admin.', 'ADMIN_ONLY');
  next();
}

/** Full admins only, for checks inside a handler a manager may otherwise reach. */
export function assertFullAdmin(req: Request, what = 'do this') {
  if (req.user.role !== 'admin') throw forbidden(`Only a full admin can ${what}`, 'ADMIN_ONLY');
}
