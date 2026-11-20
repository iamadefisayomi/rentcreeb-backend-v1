import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { uuid } from '../lib/common';
import { notFound } from '../lib/errors';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { createPayment } from '../services/payments';
import { isWebUrl } from '../lib/webAuth';

const r = Router();

/** Yearly billing = 12 months less 20% (Figma "Plan Select Yearly"), rounded to the naira. */
export const yearlyPrice = (monthlyKobo: number) => Math.round((monthlyKobo * 12 * 0.8) / 100) * 100;

r.get('/plans', async (_req, res) =>
  res.json({ plans: (await db.from('subscription_plans').select('*').eq('active', true).order('price_kobo')).data }));

r.get('/current', authenticate, requireRole('agent'), async (req, res) => {
  const { data } = await db.from('subscriptions').select('*, subscription_plans(*)').eq('agent_id', req.user.id)
    .in('status', ['active', 'expired']).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const active = !!data && data.status === 'active' && new Date(data.expires_at) > new Date();
  res.json({ subscription: data, active });
});

/** Pay via Paystack → webhook activates the plan. */
r.post('/checkout', authenticate, requireRole('agent'), requireVerified, async (req, res) => {
  const { planId, billing, callbackUrl } = z.object({ planId: uuid, billing: z.enum(['monthly', 'yearly']).default('monthly'), callbackUrl: z.string().max(500).refine(isWebUrl, 'Unsupported callback URL').optional() }).parse(req.body);
  const { data: plan } = await db.from('subscription_plans').select('*').eq('id', planId).eq('active', true).maybeSingle();
  if (!plan) throw notFound('Plan not found');
  const amount = billing === 'yearly' ? yearlyPrice(Number(plan.price_kobo)) : Number(plan.price_kobo);
  const sub = unwrap(await db.from('subscriptions').insert({ agent_id: req.user.id, plan_id: plan.id, billing_cycle: billing }).select().single());
  const payment = await createPayment(req.user, 'subscription', amount, { subscription_id: sub.id }, { callbackUrl });
  res.status(201).json({ subscription: sub, payment });
});

export default r;
