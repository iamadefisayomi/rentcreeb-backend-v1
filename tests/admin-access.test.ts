/** What an admin manager may reach (offline): npx tsx --test tests/admin-access.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { managerMay } from '../src/routes/admin/access';

const id = '3f2b1c9e-0000-4000-8000-000000000001';
test('managers can moderate and support', () => {
  for (const [m, p] of [['GET', '/overview'], ['GET', '/users'], ['GET', `/users/${id}`], ['POST', `/users/${id}/suspend`], ['POST', `/verifications/${id}/approve`],
    ['POST', `/properties/${id}/decision`], ['POST', '/properties/bulk-decision'], ['PATCH', `/reports/${id}`], ['POST', `/tickets/${id}/messages`], ['GET', '/live'],
    ['PATCH', `/scam-alerts/${id}`], ['GET', `/bookings/${id}`], ['POST', '/notes'], ['PUT', '/support/me']] as const)
    assert.ok(managerMay(m, p), `${m} ${p}`);
});
test('managers cannot touch money, mailing, settings or private chats', () => {
  for (const [m, p] of [['GET', '/finance'], ['GET', '/payments'], ['POST', `/payments/${id}/recheck`], ['POST', `/escrows/${id}/release`], ['POST', `/withdrawals/${id}/resolve`],
    ['POST', `/users/${id}/wallet-adjust`], ['POST', `/users/${id}/close`], ['POST', `/users/${id}/delete`], ['GET', '/users/export'], ['POST', `/bookings/${id}/cancel`], ['POST', `/bookings/${id}/complete`],
    ['POST', '/subscriptions/grant'], ['PATCH', `/plans/${id}`], ['PUT', '/settings'], ['GET', '/system'], ['POST', '/announcements'], ['GET', '/actions'], ['GET', '/admins'],
    ['GET', '/mailing/overview'], ['POST', `/mailing/campaigns/${id}/send`], ['PUT', '/assistant/settings'], ['GET', `/conversations/${id}/messages`], ['DELETE', `/waitlist/${id}`],
    ['GET', '/waitlist.csv'], ['GET', '/media'], ['POST', '/media'], ['DELETE', '/media'], ['DELETE', `/notes/${id}`], ['GET', '/users/x/../../finance']] as const)
    assert.ok(!managerMay(m, p), `${m} ${p}`);
});
