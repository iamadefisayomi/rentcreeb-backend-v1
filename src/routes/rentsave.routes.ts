import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, notFound } from '../lib/errors';
import { kobo, uuid } from '../lib/common';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { createPayment } from '../services/payments';
import { settleRent } from '../services/rent';

const r = Router();
r.use(authenticate, requireRole('tenant'));

const withProgress = (p: any) => ({ ...p, progressPercent: Math.min(100, Math.round((Number(p.saved_kobo) / Number(p.target_kobo)) * 100)) });

/** Setup: amount → frequency → progress. */
r.post('/', requireVerified, async (req, res) => {
  const b = z.object({
    name: z.string().default('Rent Savings'), targetKobo: kobo, contributionKobo: kobo,
    frequency: z.enum(['daily', 'weekly', 'monthly']), targetDate: z.string().date().optional(), tenancyId: uuid.optional(),
  }).parse(req.body);
  if (b.contributionKobo > b.targetKobo) throw badRequest('Contribution cannot exceed target');
  const plan = unwrap(await db.from('rentsave_plans').insert({
    tenant_id: req.user.id, name: b.name, target_kobo: b.targetKobo, contribution_kobo: b.contributionKobo,
    frequency: b.frequency, target_date: b.targetDate, tenancy_id: b.tenancyId }).select().single());
  res.status(201).json({ plan: withProgress(plan) });
});

r.get('/', async (req, res) =>
  res.json({ plans: ((await db.from('rentsave_plans').select('*').eq('tenant_id', req.user.id).order('created_at', { ascending: false })).data ?? []).map(withProgress) }));

r.patch('/:id', async (req, res) => {
  const b = z.object({ status: z.enum(['active', 'paused']).optional(), contributionKobo: kobo.optional(), frequency: z.enum(['daily', 'weekly', 'monthly']).optional() }).parse(req.body);
  const { data } = await db.from('rentsave_plans').update({ status: b.status, contribution_kobo: b.contributionKobo, frequency: b.frequency })
    .eq('id', req.params.id).eq('tenant_id', req.user.id).select().maybeSingle();
  if (!data) throw notFound('Plan not found');
  res.json({ plan: withProgress(data) });
});

/** Add money to the plan via Paystack (default amount = plan contribution). */
r.post('/:id/contribute', requireVerified, async (req, res) => {
  const { amountKobo } = z.object({ amountKobo: kobo.optional() }).parse(req.body ?? {});
  const { data: plan } = await db.from('rentsave_plans').select('*').eq('id', req.params.id).eq('tenant_id', req.user.id).maybeSingle();
  if (!plan) throw notFound('Plan not found');
  if (plan.status !== 'active') throw badRequest('Plan is not active');
  res.status(201).json({ payment: await createPayment(req.user, 'rentsave', amountKobo ?? Number(plan.contribution_kobo), { rentsave_plan_id: plan.id }) });
});

/** Pay the currently due rent from saved funds (needs enough saved to cover the instalment). */
/**
 * Pay the currently due rent from saved funds (Figma "Pay Rent with RentSave" 4505:4675).
 * Default: the whole instalment (savings must cover it). With `amountKobo`: a partial payment — the instalment is split
 * and the remainder stays due.
 */
r.post('/:id/apply-to-rent', requireVerified, async (req, res) => {
  const { tenancyId, amountKobo } = z.object({ tenancyId: uuid, amountKobo: kobo.optional() }).parse(req.body);
  const { data: plan } = await db.from('rentsave_plans').select('*').eq('id', req.params.id).eq('tenant_id', req.user.id).maybeSingle();
  if (!plan) throw notFound('Plan not found');
  const { data: t } = await db.from('tenancies').select('id').eq('id', tenancyId).eq('tenant_id', req.user.id).eq('status', 'active').maybeSingle();
  if (!t) throw notFound('Active tenancy not found');
  const { data: due } = await db.from('rent_payments').select('*').eq('tenancy_id', t.id).in('status', ['due', 'overdue']).order('due_date').limit(1).maybeSingle();
  if (!due) throw badRequest('No rent currently due', 'NOTHING_DUE');
  const dueKobo = Number(due.amount_kobo);
  const amount = amountKobo ?? dueKobo;
  if (amount <= 0) throw badRequest('Enter an amount to apply', 'BAD_AMOUNT');
  if (amount > dueKobo) throw badRequest('That is more than the rent currently due', 'BAD_AMOUNT');
  if (Number(plan.saved_kobo) < amount) throw badRequest('Your savings do not cover that amount', 'INSUFFICIENT_SAVINGS');
  const { error } = await db.rpc('rentsave_debit', { p_plan: plan.id, p_amount: amount });
  if (error) throw badRequest('Your savings do not cover that amount', 'INSUFFICIENT_SAVINGS');
  if (!(await settleRent(due.id, null, { amountKobo: amount }))) {
    await db.rpc('rentsave_add', { p_plan: plan.id, p_amount: amount }); // already paid elsewhere: put the money back
    throw badRequest('This rent was already paid', 'ALREADY_PAID');
  }
  res.json({ status: 'paid', paidKobo: amount, remainingKobo: dueKobo - amount });
});

/** Savings history (deposits) for the RentSave overview. */
r.get('/:id/history', async (req, res) => {
  const { data: plan } = await db.from('rentsave_plans').select('id').eq('id', req.params.id).eq('tenant_id', req.user.id).maybeSingle();
  if (!plan) throw notFound('Plan not found');
  const { data } = await db.from('payments').select('id, amount_kobo, paid_at, created_at, channel').eq('rentsave_plan_id', plan.id).eq('status', 'success').order('created_at', { ascending: false }).limit(30);
  res.json({ deposits: data ?? [] });
});

export default r;
