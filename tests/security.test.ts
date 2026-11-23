/**
 * Security tests for payments and money movement.
 *
 *   npm run test:security
 *
 * Starts the real API in-process (no scheduler) against the database in .env and attacks it as the demo accounts
 * (investor@ / developer@rentcreeb.test, password RentcreebDemo123!). Every attack is either rejected before it does
 * anything, or is a no-op write, so it is safe to run against a shared database. Unit tests at the top need no network.
 */
import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../src/app';
import { paystack } from '../src/lib/paystack';
import { env } from '../src/config/env';
import { normalizePhone } from '../src/services/utilities';

const PASSWORD = 'RentcreebDemo123!';
/** Refused as invalid input: 400 (business rule) or 422 (schema validation). */
const REJECTED = [400, 422];
let server: Server; let base = '';
const tokens: Record<string, { token: string; id: string }> = {};

async function call(method: string, path: string, opts: { as?: string; token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  const t = opts.token ?? (opts.as ? tokens[opts.as]?.token : undefined);
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ───────── unit: no network ─────────
describe('Paystack webhook signature', () => {
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'RC_X' } }));
  const good = createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(body).digest('hex');
  test('accepts the correct HMAC', () => assert.equal(paystack.validWebhook(body, good), true));
  test('rejects a missing signature', () => assert.equal(paystack.validWebhook(body, undefined), false));
  test('rejects a missing body', () => assert.equal(paystack.validWebhook(undefined, good), false));
  test('rejects a signature made with another key', () => assert.equal(paystack.validWebhook(body, createHmac('sha512', 'attacker').update(body).digest('hex')), false));
  test('rejects a tampered body (amount changed after signing)', () => {
    const tampered = Buffer.from(body.toString().replace('RC_X', 'RC_Y'));
    assert.equal(paystack.validWebhook(tampered, good), false);
  });
  test('rejects a truncated signature without throwing', () => assert.equal(paystack.validWebhook(body, good.slice(0, 20)), false));
});

describe('input normalisation', () => {
  test('phone numbers are strictly Nigerian mobile', () => {
    assert.equal(normalizePhone('+234 803 123 4567'), '08031234567');
    for (const bad of ['0803123', '+1 202 555 0100', "08031234567' or 1=1", '<script>', '']) assert.equal(normalizePhone(bad), null, bad);
  });
});

