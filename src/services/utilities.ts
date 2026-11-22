import { db } from '../lib/supabase';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { vtpass, vtpassReady, type VtPayResult } from '../lib/vtpass';
import { notify } from './notify';

/**
 * Utility payments: airtime, data, electricity, cable TV, internet and exam PINs, delivered through VTpass.
 *
 * Money flow: the order is created → paid (card via Paystack, or wallet debit) → `startDelivery` moves it
 * awaiting_payment → processing exactly once → VTpass /pay. Delivered = done. Clearly failed = the full amount goes back
 * to the buyer's RentCreeb wallet. Unknown (timeout, "pending") stays processing and `requeryProcessing` (cron) asks
 * VTpass again; we never refund an order VTpass might still deliver.
 */
export type Category = 'airtime' | 'data' | 'electricity' | 'tv' | 'internet' | 'education';
export type Provider = {
  serviceId: string; name: string; short: string; color: string; category: Category;
  /** amount = buyer types the amount; plan = buyer picks a VTpass variation (price fixed by the plan). */
  pricing: 'amount' | 'plan';
  customer: { label: string; hint: string; kind: 'phone' | 'meter' | 'smartcard' | 'account' | 'profile' };
  /** Check the customer number with VTpass (shows the account name) before paying. */
  verify: boolean;
  minKobo?: number; maxKobo?: number; quickAmountsKobo?: number[];
};

const PHONE = { label: 'Phone number', hint: '080 1234 5678', kind: 'phone' as const };
const METER = { label: 'Meter number', hint: 'The number on your meter or bill', kind: 'meter' as const };
const CARD = (n: string) => ({ label: `${n} smartcard / IUC number`, hint: 'On the decoder or the back of the smartcard', kind: 'smartcard' as const });
const AIRTIME = { pricing: 'amount' as const, customer: PHONE, verify: false, minKobo: 5_000, maxKobo: 5_000_000, quickAmountsKobo: [10_000, 20_000, 50_000, 100_000, 200_000, 500_000] };
const DATA = { pricing: 'plan' as const, customer: PHONE, verify: false };
const POWER = { pricing: 'amount' as const, customer: METER, verify: true, minKobo: 100_000, maxKobo: 50_000_000, quickAmountsKobo: [200_000, 500_000, 1_000_000, 2_000_000, 5_000_000] };

