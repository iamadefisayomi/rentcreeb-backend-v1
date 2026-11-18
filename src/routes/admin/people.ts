import type { Request, Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { anonClient, db, dbError, unwrapMaybe } from '../../lib/supabase';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { signPrivateUrl } from '../../lib/bunny';
import { normalizePhone, paginate, uuid } from '../../lib/common';
import { sendEmail } from '../../lib/email';
import { logger } from '../../lib/logger';
import { notify } from '../../services/notify';
import { closeAccount } from '../../services/accounts';
import { presenceOf } from '../../services/presence';
import { purgeVerificationEvidence } from '../../services/verificationEvidence';
import { PERSON, audit, count, decision, like, notesFor, sendCsv } from './shared';

const ROLES = ['tenant', 'landlord', 'estate_manager', 'artisan', 'agent', 'admin'] as const;
const USER_COLS = 'id, first_name, last_name, email, phone, role, avatar_url, phone_verified, nin_verified, is_suspended, deleted_at, rating_avg, rating_count, created_at';
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function userFilters(query: unknown) {
  return z.object({
    q: z.string().optional(), role: z.enum(ROLES).optional().or(z.literal('').transform(() => undefined)),
    status: z.enum(['suspended', 'unverified', 'verified', 'phone_only', 'deleted', 'active']).optional().or(z.literal('').transform(() => undefined)),
    sort: z.enum(['newest', 'oldest', 'name']).default('newest'),
  }).parse(query);
}
function applyUserFilters(q: any, f: ReturnType<typeof userFilters>) {
  if (f.role) q = q.eq('role', f.role);
  if (f.status === 'suspended') q = q.eq('is_suspended', true).is('deleted_at', null);
  if (f.status === 'unverified') q = q.eq('nin_verified', false);
  if (f.status === 'verified') q = q.eq('nin_verified', true);
  if (f.status === 'phone_only') q = q.eq('phone_verified', true).eq('nin_verified', false);
  if (f.status === 'deleted') q = q.not('deleted_at', 'is', null);
  if (f.status === 'active') q = q.eq('is_suspended', false);
  if (f.q?.trim()) {
    const t = like(f.q);
    q = /^[0-9a-f-]{36}$/i.test(f.q.trim()) ? q.eq('id', f.q.trim()) : q.or(`first_name.ilike.${t},last_name.ilike.${t},email.ilike.${t},phone.ilike.${t},username.ilike.${t}`);
  }
  if (f.sort === 'oldest') q = q.order('created_at', { ascending: true });
  else if (f.sort === 'name') q = q.order('first_name', { ascending: true, nullsFirst: false });
  else q = q.order('created_at', { ascending: false });
  return q;
}

/** Update a verification row; retries without migration-013 columns on an older schema. */
async function updateVerification(id: string, patch: Record<string, unknown>, guard?: (q: any) => any) {
  const run = (p: Record<string, unknown>) => { let q: any = db.from('verifications').update(p).eq('id', id); if (guard) q = guard(q); return q.select('*').maybeSingle(); };
  let r = await run(patch);
  if (r.error && /column/i.test(r.error.message)) {
    const { reviewed_by: _a, reviewed_at: _b, review_note: _c, counts_as_attempt: _d, selfie_path: _e, document_path: _f, ...rest } = patch;
    r = await run(rest);
  }
  if (r.error) throw dbError(r.error);
  return r.data as any;
}

/** Delete stored selfies / ID photos for a user once a decision is made (privacy: keep evidence only while needed). */
async function purgeEvidence(userId: string) {
  await purgeVerificationEvidence((q) => q.eq('user_id', userId));
}

async function emailUser(userId: string, subject: string, text: string) {
  const { data: p } = await db.from('profiles').select('email, first_name').eq('id', userId).maybeSingle();
  if (!p?.email) return;
  await sendEmail(p.email, subject, `<p>Hi ${escHtml(p.first_name || 'there')},</p><p>${escHtml(text).replace(/\n/g, '<br>')}</p><p>— The RentCreeb team</p>`);
}

/** Mark a user as NIN-verified, from a specific review (or none). Refuses if the NIN already belongs to another verified account. */
async function approveIdentity(req: Request, userId: string, verificationId: string | null, note?: string) {
  const now = new Date().toISOString();
  const review = { reviewed_by: req.user.id, reviewed_at: now, review_note: note ?? null };
  let v: any = null;
  if (verificationId) {
    v = unwrapMaybe(await db.from('verifications').select('*').eq('id', verificationId).eq('user_id', userId).maybeSingle());
    if (!v) throw notFound('Verification not found');
    if (v.status === 'success') throw conflict('This check is already approved');
  } else {
    v = unwrapMaybe(await db.from('verifications').select('*').eq('user_id', userId).eq('status', 'manual_review').order('created_at', { ascending: false }).limit(1).maybeSingle());
  }
  if (v && !String(v.nin_hash).startsWith('manual:')) {
    const { data: dup } = await db.from('verifications').select('user_id').eq('nin_hash', v.nin_hash).eq('status', 'success').neq('user_id', userId).maybeSingle();
    if (dup) throw conflict('This NIN is already linked to another verified account. Investigate before approving.', 'NIN_IN_USE');
  }
  if (v) await updateVerification(v.id, { status: 'success', ...review });
  else {
    const { error } = await db.from('verifications').insert({ user_id: userId, nin_hash: `admin:${userId}:${Date.now()}`, nin_last3: '---', status: 'success', failure_reason: null, metadata: { approved_by_admin: true, note } });
    if (error) logger.warn({ err: error }, 'admin verify: could not record a verification row');
  }
  // Any other open requests for this user are now moot.
  await db.from('verifications').update({ status: 'failed', failure_reason: 'SUPERSEDED' }).eq('user_id', userId).eq('status', 'manual_review');
  await db.from('profiles').update({ nin_verified: true, updated_at: now }).eq('id', userId);
  await purgeEvidence(userId);
  await notify(userId, 'verified', 'Identity verified ✅', 'Your account is now fully verified.');
  await emailUser(userId, 'Your RentCreeb identity is verified', 'Good news: our team has verified your identity. You now have full access to RentCreeb.');
  await audit(req, 'user.verify', 'user', userId, { verificationId: v?.id, note });
}

export function mountPeople(r: Router) {
  // ───────── Users ─────────
  r.get('/users', async (req, res) => {
    const { from, to } = paginate(req.query);
    const f = userFilters(req.query);
    const { data, count: total, error } = await applyUserFilters(db.from('profiles').select(USER_COLS, { count: 'exact' }), f).range(from, to);
    if (error) throw dbError(error);
    res.json({ users: data, total: total ?? 0 });
  });

  r.get('/users/export', async (req, res) => {
    const f = userFilters(req.query);
    const { data, error } = await applyUserFilters(db.from('profiles').select(USER_COLS), f).limit(10000);
    if (error) throw dbError(error);
    await audit(req, 'export.users', 'export', null, { filters: f, rows: data?.length ?? 0 });
    sendCsv(res, `rentcreeb-users-${new Date().toISOString().slice(0, 10)}.csv`, data ?? [], [
      ['id', 'ID'], ['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['role', 'Role'],
      ['phone_verified', 'Phone verified'], ['nin_verified', 'NIN verified'], ['is_suspended', 'Suspended'], ['deleted_at', 'Deleted at'], ['created_at', 'Joined'],
    ]);
  });

  r.get('/users/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: profile } = await db.from('profiles').select('*').eq('id', id).maybeSingle();
    if (!profile) throw notFound('User not found');
    const or2 = (a: string, b: string) => `${a}.eq.${id},${b}.eq.${id}`;
    const [properties, bookings, payments, reportsAgainst, reportsFiled, verifs, artisan, wallet, walletTx, withdrawals, bank, subs, tenancies, jobs, tickets, reviewsAbout, authUser, notes] = await Promise.all([
      db.from('properties').select('id, title, area, status, price_kobo, price_period, created_at').eq('owner_id', id).order('created_at', { ascending: false }).limit(50),
      db.from('bookings').select('id, status, scheduled_at, amount_kobo, tenant_id, host_id, created_at, properties(title)').or(or2('tenant_id', 'host_id')).order('created_at', { ascending: false }).limit(30),
      db.from('payments').select('id, purpose, reference, amount_kobo, status, channel, paid_at, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(30),
      db.from('reports').select('id, reason, status, created_at').eq('agent_id', id).order('created_at', { ascending: false }).limit(30),
      count('reports', (q) => q.eq('reporter_id', id)),
      db.from('verifications').select('*').eq('user_id', id).order('created_at', { ascending: false }).limit(20),
      db.from('artisan_profiles').select('*').eq('user_id', id).maybeSingle(),
      db.from('wallets').select('available_kobo, updated_at').eq('user_id', id).maybeSingle(),
      db.from('wallet_transactions').select('id, direction, amount_kobo, kind, description, reference, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(30),
      db.from('withdrawals').select('id, amount_kobo, reference, status, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(20),
      db.from('bank_accounts').select('bank_name, account_number, account_name, created_at').eq('user_id', id).maybeSingle(),
      db.from('subscriptions').select('id, status, starts_at, expires_at, billing_cycle, created_at, subscription_plans(name)').eq('agent_id', id).order('created_at', { ascending: false }).limit(10),
      db.from('tenancies').select('id, status, rent_kobo, frequency, lease_start, lease_end, landlord_id, tenant_id, properties(title)').or(or2('landlord_id', 'tenant_id')).order('created_at', { ascending: false }).limit(20),
      db.from('jobs').select('id, title, status, budget_max_kobo, landlord_id, artisan_id, created_at').or(or2('landlord_id', 'artisan_id')).order('created_at', { ascending: false }).limit(20),
      db.from('support_tickets').select('id, kind, subject, status, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(20),
      db.from('reviews').select('id, rating, comment, hidden, created_at').eq('agent_id', id).order('created_at', { ascending: false }).limit(20),
      db.auth.admin.getUserById(id),
      notesFor('user', id),
    ]);
    const { expo_push_token, privacy_prefs: _p, notification_prefs: _n, ...safe } = profile as any; // internal fields stay internal
    const au = authUser.data?.user as any;
    const failedCounting = (verifs.data ?? []).filter((v: any) => v.status === 'failed' && v.counts_as_attempt !== false).length;
    res.json({
      user: safe, artisan: artisan.data ?? null,
      verifications: (verifs.data ?? []).map((v: any) => ({ ...v, nin_hash: undefined, hasSelfie: !!v.selfie_path, hasDocument: !!v.document_path || (Array.isArray(v.nimc_files) && v.nimc_files.length > 0), selfie_path: undefined, document_path: undefined, nimc_files: undefined, nimc_record: undefined })),
      attempts: { used: failedCounting, max: env.NIN_MAX_ATTEMPTS },
      auth: au ? { email: au.email, emailConfirmed: !!au.email_confirmed_at, lastSignInAt: au.last_sign_in_at, bannedUntil: au.banned_until ?? null, providers: au.app_metadata?.providers ?? [] } : null,
      presence: presenceOf(id), pushEnabled: !!expo_push_token,
      wallet: wallet.data ?? null, walletTransactions: walletTx.data ?? [], withdrawals: withdrawals.data ?? [],
      bankAccount: bank.data ? { ...bank.data, account_number: '••••' + String(bank.data.account_number).slice(-4) } : null,
      properties: properties.data ?? [], bookings: bookings.data ?? [], payments: payments.data ?? [],
      subscriptions: subs.data ?? [], tenancies: tenancies.data ?? [], jobs: jobs.data ?? [], tickets: tickets.data ?? [], reviewsAbout: reviewsAbout.data ?? [],
      reportsAgainst: reportsAgainst.data ?? [], reportsFiled, notes,
    });
  });

  /** Edit basic profile fields. Role changes to/from admin are allowed but never on your own account. */
  r.patch('/users/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({
      firstName: z.string().trim().min(1).max(60).optional(), lastName: z.string().trim().min(1).max(60).optional(),
      phone: z.string().trim().max(20).nullable().optional(), role: z.enum(ROLES).optional(), phoneVerified: z.boolean().optional(),
      reason: z.string().max(300).optional(),
    }).parse(req.body);
    const { data: before } = await db.from('profiles').select('first_name, last_name, phone, role, phone_verified, deleted_at').eq('id', id).maybeSingle();
    if (!before) throw notFound('User not found');
    if (before.deleted_at) throw badRequest('This account was deleted');
    if (b.role && id === req.user.id) throw badRequest('You cannot change your own role');
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (b.firstName !== undefined) patch.first_name = b.firstName;
    if (b.lastName !== undefined) patch.last_name = b.lastName;
    if (b.phone !== undefined) {
      const p = b.phone ? normalizePhone(b.phone) : null;
      if (b.phone && !p) throw badRequest('Enter a valid Nigerian phone number');
      if (p) { const { data: taken } = await db.from('profiles').select('id').eq('phone', p).neq('id', id).maybeSingle(); if (taken) throw conflict('Another account uses that phone number'); }
      patch.phone = p; if (p !== before.phone) patch.phone_verified = false;
    }
    if (b.phoneVerified !== undefined) patch.phone_verified = b.phoneVerified;
    if (b.role) patch.role = b.role;
    const { error } = await db.from('profiles').update(patch).eq('id', id);
    if (error) throw dbError(error);
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => k !== 'updated_at' && (before as any)[k] !== v).map(([k, v]) => [k, { from: (before as any)[k], to: v }]));
    await audit(req, b.role && b.role !== before.role ? (b.role === 'admin' ? 'user.grant_admin' : before.role === 'admin' ? 'user.revoke_admin' : 'user.role') : 'user.edit', 'user', id, { changed, reason: b.reason });
    res.status(204).end();
  });

  r.post('/users/:id/suspend', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { suspended, reason, notifyUser } = z.object({ suspended: z.boolean(), reason: z.string().max(300).optional(), notifyUser: z.boolean().default(false) }).parse(req.body);
    if (id === req.user.id) throw badRequest('You cannot suspend your own account');
    const { data: p } = await db.from('profiles').select('deleted_at').eq('id', id).maybeSingle();
    if (!p) throw notFound('User not found');
    if (p.deleted_at && !suspended) throw badRequest('Deleted accounts stay closed');
    const now = new Date().toISOString();
    let { error } = await db.from('profiles').update({ is_suspended: suspended, suspended_reason: suspended ? reason ?? null : null, suspended_at: suspended ? now : null }).eq('id', id);
    if (error) ({ error } = await db.from('profiles').update({ is_suspended: suspended }).eq('id', id)); // pre-013
    if (error) throw dbError(error);
    // Block (or restore) sign-in and token refresh too, so the app is locked out within the hour, not just on the next API call.
    const ban = await db.auth.admin.updateUserById(id, { ban_duration: suspended ? '876000h' : 'none' });
    if (ban.error) logger.warn({ err: ban.error }, 'could not update auth ban');
    if (notifyUser && suspended) await emailUser(id, 'Your RentCreeb account has been suspended', `Your account has been suspended${reason ? ': ' + reason : '.'}\nIf you think this is a mistake, reply to this email.`);
    if (!suspended) await notify(id, 'account_restored', 'Account restored', 'Your RentCreeb account is active again.');
    await audit(req, suspended ? 'user.suspend' : 'user.unsuspend', 'user', id, reason ? { reason } : {});
    res.status(204).end();
  });

  /** Manually verify a user (e.g. after checking their ID on a call). Uses their open review if there is one. */
  r.post('/users/:id/verify', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    const { data: p } = await db.from('profiles').select('nin_verified').eq('id', id).maybeSingle();
    if (!p) throw notFound('User not found');
    if (p.nin_verified) throw conflict('Already verified');
    await approveIdentity(req, id, null, note);
    res.status(204).end();
  });

  /** Take verification away (fraud, wrong person). Frees the NIN so its real owner can verify. */
  r.post('/users/:id/revoke-verification', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { reason, notifyUser } = z.object({ reason: z.string().min(3).max(300), notifyUser: z.boolean().default(true) }).parse(req.body);
    await db.from('profiles').update({ nin_verified: false, updated_at: new Date().toISOString() }).eq('id', id);
    const { data: rows } = await db.from('verifications').select('id').eq('user_id', id).eq('status', 'success');
    for (const v of rows ?? []) await updateVerification(v.id, { status: 'failed', failure_reason: 'REVOKED', review_note: reason, reviewed_by: req.user.id, reviewed_at: new Date().toISOString(), counts_as_attempt: false });
    if (notifyUser) await notify(id, 'verification_failed', 'Verification removed', reason);
    await audit(req, 'user.revoke_verification', 'user', id, { reason });
    res.status(204).end();
  });

  /** Give back NIN attempts (e.g. they were failing because of a bad camera, now fixed). */
  r.post('/users/:id/reset-attempts', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { error } = await db.from('verifications').update({ counts_as_attempt: false }).eq('user_id', id).eq('status', 'failed');
    if (error) throw badRequest('Apply migration 013_admin_tools.sql in Supabase to enable attempt resets', 'MIGRATION_REQUIRED');
    await notify(id, 'verification_retry', 'You can verify again', 'Our team has reset your verification attempts. Open RentCreeb to try again.');
    await audit(req, 'user.reset_attempts', 'user', id);
    res.status(204).end();
  });

  r.post('/users/:id/notify', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ title: z.string().trim().min(2).max(80), body: z.string().trim().min(2).max(1000), email: z.boolean().default(false) }).parse(req.body);
    await notify(id, 'admin_message', b.title, b.body);
    if (b.email) await emailUser(id, b.title, b.body);
    await audit(req, 'user.message', 'user', id, { title: b.title, email: b.email });
    res.status(204).end();
  });

  r.post('/users/:id/password-reset', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: p } = await db.from('profiles').select('email').eq('id', id).maybeSingle();
    if (!p?.email) throw badRequest('This account has no email address');
    const { error } = await anonClient().auth.resetPasswordForEmail(p.email, { redirectTo: env.PASSWORD_RESET_REDIRECT_URL });
    if (error) throw badRequest(error.message);
    await audit(req, 'user.password_reset', 'user', id);
    res.status(204).end();
  });

  /** Credit or debit a wallet by hand (refund goodwill, fix a mistake). Always needs a reason; fully audited. */
  r.post('/users/:id/wallet-adjust', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ direction: z.enum(['credit', 'debit']), amountKobo: z.number().int().positive().max(1_000_000_000), reason: z.string().trim().min(5).max(300) }).parse(req.body);
    const ref = `admin:${crypto.randomUUID()}`;
    const { data, error } = await db.rpc(b.direction === 'credit' ? 'wallet_credit' : 'wallet_debit', { p_user: id, p_amount: b.amountKobo, p_kind: `admin_${b.direction}`, p_desc: b.reason, p_ref: ref });
    if (error) throw badRequest(/insufficient|check/i.test(error.message) ? 'The wallet balance is too low for that debit' : error.message);
    if (data === false) throw conflict('Adjustment was not applied');
    await notify(id, 'wallet_adjustment', b.direction === 'credit' ? 'Wallet credited' : 'Wallet debited', `₦${(b.amountKobo / 100).toLocaleString()}: ${b.reason}`);
    await audit(req, `wallet.${b.direction}`, 'user', id, { amountKobo: b.amountKobo, reason: b.reason, reference: ref });
    res.status(204).end();
  });

  /** Close (anonymise) an account, e.g. for a data-deletion request. `force` skips the balance/booking checks. */
  r.post('/users/:id/close', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ confirm: z.literal('CLOSE'), reason: z.string().min(3).max(300), force: z.boolean().default(false) }).parse(req.body);
    if (id === req.user.id) throw badRequest('You cannot close your own account here');
    await closeAccount(id, { force: b.force });
    await audit(req, 'user.close', 'user', id, { reason: b.reason, force: b.force });
    res.status(204).end();
  });

  // ───────── Identity verification review ─────────
  r.get('/verifications', async (req, res) => {
    const { from, to } = paginate(req.query);
    const f = z.object({ status: z.enum(['manual_review', 'failed', 'success']).default('manual_review'), q: z.string().optional() }).parse(req.query);
    let q: any = db.from('verifications').select(`id, user_id, status, nin_last3, confidence, failure_reason, metadata, created_at, selfie_path, document_path, document_type, reviewed_at,
      user:profiles!verifications_user_id_fkey(${PERSON}, nin_verified, created_at)`, { count: 'exact' })
      .eq('status', f.status).order('created_at', { ascending: f.status === 'manual_review' }).range(from, to);
    let { data, count: total, error } = await q;
    if (error && /column/i.test(error.message)) { // pre-013
      q = db.from('verifications').select(`id, user_id, status, nin_last3, confidence, failure_reason, metadata, created_at, user:profiles!verifications_user_id_fkey(${PERSON}, nin_verified, created_at)`, { count: 'exact' })
        .eq('status', f.status).order('created_at', { ascending: f.status === 'manual_review' }).range(from, to);
      ({ data, count: total, error } = await q);
    }
    if (error) throw dbError(error);
    const [review, failed, success] = await Promise.all(['manual_review', 'failed', 'success'].map((s) => count('verifications', (x) => x.eq('status', s))));
    // Which rows kept the NIN response / NIMC ID photo (migration 017; quietly skipped before it is applied).
    const ids = (data ?? []).map((v: any) => v.id);
    const nimc = new Map<string, { photo: boolean; response: boolean }>();
    if (ids.length) {
      const { data: n } = await db.from('verifications').select('id, nimc_files, nimc_record').in('id', ids);
      for (const x of (n ?? []) as any[]) nimc.set(x.id, { photo: Array.isArray(x.nimc_files) && x.nimc_files.length > 0, response: !!x.nimc_record });
    }
    res.json({
      verifications: (data ?? []).map((v: any) => ({ ...v, hasSelfie: !!v.selfie_path, hasDocument: !!v.document_path, hasNimcPhoto: !!nimc.get(v.id)?.photo, hasNimcResponse: !!nimc.get(v.id)?.response, selfie_path: undefined, document_path: undefined })),
      total: total ?? 0, counts: { manual_review: review, failed, success },
    });
  });

  /** Everything a reviewer needs on one page. Opening evidence is audited. */
  r.get('/verifications/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { data: v } = await db.from('verifications').select('*').eq('id', id).maybeSingle();
    if (!v) throw notFound('Verification not found');
    const [{ data: user }, { data: history }, dup] = await Promise.all([
      db.from('profiles').select('id, first_name, last_name, email, phone, role, avatar_url, date_of_birth, gender, location, phone_verified, nin_verified, is_suspended, created_at').eq('id', v.user_id).maybeSingle(),
      db.from('verifications').select('id, status, nin_last3, confidence, failure_reason, created_at, review_note, counts_as_attempt').eq('user_id', v.user_id).order('created_at', { ascending: false }).limit(20),
      String(v.nin_hash).startsWith('manual:') || String(v.nin_hash).startsWith('admin:') ? Promise.resolve({ data: null })
        : db.from('verifications').select(`user_id, created_at, user:profiles!verifications_user_id_fkey(id, first_name, last_name)`).eq('nin_hash', v.nin_hash).neq('user_id', v.user_id).limit(5),
    ]);
    const sign = (p?: string | null) => { if (!p) return null; try { return signPrivateUrl(p, 600); } catch { return null; } };
    const nimcFiles: any[] = Array.isArray(v.nimc_files) ? v.nimc_files : [];
    const evidence = {
      selfieUrl: sign(v.selfie_path), documentUrl: sign(v.document_path), documentType: v.document_type ?? null, documentIsPdf: /\.pdf$/i.test(v.document_path ?? ''),
      // Pictures that came back with the NIN check (the NIMC ID photo first), and every other field of the response.
      nimcImages: nimcFiles.map((f) => ({ field: String(f.field ?? ''), url: sign(f.path) })).filter((f) => f.url),
      nimcResponse: v.nimc_record ?? null,
    };
    if (v.selfie_path || v.document_path || nimcFiles.length || v.nimc_record) await audit(req, 'verification.view_evidence', 'verification', id, { userId: v.user_id });
    const used = (history ?? []).filter((h: any) => h.status === 'failed' && h.counts_as_attempt !== false).length;
    const { nin_hash: _h, selfie_path: _s, document_path: _d, nimc_files: _nf, nimc_record: _nr, ...safe } = v as any;
    res.json({ verification: safe, user, history: history ?? [], evidence, sameNinOtherAccounts: (dup as any).data ?? [], attempts: { used, max: env.NIN_MAX_ATTEMPTS } });
  });

  r.post('/verifications/:id/approve', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    const { data: v } = await db.from('verifications').select('user_id').eq('id', id).maybeSingle();
    if (!v) throw notFound('Verification not found');
    await approveIdentity(req, v.user_id, id, note);
    res.status(204).end();
  });

  /** Reject a review. `allowRetry` gives the user their attempts back (e.g. "retake the selfie in daylight"). */
  r.post('/verifications/:id/reject', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ reason: z.string().min(3).max(300), allowRetry: z.boolean().default(false) }).parse(req.body);
    const v = await updateVerification(id, { status: 'failed', failure_reason: 'REJECTED_BY_ADMIN', review_note: b.reason, reviewed_by: req.user.id, reviewed_at: new Date().toISOString(), counts_as_attempt: !b.allowRetry },
      (q) => q.eq('status', 'manual_review'));
    if (!v) throw notFound('Verification not awaiting review');
    if (b.allowRetry) await db.from('verifications').update({ counts_as_attempt: false }).eq('user_id', v.user_id).eq('status', 'failed');
    await purgeEvidence(v.user_id);
    const msg = b.allowRetry ? `${b.reason}\nYou can try again in the app.` : b.reason;
    await notify(v.user_id, 'verification_failed', 'Identity check unsuccessful', msg);
    await emailUser(v.user_id, 'About your RentCreeb identity check', msg);
    await audit(req, 'verification.reject', 'verification', id, { reason: b.reason, allowRetry: b.allowRetry, userId: v.user_id });
    res.status(204).end();
  });

  // ───────── Artisan applications ─────────
  // artisan_documents links to profiles (not artisan_profiles), so documents are embedded through the profile and
  // lifted back up to keep the response shape { ...artisan, profiles, artisan_documents, artisan_references }.
  const artisanList = async (status: string) => {
    const { data } = await db.from('artisan_profiles').select('*, profiles(first_name, last_name, phone, email, nin_verified, avatar_url, artisan_documents(id, doc_type, original_name), artisan_references(*), artisan_portfolio(url, caption))')
      .eq('review_status', status).order(status === 'pending' ? 'submitted_at' : 'approved_at', { ascending: status === 'pending', nullsFirst: false }).limit(100);
    return (data ?? []).map((a: any) => {
      const { artisan_documents, artisan_references, artisan_portfolio, ...profile } = a.profiles ?? {};
      return { ...a, profiles: profile, artisan_documents: artisan_documents ?? [], artisan_references: artisan_references ?? [], artisan_portfolio: artisan_portfolio ?? [] };
    });
  };
  r.get('/artisans/pending', async (_req, res) => res.json({ artisans: await artisanList('pending') }));
  r.get('/artisans', async (req, res) => {
    const { status } = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'draft']).default('pending') }).parse(req.query);
    res.json({ artisans: await artisanList(status) });
  });

  /** Short-lived signed URL to view a private document. */
  r.get('/artisan-documents/:id/url', async (req, res) => {
    const { data } = await db.from('artisan_documents').select('storage_path, user_id').eq('id', uuid.parse(req.params.id)).maybeSingle();
    if (!data) throw notFound();
    await audit(req, 'document.view', 'artisan_document', req.params.id, { userId: data.user_id });
    res.json({ url: signPrivateUrl(data.storage_path, 300) });
  });

  r.post('/artisans/:userId/decision', async (req, res) => {
    const b = decision.parse(req.body);
    const a = unwrapMaybe(await db.from('artisan_profiles').update(b.approve
      ? { review_status: 'approved', approved_at: new Date().toISOString(), review_note: null } : { review_status: 'rejected', review_note: b.reason })
      .eq('user_id', uuid.parse(req.params.userId)).eq('review_status', 'pending').select().maybeSingle());
    if (!a) throw notFound('Pending application not found');
    await notify(a.user_id, b.approve ? 'artisan_approved' : 'artisan_rejected', b.approve ? 'You’re now a Verified Artisan! 🎉' : 'Application needs changes', b.approve ? 'Your profile is now visible and you can receive job alerts.' : (b.reason ?? ''));
    await audit(req, b.approve ? 'artisan.approve' : 'artisan.reject', 'user', a.user_id, { reason: b.reason });
    res.json({ artisan: a });
  });

  /** Withdraw an approved artisan's badge (complaints, expired documents). They can fix and resubmit. */
  r.post('/artisans/:userId/revoke', async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    const a = unwrapMaybe(await db.from('artisan_profiles').update({ review_status: 'rejected', review_note: reason })
      .eq('user_id', uuid.parse(req.params.userId)).eq('review_status', 'approved').select().maybeSingle());
    if (!a) throw notFound('Approved artisan not found');
    await notify(a.user_id, 'artisan_rejected', 'Artisan approval withdrawn', reason);
    await audit(req, 'artisan.revoke', 'user', a.user_id, { reason });
    res.json({ artisan: a });
  });

  // ───────── Internal notes (any record) ─────────
  r.get('/notes', async (req, res) => {
    const f = z.object({ targetType: z.string().min(2).max(40), targetId: z.string().min(1).max(80) }).parse(req.query);
    res.json({ notes: await notesFor(f.targetType, f.targetId) });
  });
  r.post('/notes', async (req, res) => {
    const b = z.object({ targetType: z.enum(['user', 'property', 'booking', 'report', 'ticket', 'verification', 'payment', 'withdrawal', 'job', 'tenancy']), targetId: z.string().min(1).max(80), body: z.string().trim().min(1).max(4000) }).parse(req.body);
    const { data, error } = await db.from('admin_notes').insert({ target_type: b.targetType, target_id: b.targetId, admin_id: req.user.id, body: b.body }).select('id').single();
    if (error) throw badRequest('Apply migration 013_admin_tools.sql in Supabase to enable notes', 'MIGRATION_REQUIRED');
    await audit(req, 'note.add', b.targetType, b.targetId, { noteId: data.id });
    res.status(201).json({ id: data.id });
  });
  r.delete('/notes/:id', async (req, res) => {
    const { data } = await db.from('admin_notes').delete().eq('id', uuid.parse(req.params.id)).eq('admin_id', req.user.id).select('id, target_type, target_id').maybeSingle();
    if (!data) throw notFound('Note not found (you can only delete your own notes)');
    await audit(req, 'note.delete', data.target_type, data.target_id);
    res.status(204).end();
  });
}
