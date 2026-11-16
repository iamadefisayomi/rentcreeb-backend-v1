import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { mountPlatform } from './admin/platform';
import { mountPeople } from './admin/people';
import { mountContent } from './admin/content';
import { mountMoney } from './admin/money';

/**
 * Admin API, used by the web dashboard served at /admin (backend/admin).
 * Every route needs a signed-in profile with role 'admin'. Every change is written to admin_actions.
 *
 *   platform: overview, search, system health, runtime settings, announcements, audit log
 *   people:   users, ID verification review, artisan applications, internal notes
 *   content:  listings, reviews, reports, conversations (audited), support tickets, app feedback
 *   money:    finance, payments, bookings, escrow, withdrawals, subscriptions & plans, tenancies, RentSave, jobs
 */
const r = Router();
r.use(authenticate, requireRole('admin'));
r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

mountPlatform(r);
mountPeople(r);
mountContent(r);
mountMoney(r);

export default r;