// ───────── integration: live API in-process ─────────
describe('API attacks', () => {
  before(async () => {
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    for (const who of ['investor', 'developer', 'investor2']) {
      const { data, error } = await sb.auth.signInWithPassword({ email: `${who}@rentcreeb.test`, password: PASSWORD });
      if (error) throw new Error(`demo login ${who}: ${error.message} (run scripts/seed-developers-investors.mjs)`);
      tokens[who] = { token: data.session!.access_token, id: data.user!.id };
    }
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  describe('authentication', () => {
    test('no token → 401 on money routes', async () => {
      for (const [m, p] of [['GET', '/wallet'], ['POST', '/wallet/withdraw'], ['POST', '/wallet/fund'], ['POST', '/utilities/orders'], ['GET', '/payments']] as const)
        assert.equal((await call(m, p, { body: {} })).status, 401, `${m} ${p}`);
    });
    test('forged / expired JWT → 401', async () => {
      const fake = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ sub: tokens.investor.id, role: 'authenticated', exp: 9999999999 })).toString('base64url'), 'forged'].join('.');
      assert.equal((await call('GET', '/wallet', { token: fake })).status, 401);
      assert.equal((await call('GET', '/wallet', { token: 'not-a-jwt' })).status, 401);
    });
    test('the anon key is not a user token', async () => assert.equal((await call('GET', '/wallet', { token: env.SUPABASE_ANON_KEY })).status, 401));
  });

  describe('webhook', () => {
    test('unsigned charge.success is refused (cannot fake a payment)', async () => {
      const r = await fetch(base.replace('/api/v1', '') + '/webhooks/paystack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'charge.success', data: { reference: 'RC_FAKE', amount: 1 } }) });
      assert.equal(r.status, 401);
    });
    test('wrongly signed transfer.failed is refused (cannot fake a withdrawal refund)', async () => {
      const raw = JSON.stringify({ event: 'transfer.failed', data: { reference: 'RC_WD_FAKE' } });
      const r = await fetch(base.replace('/api/v1', '') + '/webhooks/paystack', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': createHmac('sha512', 'guess').update(raw).digest('hex') }, body: raw });
      assert.equal(r.status, 401);
    });
  });

  describe('amount tampering', () => {
    const bad = [0, -100000, 1.5, 1e20, '100000', null, 'NaN'];
    test('withdraw rejects zero, negative, fractional, huge and non-numeric amounts', async () => {
      for (const amountKobo of bad) { const r = await call('POST', '/wallet/withdraw', { as: 'investor2', body: { amountKobo } }); assert.ok(REJECTED.includes(r.status), `amount ${amountKobo} → ${r.status}`); }
    });
    test('withdraw below the ₦1,000 minimum is refused', async () => assert.ok(REJECTED.includes((await call('POST', '/wallet/withdraw', { as: 'investor2', body: { amountKobo: 99_900 } })).status)));
    test('withdraw more than the balance is refused (no overdraft)', async () => {
      const r = await call('POST', '/wallet/withdraw', { as: 'investor2', body: { amountKobo: 900_000_000_00 } });
      assert.ok([...REJECTED, 403].includes(r.status), `got ${r.status}`);
    });
    test('wallet top-up rejects bad amounts and the per-top-up maximum', async () => {
      for (const amountKobo of [...bad, env.WALLET_FUND_MIN_KOBO - 100, env.WALLET_FUND_MAX_KOBO + 100, 10_050]) {
        const r = await call('POST', '/wallet/fund', { as: 'investor2', body: { amountKobo } });
        assert.ok(REJECTED.includes(r.status), `amount ${amountKobo} → ${r.status}`);
      }
    });
    test('bill purchase: client cannot choose the price of a plan or an unknown service', async () => {
      const r1 = await call('POST', '/utilities/orders', { as: 'investor2', body: { serviceId: 'free-money', customerId: '08031234567', amountKobo: 100 } });
      assert.ok([...REJECTED, 503].includes(r1.status), `unknown service → ${r1.status}`);
      const r2 = await call('POST', '/utilities/orders', { as: 'investor2', body: { serviceId: 'mtn', customerId: '08031234567', amountKobo: -5000 } });
      assert.ok([...REJECTED, 503].includes(r2.status), `negative airtime → ${r2.status}`);
    });
  });

  describe('access control (IDOR / privilege)', () => {
    test("cannot confirm or read someone else's payment", async () => {
      const r = await call('GET', '/payments/verify/RC_SOMEONE_ELSE_123', { as: 'investor' });
      assert.ok([403, 404].includes(r.status), `got ${r.status}`);
      const r2 = await call('GET', '/payments/00000000-0000-4000-8000-000000000000/receipt', { as: 'investor' });
      assert.equal(r2.status, 404);
    });
    test('investor cannot use developer endpoints', async () => {
      assert.equal((await call('GET', '/developer/leads', { as: 'investor' })).status, 403);
      assert.equal((await call('POST', '/developer/projects', { as: 'investor', body: { name: 'x' } })).status, 403);
    });
    test("developer cannot change another developer's lead", async () => {
      // developer2 owns Greenfield's leads; developer@ (Landmark) tries to mark one purchased.
      const sb = createClient(env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
      const { data: d2 } = await sb.from('profiles').select('id').eq('email', 'developer2@rentcreeb.test').maybeSingle();
      const { data: lead } = await sb.from('dev_leads').select('id, status').eq('developer_id', d2!.id).limit(1).maybeSingle();
      assert.ok(lead, 'seeded lead for developer2');
      const r = await call('PATCH', `/developer/leads/${lead!.id}`, { as: 'developer', body: { status: 'purchased' } });
      assert.equal(r.status, 404);
      const { data: after } = await sb.from('dev_leads').select('status').eq('id', lead!.id).single();
      assert.equal(after!.status, lead!.status, 'lead unchanged');
    });
    test('normal users cannot reach admin APIs (e.g. credit a wallet)', async () => {
      assert.equal((await call('GET', '/admin/overview', { as: 'investor' })).status, 403);
      assert.equal((await call('POST', `/admin/users/${tokens.investor.id}/wallet`, { as: 'investor', body: { direction: 'credit', amountKobo: 100000000, reason: 'x' } })).status, 403);
    });
    test('profile update cannot grant verification, admin role or a role switch', async () => {
      const r = await call('PATCH', '/users/me', { as: 'investor', body: { role: 'admin' } });
      assert.ok(REJECTED.includes(r.status), `admin is not a selectable role (${r.status})`);
      const r2 = await call('PATCH', '/users/me', { as: 'investor', body: { role: 'developer' } });
      assert.equal(r2.status, 403, 'role is fixed after onboarding');
      await call('PATCH', '/users/me', { as: 'investor2', body: { nin_verified: true, ninVerified: true, is_suspended: false, verification_status: 'verified', wallet: { available_kobo: 1e12 } } });
      const me = await call('GET', '/wallet', { as: 'investor2' });
      assert.ok(me.json.availableKobo < 1e12, 'balance not settable through the profile');
    });
  });

  describe('direct database access with the public anon key (bypassing the API)', () => {
    test('a user cannot read other users’ money rows or change balances', async () => {
      const c = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      await c.auth.signInWithPassword({ email: 'investor@rentcreeb.test', password: PASSWORD });
      for (const t of ['wallets', 'wallet_transactions', 'payments', 'escrows', 'withdrawals', 'bank_accounts', 'otp_codes', 'verifications']) {
        const { data } = await c.from(t).select('*').limit(5);
        const others = (data ?? []).filter((x: any) => (x.user_id ?? x.id) !== tokens.investor.id);
        assert.equal(others.length, 0, `${t} leaks other users' rows`);
      }
      const before = await call('GET', '/wallet', { as: 'investor' });
      await c.from('wallets').update({ available_kobo: 1e12 }).eq('user_id', tokens.investor.id);
      await c.from('profiles').update({ nin_verified: true, role: 'admin' }).eq('id', tokens.investor.id);
      await c.rpc('wallet_credit', { p_user: tokens.investor.id, p_amount: 1e10, p_kind: 'attack', p_desc: 'attack', p_ref: `attack-${Date.now()}` });
      const afterW = await call('GET', '/wallet', { as: 'investor' });
      assert.equal(afterW.json.availableKobo, before.json.availableKobo, 'balance changed by a direct DB call');
      const prof = await call('GET', '/users/me', { as: 'investor' });
      assert.equal(prof.json.profile?.role, 'investor');
    });
  });

  describe('rate limiting', () => {
    test('payment endpoints throttle a flood from one account', async () => {
      let limited = false;
      for (let i = 0; i < 40 && !limited; i++) limited = (await call('POST', '/utilities/verify', { as: 'investor2', body: {} })).status === 429;
      assert.ok(limited, 'expected HTTP 429 within 40 requests');
    });
  });
});