export const PROVIDERS: Provider[] = [
  { serviceId: 'mtn', name: 'MTN', short: 'MTN', color: '#FFCC00', category: 'airtime', ...AIRTIME },
  { serviceId: 'airtel', name: 'Airtel', short: 'AT', color: '#E40000', category: 'airtime', ...AIRTIME },
  { serviceId: 'glo', name: 'Glo', short: 'GLO', color: '#00A651', category: 'airtime', ...AIRTIME },
  { serviceId: 'etisalat', name: '9mobile', short: '9M', color: '#006F3F', category: 'airtime', ...AIRTIME },

  { serviceId: 'mtn-data', name: 'MTN Data', short: 'MTN', color: '#FFCC00', category: 'data', ...DATA },
  { serviceId: 'airtel-data', name: 'Airtel Data', short: 'AT', color: '#E40000', category: 'data', ...DATA },
  { serviceId: 'glo-data', name: 'Glo Data', short: 'GLO', color: '#00A651', category: 'data', ...DATA },
  { serviceId: 'etisalat-data', name: '9mobile Data', short: '9M', color: '#006F3F', category: 'data', ...DATA },

  { serviceId: 'ikeja-electric', name: 'Ikeja Electric (IE)', short: 'IE', color: '#E30613', category: 'electricity', ...POWER },
  { serviceId: 'eko-electric', name: 'Eko Electric (EKEDC)', short: 'EKO', color: '#0D4E9B', category: 'electricity', ...POWER },
  { serviceId: 'abuja-electric', name: 'Abuja Electric (AEDC)', short: 'AE', color: '#0F7A3D', category: 'electricity', ...POWER },
  { serviceId: 'ibadan-electric', name: 'Ibadan Electric (IBEDC)', short: 'IB', color: '#F07C00', category: 'electricity', ...POWER },
  { serviceId: 'enugu-electric', name: 'Enugu Electric (EEDC)', short: 'EN', color: '#1B5FAA', category: 'electricity', ...POWER },
  { serviceId: 'portharcourt-electric', name: 'Port Harcourt Electric (PHED)', short: 'PH', color: '#00843D', category: 'electricity', ...POWER },
  { serviceId: 'benin-electric', name: 'Benin Electric (BEDC)', short: 'BE', color: '#7A1F86', category: 'electricity', ...POWER },
  { serviceId: 'kano-electric', name: 'Kano Electric (KEDCO)', short: 'KN', color: '#B8860B', category: 'electricity', ...POWER },
  { serviceId: 'kaduna-electric', name: 'Kaduna Electric', short: 'KD', color: '#2E7D32', category: 'electricity', ...POWER },
  { serviceId: 'jos-electric', name: 'Jos Electric (JED)', short: 'JS', color: '#C62828', category: 'electricity', ...POWER },
  { serviceId: 'aba-electric', name: 'Aba Power', short: 'ABA', color: '#455A64', category: 'electricity', ...POWER },
  { serviceId: 'yola-electric', name: 'Yola Electric (YEDC)', short: 'YL', color: '#6D4C41', category: 'electricity', ...POWER },

  { serviceId: 'dstv', name: 'DStv', short: 'DStv', color: '#0094D9', category: 'tv', pricing: 'plan', customer: CARD('DStv'), verify: true },
  { serviceId: 'gotv', name: 'GOtv', short: 'GOtv', color: '#2BA84A', category: 'tv', pricing: 'plan', customer: CARD('GOtv'), verify: true },
  { serviceId: 'startimes', name: 'StarTimes', short: 'ST', color: '#F7931E', category: 'tv', pricing: 'plan', customer: CARD('StarTimes'), verify: true },
  { serviceId: 'showmax', name: 'Showmax', short: 'SM', color: '#1A1A2E', category: 'tv', pricing: 'plan', customer: PHONE, verify: false },

  { serviceId: 'smile-direct', name: 'Smile', short: 'SML', color: '#E4007C', category: 'internet', pricing: 'plan', customer: { label: 'Smile account number', hint: 'Your Smile customer account ID', kind: 'account' }, verify: false },
  { serviceId: 'spectranet', name: 'Spectranet', short: 'SPN', color: '#6A1B9A', category: 'internet', pricing: 'plan', customer: { label: 'Phone number', hint: 'The phone number for your Spectranet account', kind: 'phone' }, verify: false },

  { serviceId: 'waec', name: 'WAEC Result Checker', short: 'WAEC', color: '#1565C0', category: 'education', pricing: 'plan', customer: { label: 'Phone number', hint: 'Where we can reach you about the PIN', kind: 'phone' }, verify: false },
  { serviceId: 'jamb', name: 'JAMB (UTME / DE)', short: 'JAMB', color: '#2E7D32', category: 'education', pricing: 'plan', customer: { label: 'JAMB profile ID', hint: 'Text NIN to 55019 to get it', kind: 'profile' }, verify: true },
];
export const CATEGORIES: { id: Category; label: string; icon: string; blurb: string }[] = [
  { id: 'airtime', label: 'Airtime', icon: 'phone-portrait-outline', blurb: 'Top up any network' },
  { id: 'data', label: 'Data', icon: 'wifi-outline', blurb: 'Daily, weekly, monthly bundles' },
  { id: 'electricity', label: 'Electricity', icon: 'flash-outline', blurb: 'Prepaid tokens & postpaid bills' },
  { id: 'tv', label: 'Cable TV', icon: 'tv-outline', blurb: 'DStv, GOtv, StarTimes, Showmax' },
  { id: 'internet', label: 'Internet', icon: 'globe-outline', blurb: 'Smile & Spectranet' },
  { id: 'education', label: 'Exam PINs', icon: 'school-outline', blurb: 'WAEC & JAMB' },
];
export const provider = (serviceId: string) => PROVIDERS.find((p) => p.serviceId === serviceId);
export const feeFor = (c: Category) => (c === 'airtime' || c === 'data' ? 0 : env.UTILITY_FEE_KOBO);
export const catalog = () => ({ enabled: vtpassReady(), feeKobo: env.UTILITY_FEE_KOBO, categories: CATEGORIES.map((c) => ({ ...c, feeKobo: feeFor(c.id), providers: PROVIDERS.filter((p) => p.category === c.id) })) });

/** Nigerian phone → 080XXXXXXXX (VTpass format). Null when it isn't one. */
export function normalizePhone(v: string) {
  const d = v.replace(/\D/g, '');
  const local = d.startsWith('234') && d.length === 13 ? `0${d.slice(3)}` : d.length === 10 && /^[789]/.test(d) ? `0${d}` : d;
  return /^0[789][01]\d{8}$/.test(local) ? local : null;
}

