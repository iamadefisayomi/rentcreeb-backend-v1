import { Router, type Request } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { db, dbError } from '../lib/supabase';
import { badRequest, notFound } from '../lib/errors';
import { uuid } from '../lib/common';
import { env } from '../config/env';
import { authenticate, requireRole } from '../middleware/auth';
import { notify } from '../services/notify';
import { DEFAULT_RENT_SETTINGS, lateFeeFor, settingsFor } from '../services/rentRules';

/**
 * Landlord rent rules (mounted at /api/v1/rent-rules) and the public certificate check page (mounted at /verify).
 *   GET  /rent-rules                       my reminder schedule + late-fee rule (defaults if never saved)
 *   PUT  /rent-rules                       save them
 *   POST /rent-rules/payments/:id/waive    remove the late fee from one rent payment
 *   GET  /verify/:code                     anyone: is this RentCreeb rental-history certificate genuine?
 */
export const rentRules = Router();
export const verifyPages = Router();
const MANAGERS = ['landlord', 'estate_manager'] as const;
const naira = (k: number) => `₦${Math.round(Number(k) / 100).toLocaleString('en-NG')}`;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const MIGRATION = 'Rent rules need a database update (migration 034). Ask the RentCreeb team.';

rentRules.use(authenticate, requireRole(...MANAGERS));

rentRules.get('/', async (req, res) => {
  const s = await settingsFor(req.user.id);
  res.json({ settings: s, example: { rentKobo: 50000000, lateFeeKobo: lateFeeFor(s, 50000000) } });
});

const days = z.array(z.number().int().min(1).max(60)).max(6).transform((a) => [...new Set(a)].sort((x, y) => y - x));
rentRules.put('/', async (req, res) => {
  const b = z.object({
    reminders_enabled: z.boolean(), remind_days_before: days, remind_on_due_day: z.boolean(), remind_days_after: days,
    late_fee_enabled: z.boolean(), late_fee_type: z.enum(['percent', 'fixed']),
    late_fee_value: z.number().min(0), late_fee_grace_days: z.number().int().min(0).max(90),
  }).parse({ ...DEFAULT_RENT_SETTINGS, ...req.body });
  if (b.late_fee_type === 'percent' && b.late_fee_value > 25) throw badRequest('A late fee above 25% of the rent is not allowed', 'FEE_TOO_HIGH');
  const { data, error } = await db.from('rent_settings').upsert({ landlord_id: req.user.id, ...b, updated_at: new Date().toISOString() }).select('*').single();
  if (error) { if (/rent_settings/.test(error.message)) throw badRequest(MIGRATION, 'MIGRATION_REQUIRED'); throw dbError(error); }
  res.json({ settings: data });
});

rentRules.post('/payments/:id/waive', async (req, res) => {
  const { data: rp } = await db.from('rent_payments').select('id, amount_kobo, late_fee_kobo, status, tenancies(id, landlord_id, tenant_id)').eq('id', uuid.parse(req.params.id)).maybeSingle();
  const t = (rp as any)?.tenancies;
  if (!rp || t?.landlord_id !== req.user.id) throw notFound('Rent payment not found');
  const fee = Number((rp as any).late_fee_kobo ?? 0);
  if (!fee || rp.status === 'paid') throw badRequest('There is no unpaid late fee on this rent', 'NO_FEE');
  await db.from('rent_payments').update({ amount_kobo: Number(rp.amount_kobo) - fee, late_fee_kobo: 0 }).eq('id', rp.id).neq('status', 'paid');
  if (t.tenant_id) await notify(t.tenant_id, 'late_fee', 'Late fee removed', `Your landlord removed the ${naira(fee)} late fee.`, { tenancyId: t.id });
  res.json({ status: 'waived', amountKobo: Number(rp.amount_kobo) - fee });
});

// ───────── Rental-history certificates ─────────
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { const b = randomBytes(8); let s = ''; for (const x of b) s += CODE_CHARS[x % CODE_CHARS.length]; return `RC-${s.slice(0, 4)}-${s.slice(4)}`; };
export const verifyUrl = (req: Request, code: string) => `${env.API_PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`}/verify/${code}`;

/** Record what a certificate says so anyone can check it later. Returns null if migration 034 is missing. */
export async function issueCertificate(userId: string, snapshot: Record<string, unknown>) {
  for (let i = 0; i < 3; i++) {
    const code = newCode();
    const { error } = await db.from('rent_certificates').insert({ code, user_id: userId, snapshot });
    if (!error) return code;
    if (!/duplicate|23505/.test(error.message + (error as any).code)) return null;
  }
  return null;
}

verifyPages.get('/:code', async (req, res) => {
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  const { data } = await db.from('rent_certificates').select('code, snapshot, created_at, revoked_at').eq('code', code).maybeSingle();
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  const shell = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RentCreeb certificate check</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7ff;color:#0b1533}main{max-width:560px;margin:0 auto;padding:24px}
.brand{font-weight:800;color:#2E62FF;font-size:18px}.ok,.bad{border-radius:16px;padding:16px;margin:16px 0;font-weight:700}.ok{background:#e7f8ee;color:#137a3a}.bad{background:#fdecec;color:#b42318}
.card{background:#fff;border-radius:16px;padding:16px;margin-top:12px;border:1px solid #e4e8f5}.row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:14px}.row span:first-child{color:#5b6488}
h2{font-size:16px;margin:0 0 6px}.muted{color:#5b6488;font-size:12.5px;line-height:1.5}</style></head><body><main><div class="brand">RentCreeb</div>${body}</main></body></html>`;
  if (!data) return res.status(404).send(shell(`<div class="bad">✗ No certificate with code ${esc(code)}</div><p class="muted">Check the code on the document. A certificate that cannot be found here was not issued by RentCreeb.</p>`));
  if (data.revoked_at) return res.send(shell(`<div class="bad">✗ Certificate ${esc(code)} was withdrawn</div>`));
  const s = data.snapshot as any;
  const items = (s.tenancies ?? []).map((t: any) => `<div class="card"><h2>${esc(t.property ?? 'Property')}${t.unit ? ` (${esc(t.unit)})` : ''}</h2>
    <div class="row"><span>Area</span><span>${esc(t.area ?? '-')}</span></div><div class="row"><span>Period</span><span>${esc(t.from)} to ${esc(t.to ?? 'present')}</span></div>
    <div class="row"><span>Rent</span><span>${esc(t.rent)}</span></div><div class="row"><span>Payments</span><span>${esc(t.payments.paid)} paid · ${esc(t.payments.onTime)} on time · ${esc(t.payments.late)} late</span></div></div>`).join('');
  res.send(shell(`<div class="ok">✓ Genuine RentCreeb certificate</div>
    <div class="card"><div class="row"><span>Name</span><span>${esc(s.name)}</span></div><div class="row"><span>Identity</span><span>${s.ninVerified ? 'Verified with NIN' : 'Not verified'}</span></div>
    <div class="row"><span>On-time payments</span><span>${esc(s.onTimePct ?? '-')}${s.onTimePct != null ? '%' : ''}</span></div>
    <div class="row"><span>Issued</span><span>${esc(new Date(data.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }))}</span></div>
    <div class="row"><span>Code</span><span>${esc(data.code)}</span></div></div>${items}
    <p class="muted">This page shows exactly what the certificate said when it was issued, from payment records kept on RentCreeb.</p>`));
});