// ───────── plans (cached; prices change rarely) ─────────
export type Plan = { code: string; name: string; amountKobo: number };
const planCache = new Map<string, { at: number; plans: Plan[] }>();
export async function plans(serviceId: string): Promise<Plan[]> {
  const hit = planCache.get(serviceId);
  if (hit && Date.now() - hit.at < 3600_000) return hit.plans;
  const list = (await vtpass.variations(serviceId))
    .map((v) => ({ code: v.variation_code, name: v.name.trim(), amountKobo: Math.round(Number(v.variation_amount) * 100) }))
    .filter((v) => v.code && v.amountKobo > 0);
  planCache.set(serviceId, { at: Date.now(), plans: list });
  return list;
}

// ───────── customer check ─────────
export async function verifyCustomer(p: Provider, customerId: string, meterType?: string, planCode?: string) {
  const type = p.category === 'electricity' ? meterType : p.serviceId === 'jamb' ? planCode : undefined;
  const r = await vtpass.verify({ serviceID: p.serviceId, billersCode: customerId, ...(type ? { type } : {}) });
  const c = r.content ?? {};
  const name = c.Customer_Name ?? c.customer_name ?? c.Name ?? null;
  if (r.code !== '000' || c.error || c.WrongBillersCode || !name) return { ok: false as const, message: typeof c.error === 'string' ? c.error : `We couldn't find that ${p.customer.label.toLowerCase()}. Check it and try again.` };
  const renewal = Number(c.Renewal_Amount ?? 0);
  return {
    ok: true as const, customerName: String(name).trim(), address: c.Address ? String(c.Address).trim() : null,
    currentPlan: c.Current_Bouquet ? String(c.Current_Bouquet).trim() : null, dueDate: c.Due_Date ?? null,
    renewalKobo: renewal > 0 ? Math.round(renewal * 100) : null, minimumKobo: c.Minimum_Amount ? Math.round(Number(c.Minimum_Amount) * 100) : null,
  };
}

// ───────── delivery ─────────
const naira = (k: number | string) => `₦${(Number(k) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const label = (o: any) => [o.provider_name, o.variation_name].filter(Boolean).join(' Â· ');

function payParams(o: any) {
  const p = provider(o.service_id)!;
  const base = { request_id: o.request_id, serviceID: o.service_id, phone: o.phone || o.customer_id };
  const amt = Math.round(Number(o.amount_kobo) / 100); // VTpass takes whole naira
  if (p.category === 'airtime') return { ...base, amount: amt, phone: o.customer_id };
  if (p.category === 'electricity') return { ...base, billersCode: o.customer_id, variation_code: o.meter_type, amount: amt };
  if (o.service_id === 'dstv' || o.service_id === 'gotv') return { ...base, billersCode: o.customer_id, variation_code: o.variation_code, amount: amt, subscription_type: 'change' };
  if (o.service_id === 'waec') return { ...base, variation_code: o.variation_code, quantity: 1 };
  if (o.service_id === 'spectranet') return { ...base, billersCode: o.customer_id, variation_code: o.variation_code, amount: amt, quantity: 1 };
  return { ...base, billersCode: o.customer_id, variation_code: o.variation_code, amount: amt };
}

/** delivered / processing (ask again later) / failed (safe to refund). */
function outcome(r: VtPayResult): 'delivered' | 'processing' | 'failed' {
  const s = r.content?.transactions?.status?.toLowerCase();
  if (r.code === '000' && s === 'delivered') return 'delivered';
  if (s === 'failed' || s === 'reversed') return 'failed';
  if (r.code === '000' || r.code === '099' || s === 'pending' || s === 'initiated') return 'processing';
  return 'failed';
}

function tokenOf(r: VtPayResult, category: string) {
  if (category === 'electricity') {
    const t = r.mainToken ?? r.token ?? (r.purchased_code ? r.purchased_code.replace(/^\s*token\s*:\s*/i, '') : null);
    return { token: t ? String(t).trim() : null, units: r.mainTokenUnits ?? r.units ? String(r.mainTokenUnits ?? r.units) : null };
  }
  if (category === 'education') {
    const t = r.cards?.length ? r.cards.map((c) => [c.Serial && `Serial: ${c.Serial}`, c.Pin && `PIN: ${c.Pin}`].filter(Boolean).join('  ')).join('\n') : r.Pin ?? r.purchased_code ?? null;
    return { token: t ? String(t).trim() : null, units: null };
  }
  return { token: null, units: null };
}

async function markDelivered(o: any, r: VtPayResult) {
  const { token, units } = tokenOf(r, o.category);
  const { data } = await db.from('utility_orders').update({ status: 'delivered', delivered_at: new Date().toISOString(), updated_at: new Date().toISOString(), token, units,
    provider_ref: r.content?.transactions?.transactionId ?? o.provider_ref, provider_response: r as any, error: null }).eq('id', o.id).eq('status', 'processing').select('id').maybeSingle();
  if (!data) return;
  const what = o.category === 'electricity' && token ? `Your token: ${token}` : o.category === 'education' ? 'Your PIN is in the app.' : `${naira(o.amount_kobo)} sent to ${o.customer_id}.`;
  await notify(o.user_id, 'utility', `${label(o)} successful ✅`, what, { utilityOrderId: o.id });
}

/** Failed for sure: give the full amount (fee included) back to the buyer's wallet. Idempotent via the wallet reference. */
async function refund(o: any, reason: string, r?: VtPayResult) {
  const { data } = await db.from('utility_orders').update({ status: 'refunded', error: reason.slice(0, 300), updated_at: new Date().toISOString(), ...(r ? { provider_response: r as any } : {}) })
    .eq('id', o.id).eq('status', 'processing').select('id').maybeSingle();
  if (!data) return;
  await db.from('wallets').upsert({ user_id: o.user_id }, { onConflict: 'user_id', ignoreDuplicates: true });
  await db.rpc('wallet_credit', { p_user: o.user_id, p_amount: Number(o.total_kobo), p_kind: 'utility_refund', p_desc: `Refund – ${label(o)}`, p_ref: `util-refund:${o.id}` });
  await notify(o.user_id, 'utility', `${label(o)} failed`, `We couldn't complete it, so ${naira(o.total_kobo)} is back in your RentCreeb wallet. Use it for your next purchase or withdraw it.`, { utilityOrderId: o.id });
}

async function deliver(o: any) {
  let r: VtPayResult;
  try { r = await vtpass.pay(payParams(o) as any); }
  catch (err) { logger.warn({ err, order: o.id }, 'utility vend: no answer from VTpass, will requery'); return; }
  const out = outcome(r);
  if (out === 'delivered') return markDelivered(o, r);
  if (out === 'failed') return refund(o, r.response_description ?? 'Failed at provider', r);
  await db.from('utility_orders').update({ provider_ref: r.content?.transactions?.transactionId ?? null, provider_response: r as any, updated_at: new Date().toISOString() }).eq('id', o.id);
}

/** Paid → deliver. Runs once per order (awaiting_payment → processing is the lock). */
export async function startDelivery(orderId: string, paymentId?: string) {
  const { data: o } = await db.from('utility_orders').update({ status: 'processing', updated_at: new Date().toISOString(), attempts: 1, ...(paymentId ? { payment_id: paymentId } : {}) })
    .eq('id', orderId).eq('status', 'awaiting_payment').select('*').maybeSingle();
  if (o) await deliver(o);
}

/** Payment handler for purpose 'utility' (services/paymentProcessor.ts). */
export async function onUtilityPayment(p: { id: string; utility_order_id: string }) {
  if (p.utility_order_id) await startDelivery(p.utility_order_id, p.id);
}

/** Ask VTpass about one processing order. */
export async function requeryOrder(o: any) {
  let r: VtPayResult;
  try { r = await vtpass.requery(o.request_id); } catch (err) { logger.warn({ err, order: o.id }, 'utility requery failed'); return; }
  await db.from('utility_orders').update({ attempts: Number(o.attempts ?? 0) + 1, updated_at: new Date().toISOString() }).eq('id', o.id);
  // 015 = VTpass never saw this request_id: the /pay call didn't reach them, so it's safe to refund.
  if (r.code === '015') return refund(o, 'Not received by the provider', r);
  const out = outcome(r);
  if (out === 'delivered') return markDelivered(o, r);
  if (out === 'failed') return refund(o, r.response_description ?? 'Failed at provider', r);
}

/** Cron: re-check orders stuck in processing (VTpass slow or our call timed out). */
export async function requeryProcessing() {
  if (!vtpassReady()) return;
  try {
    const { data } = await db.from('utility_orders').select('*').eq('status', 'processing').lt('updated_at', new Date(Date.now() - 2 * 60_000).toISOString()).lt('attempts', 300).limit(50);
    for (const o of data ?? []) await requeryOrder(o);
  } catch (err) { logger.warn({ err }, 'utility requery job failed'); }
}
