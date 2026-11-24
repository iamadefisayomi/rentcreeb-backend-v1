import { Router, type Response } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { db, dbError, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { addInterval, fullName, uuid } from '../lib/common';
import { signPrivateUrl } from '../lib/bunny';
import { authenticate, requireRole } from '../middleware/auth';
import { notify } from '../services/notify';
import { contentHash, defaultClauses, type Clause, type LeaseFields } from '../services/leaseTemplate';
import QRCode from 'qrcode';
import { issueCertificate, verifyUrl } from './rentRules.routes';

/**
 * Tenancy add-ons (mounted on /tenancies before the main tenancy routes):
 *   rent instalments · rent receipts & rental history · move-in/move-out condition reports · digital tenancy agreements
 */
const r = Router();
r.use(authenticate);
const MANAGERS = ['landlord', 'estate_manager'] as const;
const naira = (k: number | string) => (Number(k) / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dayStr = (d: Date) => d.toISOString().slice(0, 10);

async function tenancyFor(id: string, userId: string) {
  const { data } = await db.from('tenancies').select('*, properties(id, title, address, area, state, caution_fee_kobo), units(label), landlord:profiles!tenancies_landlord_id_fkey(id, first_name, last_name), tenant:profiles!tenancies_tenant_id_fkey(id, first_name, last_name)')
    .eq('id', id).maybeSingle();
  if (!data) throw notFound('Tenancy not found');
  if (![data.landlord_id, data.tenant_id].includes(userId)) throw forbidden();
  return data as any;
}
function pdfResponse(res: Response, filename: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(res);
  doc.fontSize(20).fillColor('#2563eb').text('RentCreeb', { continued: false }).fillColor('#000');
  return doc;
}
const row = (doc: PDFKit.PDFDocument, k: string, v: string) => doc.fontSize(10.5).fillColor('#666').text(k, { continued: true }).fillColor('#000').text(`   ${v}`).moveDown(0.35);

// ═════════ Rent instalments ═════════
r.get('/:id/instalments', async (req, res) => {
  const t = await tenancyFor(String(req.params.id), req.user.id);
  const { data, error } = await db.from('rent_instalment_plans').select('*').eq('tenancy_id', t.id).order('created_at', { ascending: false }).limit(10);
  if (error) throw dbError(error);
  const { data: parts } = await db.from('rent_payments').select('id, amount_kobo, due_date, status, paid_at, instalment_plan_id, instalment_no').eq('tenancy_id', t.id).not('instalment_plan_id', 'is', null).order('due_date');
  const { data: next } = await db.from('rent_payments').select('id, amount_kobo, due_date, status').eq('tenancy_id', t.id).in('status', ['due', 'overdue']).is('instalment_plan_id', null).order('due_date').limit(1).maybeSingle();
  res.json({ plans: (data ?? []).map((p: any) => ({ ...p, instalments: (parts ?? []).filter((x: any) => x.instalment_plan_id === p.id) })), nextRent: next ?? null, frequency: t.frequency });
});

/** Tenant asks to split the next rent payment into parts. The landlord approves or declines. */
r.post('/:id/instalments', requireRole('tenant'), async (req, res) => {
  const b = z.object({ parts: z.number().int().min(2).max(12), frequency: z.enum(['monthly', 'quarterly']).default('monthly'), note: z.string().trim().max(300).optional() }).parse(req.body);
  const t = await tenancyFor(String(req.params.id), req.user.id);
  if (t.tenant_id !== req.user.id || t.status !== 'active') throw forbidden();
  if (t.frequency === 'monthly') throw badRequest('Monthly rent is already paid in small parts', 'ALREADY_MONTHLY');
  const months = b.parts * (b.frequency === 'monthly' ? 1 : 3);
  const periodMonths = t.frequency === 'quarterly' ? 3 : 12;
  if (months > periodMonths) throw badRequest(`Pick a plan that finishes within ${periodMonths} months`, 'TOO_LONG');
  const { data: due } = await db.from('rent_payments').select('*').eq('tenancy_id', t.id).in('status', ['due', 'overdue']).is('instalment_plan_id', null).order('due_date').limit(1).maybeSingle();
  if (!due) throw badRequest('There is no upcoming rent to split', 'NOTHING_DUE');
  const today = dayStr(new Date());
  const plan = unwrap(await db.from('rent_instalment_plans').insert({
    tenancy_id: t.id, tenant_id: req.user.id, landlord_id: t.landlord_id, period_due_date: due.due_date, total_kobo: due.amount_kobo,
    parts: b.parts, frequency: b.frequency, first_due_date: due.due_date < today ? today : due.due_date, tenant_note: b.note ?? null,
  }).select().single().then((x) => { if (x.error?.code === '23505') throw conflict('You already have an instalment request for this tenancy', 'PLAN_EXISTS'); return x; }));
  await notify(t.landlord_id, 'tenancy_update', 'Instalment request', `${fullName(req.user) || 'Your tenant'} asked to pay ₦${naira(due.amount_kobo)} in ${b.parts} ${b.frequency} parts.`, { tenancyId: t.id });
  res.status(201).json({ plan });
});

r.post('/instalments/:planId/respond', requireRole(...MANAGERS), async (req, res) => {
  const b = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }).parse(req.body);
  const { data: plan } = await db.from('rent_instalment_plans').select('*').eq('id', uuid.parse(req.params.planId)).maybeSingle();
  if (!plan || plan.landlord_id !== req.user.id) throw notFound('Request not found');
  if (plan.status !== 'requested') throw badRequest('This request was already answered', 'BAD_STATE');
  if (!b.approve) {
    await db.from('rent_instalment_plans').update({ status: 'declined', landlord_note: b.note ?? null, responded_at: new Date().toISOString() }).eq('id', plan.id);
    await notify(plan.tenant_id, 'tenancy_update', 'Instalment request declined', b.note || 'Your landlord prefers the usual payment schedule.', { tenancyId: plan.tenancy_id });
    return res.json({ status: 'declined' });
  }
  // Replace the full rent due with the agreed parts (the remainder goes on the last part).
  const { data: original } = await db.from('rent_payments').select('id, amount_kobo, status').eq('tenancy_id', plan.tenancy_id).eq('due_date', plan.period_due_date).in('status', ['due', 'overdue']).is('instalment_plan_id', null).maybeSingle();
  if (!original || Number(original.amount_kobo) !== Number(plan.total_kobo)) throw badRequest('That rent was already paid or changed. Ask the tenant to request again.', 'STALE');
  const each = Math.floor(Number(plan.total_kobo) / plan.parts);
  const rows = Array.from({ length: plan.parts }, (_, i) => {
    let d = new Date(plan.first_due_date + 'T12:00:00');
    for (let k = 0; k < i; k++) d = addInterval(d, plan.frequency);
    return { tenancy_id: plan.tenancy_id, amount_kobo: i === plan.parts - 1 ? Number(plan.total_kobo) - each * (plan.parts - 1) : each, due_date: dayStr(d), status: 'due', instalment_plan_id: plan.id, instalment_no: i + 1 };
  });
  const ins = await db.from('rent_payments').insert(rows);
  if (ins.error) throw dbError(ins.error);
  await db.from('rent_payments').delete().eq('id', original.id);
  await db.from('rent_instalment_plans').update({ status: 'approved', landlord_note: b.note ?? null, responded_at: new Date().toISOString() }).eq('id', plan.id);
  await db.from('tenancies').update({ next_due_date: rows[0].due_date }).eq('id', plan.tenancy_id);
  await notify(plan.tenant_id, 'tenancy_update', 'Instalment plan approved 🎉', `Pay ₦${naira(rows[0].amount_kobo)} by ${rows[0].due_date}, then ${plan.parts - 1} more ${plan.frequency} part${plan.parts > 2 ? 's' : ''}.`, { tenancyId: plan.tenancy_id });
  res.json({ status: 'approved', instalments: rows });
});

r.post('/instalments/:planId/cancel', requireRole('tenant'), async (req, res) => {
  const { data } = await db.from('rent_instalment_plans').update({ status: 'cancelled', responded_at: new Date().toISOString() })
    .eq('id', uuid.parse(req.params.planId)).eq('tenant_id', req.user.id).eq('status', 'requested').select('id').maybeSingle();
  if (!data) throw badRequest('Only a request that has not been answered can be cancelled', 'BAD_STATE');
  res.json({ status: 'cancelled' });
});

// ═════════ Receipts & rental history ═════════
/** Receipt for any paid rent: paid in the app or recorded by the landlord (cash, transfer…). */
r.get('/rent-payments/:rpId/receipt.pdf', async (req, res) => {
  const { data: rp } = await db.from('rent_payments').select('*, tenancies(id, landlord_id, tenant_id, unit_label, frequency, invite_name, properties(title, address), landlord:profiles!tenancies_landlord_id_fkey(first_name, last_name), tenant:profiles!tenancies_tenant_id_fkey(first_name, last_name))')
    .eq('id', uuid.parse(req.params.rpId)).maybeSingle();
  const t = (rp as any)?.tenancies;
  if (!rp || !t || ![t.landlord_id, t.tenant_id].includes(req.user.id)) throw notFound('Receipt not found');
  if (rp.status !== 'paid') throw badRequest('This rent has not been paid yet', 'NOT_PAID');
  const doc = pdfResponse(res, `rent-receipt-${String(rp.id).slice(0, 8)}.pdf`);
  doc.fontSize(12).fillColor('#666').text('Rent receipt').moveDown(1.2).fillColor('#000');
  row(doc, 'Receipt no.', `RR-${String(rp.id).slice(0, 8).toUpperCase()}`);
  row(doc, 'Tenant', fullName(t.tenant ?? {}) || t.invite_name || '-');
  row(doc, 'Landlord', fullName(t.landlord ?? {}) || '-');
  row(doc, 'Property', `${t.unit_label ? t.unit_label + ', ' : ''}${t.properties?.title ?? ''}, ${t.properties?.address ?? ''}`);
  row(doc, 'Amount', `NGN ${naira(rp.amount_kobo)}`);
  if (Number((rp as any).late_fee_kobo)) row(doc, '  of which late fee', `NGN ${naira((rp as any).late_fee_kobo)}`);
  row(doc, 'For rent due', new Date(rp.due_date + 'T12:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }) + (rp.instalment_no ? ` (instalment ${rp.instalment_no})` : ''));
  row(doc, 'Paid on', new Date(rp.paid_at ?? rp.created_at).toLocaleString('en-NG'));
  row(doc, 'Method', String(rp.method ?? 'paystack').replace('_', ' ') + (rp.method && rp.method !== 'paystack' && rp.method !== 'rentsave' ? ' (recorded by landlord)' : ''));
  if (rp.reference) row(doc, 'Reference', rp.reference);
  doc.moveDown(1.5).fontSize(9).fillColor('#888').text('Issued by RentCreeb. This receipt confirms the payment shown above was recorded on RentCreeb.');
  doc.end();
});

async function historyFor(userId: string) {
  const { data: ts } = await db.from('tenancies').select('id, status, unit_label, lease_start, lease_end, rent_kobo, frequency, terminates_on, properties(title, area, address), landlord:profiles!tenancies_landlord_id_fkey(first_name, last_name), rent_payments(id, amount_kobo, due_date, status, paid_at, method, instalment_no)')
    .eq('tenant_id', userId).order('lease_start', { ascending: false });
  return (ts ?? []).map((t: any) => {
    const paid = (t.rent_payments ?? []).filter((p: any) => p.status === 'paid');
    const onTime = paid.filter((p: any) => p.paid_at && p.paid_at.slice(0, 10) <= p.due_date).length;
    return {
      id: t.id, status: t.status, property: t.properties?.title, area: t.properties?.area, unit: t.unit_label, landlord: fullName(t.landlord ?? {}) || null,
      from: t.lease_start, to: t.status === 'ended' ? (t.terminates_on ?? t.lease_end) : null, rent: `₦${naira(t.rent_kobo)} ${t.frequency}`,
      payments: { paid: paid.length, onTime, late: paid.length - onTime, overdueNow: (t.rent_payments ?? []).filter((p: any) => p.status === 'overdue').length, totalPaidKobo: paid.reduce((s: number, p: any) => s + Number(p.amount_kobo), 0) },
      rentPayments: (t.rent_payments ?? []).sort((a: any, b: any) => b.due_date.localeCompare(a.due_date)),
    };
  });
}
/** Tenant's rental history on RentCreeb (also the basis of their rental reference). */
r.get('/history', requireRole('tenant'), async (req, res) => {
  res.json({ tenancies: await historyFor(req.user.id) });
});
r.get('/history.pdf', requireRole('tenant'), async (req, res) => {
  const history = await historyFor(req.user.id);
  // Certificate: a code + QR anyone (a bank, an embassy, the next landlord) can check at /verify/<code>.
  const paidAll = history.reduce((s, h) => s + h.payments.paid, 0);
  const onTimeAll = history.reduce((s, h) => s + h.payments.onTime, 0);
  const onTimePct = paidAll ? Math.round((onTimeAll / paidAll) * 100) : null;
  const code = await issueCertificate(req.user.id, {
    name: fullName(req.user), ninVerified: !!(req.user as any).nin_verified, onTimePct,
    tenancies: history.map(({ rentPayments: _rp, ...h }) => h),
  });
  const qr = code ? await QRCode.toBuffer(verifyUrl(req, code), { width: 360, margin: 1 }) : null;
  const doc = pdfResponse(res, 'rentcreeb-rental-reference.pdf');
  doc.fontSize(12).fillColor('#666').text('Rental history certificate').moveDown(0.6).fillColor('#000');
  if (qr && code) {
    doc.image(qr, doc.page.width - 50 - 110, 45, { width: 110 });
    doc.fontSize(8).fillColor('#666').text(`Verify: ${code}`, doc.page.width - 50 - 130, 158, { width: 150, align: 'center' });
    doc.x = 50; doc.y = 90;
  }
  doc.fontSize(11).fillColor('#000').text(`${fullName(req.user)}${(req.user as any).nin_verified ? '  ·  Identity verified (NIN)' : ''}`).moveDown(0.2);
  if (onTimePct != null) doc.fontSize(11).text(`On-time rent payments: ${onTimePct}% (${onTimeAll} of ${paidAll})`).moveDown(0.2);
  doc.fontSize(9).fillColor('#666').text(`Generated ${new Date().toLocaleString('en-NG')} from records kept on RentCreeb.`).moveDown(0.2);
  if (code) doc.text(`Check this certificate is genuine: scan the QR code or visit ${verifyUrl(req, code)}`, { width: 330 });
  doc.fillColor('#000').moveDown(1.2);
  if (!history.length) doc.fontSize(11).text('No tenancies recorded on RentCreeb yet.');
  for (const h of history) {
    doc.fontSize(12.5).text(`${h.property ?? 'Property'}${h.unit ? ` (${h.unit})` : ''}`).moveDown(0.15);
    row(doc, 'Area', h.area ?? '-');
    row(doc, 'Period', `${h.from} to ${h.to ?? 'present'}`);
    row(doc, 'Rent', h.rent);
    row(doc, 'Payments', `${h.payments.paid} paid (${h.payments.onTime} on time, ${h.payments.late} late)${h.payments.overdueNow ? `, ${h.payments.overdueNow} overdue now` : ''}`);
    if (h.landlord) row(doc, 'Landlord', h.landlord);
    doc.moveDown(0.6);
  }
  doc.end();
});

// ═════════ Move-in / move-out condition reports ═════════
const item = z.object({
  room: z.string().trim().min(1).max(60), item: z.string().trim().min(1).max(80), condition: z.enum(['good', 'fair', 'poor', 'damaged']),
  note: z.string().trim().max(400).optional().default(''), photos: z.array(z.string().max(500)).max(6).default([]),
});
const withPhotos = (rep: any) => ({ ...rep, items: (rep.items ?? []).map((i: any) => ({ ...i, photoUrls: (i.photos ?? []).map((p: string) => { try { return signPrivateUrl(p, 3600); } catch { return null; } }).filter(Boolean) })) });

r.get('/:id/condition-reports', async (req, res) => {
  const t = await tenancyFor(String(req.params.id), req.user.id);
  const { data, error } = await db.from('condition_reports').select('*').eq('tenancy_id', t.id).order('created_at', { ascending: false });
  if (error) throw dbError(error);
  res.json({ reports: (data ?? []).map(withPhotos), role: t.landlord_id === req.user.id ? 'landlord' : 'tenant' });
});
r.post('/:id/condition-reports', async (req, res) => {
  const b = z.object({ kind: z.enum(['move_in', 'move_out']) }).parse(req.body);
  const t = await tenancyFor(String(req.params.id), req.user.id);
  const { data: open } = await db.from('condition_reports').select('id').eq('tenancy_id', t.id).eq('kind', b.kind).in('status', ['draft', 'submitted', 'disputed']).limit(1).maybeSingle();
  if (open) throw conflict(`There is already an open ${b.kind.replace('_', '-')} report`, 'REPORT_EXISTS');
  // Start from the move-in rooms when doing move-out, so both are easy to compare.
  let items: any[] = [];
  if (b.kind === 'move_out') {
    const { data: mi } = await db.from('condition_reports').select('items').eq('tenancy_id', t.id).eq('kind', 'move_in').eq('status', 'signed').order('created_at', { ascending: false }).limit(1).maybeSingle();
    items = (mi?.items ?? []).map((i: any) => ({ room: i.room, item: i.item, condition: i.condition, note: '', photos: [], moveIn: { condition: i.condition, note: i.note } }));
  }
  const rep = unwrap(await db.from('condition_reports').insert({ tenancy_id: t.id, kind: b.kind, created_by: req.user.id, items }).select().single());
  res.status(201).json({ report: withPhotos(rep) });
});
async function reportFor(id: string, userId: string) {
  const { data: rep } = await db.from('condition_reports').select('*, tenancies(id, landlord_id, tenant_id)').eq('id', id).maybeSingle();
  const t = (rep as any)?.tenancies;
  if (!rep || !t || ![t.landlord_id, t.tenant_id].includes(userId)) throw notFound('Report not found');
  return { rep: rep as any, t, role: t.landlord_id === userId ? 'landlord' as const : 'tenant' as const };
}
r.patch('/condition-reports/:rid', async (req, res) => {
  const b = z.object({ items: z.array(item).max(150).optional(), notes: z.string().trim().max(2000).optional() }).parse(req.body);
  const { rep } = await reportFor(String(req.params.rid), req.user.id);
  if (!['draft', 'disputed'].includes(rep.status)) throw badRequest('A submitted report can only be signed or disputed', 'LOCKED');
  // Photos must be the editor's own private uploads (POST /uploads?folder=user-docs).
  for (const i of b.items ?? []) for (const p of i.photos) if (!p.startsWith(`user-docs/${req.user.id}/`) && !(rep.items ?? []).some((x: any) => (x.photos ?? []).includes(p))) throw badRequest('Unknown photo', 'BAD_PHOTO');
  const saved = unwrap(await db.from('condition_reports').update({ ...(b.items ? { items: b.items.map((i, k) => ({ ...i, moveIn: (rep.items ?? [])[k]?.moveIn })) } : {}), ...(b.notes !== undefined ? { notes: b.notes } : {}), updated_at: new Date().toISOString() }).eq('id', rep.id).select().single());
  res.json({ report: withPhotos(saved) });
});
/** Submit = sign as the author and send to the other side to review and countersign (or dispute). */
r.post('/condition-reports/:rid/submit', async (req, res) => {
  const { signature } = z.object({ signature: z.string().trim().min(3).max(120) }).parse(req.body);
  const { rep, t, role } = await reportFor(String(req.params.rid), req.user.id);
  if (!['draft', 'disputed'].includes(rep.status)) throw badRequest('Already submitted', 'BAD_STATE');
  if (!(rep.items ?? []).length) throw badRequest('Add at least one room or item first', 'EMPTY');
  const now = new Date().toISOString();
  const patch = role === 'tenant' ? { tenant_signature: signature, tenant_signed_at: now, landlord_signature: null, landlord_signed_at: null } : { landlord_signature: signature, landlord_signed_at: now, tenant_signature: null, tenant_signed_at: null };
  await db.from('condition_reports').update({ ...patch, status: 'submitted', dispute_note: null, updated_at: now }).eq('id', rep.id);
  const other = role === 'tenant' ? t.landlord_id : t.tenant_id;
  if (other) await notify(other, 'tenancy_update', `${rep.kind === 'move_in' ? 'Move-in' : 'Move-out'} report to review`, 'Check the condition report and sign it, or raise what you disagree with.', { tenancyId: t.id });
  res.json({ status: 'submitted' });
});
r.post('/condition-reports/:rid/sign', async (req, res) => {
  const { signature } = z.object({ signature: z.string().trim().min(3).max(120) }).parse(req.body);
  const { rep, t, role } = await reportFor(String(req.params.rid), req.user.id);
  if (rep.status !== 'submitted') throw badRequest('Nothing to sign', 'BAD_STATE');
  if ((role === 'tenant' && rep.tenant_signed_at) || (role === 'landlord' && rep.landlord_signed_at)) throw badRequest('You already signed; waiting for the other side', 'ALREADY_SIGNED');
  const now = new Date().toISOString();
  await db.from('condition_reports').update({ ...(role === 'tenant' ? { tenant_signature: signature, tenant_signed_at: now } : { landlord_signature: signature, landlord_signed_at: now }), status: 'signed', updated_at: now }).eq('id', rep.id);
  const other = role === 'tenant' ? t.landlord_id : t.tenant_id;
  if (other) await notify(other, 'tenancy_update', 'Condition report signed ✅', `The ${rep.kind.replace('_', '-')} report is signed by both of you.`, { tenancyId: t.id });
  res.json({ status: 'signed' });
});
r.post('/condition-reports/:rid/dispute', async (req, res) => {
  const { note } = z.object({ note: z.string().trim().min(5).max(1000) }).parse(req.body);
  const { rep, t, role } = await reportFor(String(req.params.rid), req.user.id);
  if (rep.status !== 'submitted') throw badRequest('Nothing to dispute', 'BAD_STATE');
  await db.from('condition_reports').update({ status: 'disputed', dispute_note: note, updated_at: new Date().toISOString() }).eq('id', rep.id);
  const other = role === 'tenant' ? t.landlord_id : t.tenant_id;
  if (other) await notify(other, 'tenancy_update', 'Condition report disputed', note.slice(0, 140), { tenancyId: t.id });
  res.json({ status: 'disputed' });
});
r.get('/condition-reports/:rid/pdf', async (req, res) => {
  const { rep } = await reportFor(String(req.params.rid), req.user.id);
  const doc = pdfResponse(res, `${rep.kind}-report.pdf`);
  doc.fontSize(12).fillColor('#666').text(`${rep.kind === 'move_in' ? 'Move-in' : 'Move-out'} condition report · ${rep.status}`).moveDown(1).fillColor('#000');
  let room = '';
  for (const i of rep.items ?? []) {
    if (i.room !== room) { room = i.room; doc.moveDown(0.4).fontSize(12.5).text(room).moveDown(0.2); }
    row(doc, `  ${i.item}`, `${i.condition}${i.moveIn ? ` (move-in: ${i.moveIn.condition})` : ''}${i.note ? ` · ${i.note}` : ''}${(i.photos ?? []).length ? ` · ${i.photos.length} photo(s) in app` : ''}`);
  }
  if (rep.notes) doc.moveDown(0.5).fontSize(10.5).text(`Notes: ${rep.notes}`);
  doc.moveDown(1);
  row(doc, 'Tenant signature', rep.tenant_signature ? `${rep.tenant_signature} · ${new Date(rep.tenant_signed_at).toLocaleString('en-NG')}` : 'not signed');
  row(doc, 'Landlord signature', rep.landlord_signature ? `${rep.landlord_signature} · ${new Date(rep.landlord_signed_at).toLocaleString('en-NG')}` : 'not signed');
  doc.end();
});

// ═════════ Digital tenancy agreements ═════════
async function leaseFor(id: string, userId: string) {
  const { data: l } = await db.from('lease_agreements').select('*').eq('id', id).maybeSingle();
  if (!l || ![l.landlord_id, l.tenant_id].includes(userId)) throw notFound('Agreement not found');
  return l as any;
}
r.get('/:id/leases', async (req, res) => {
  const t = await tenancyFor(String(req.params.id), req.user.id);
  let q = db.from('lease_agreements').select('*').eq('tenancy_id', t.id).order('created_at', { ascending: false });
  if (t.tenant_id === req.user.id) q = q.neq('status', 'draft'); // tenants see agreements once sent
  const { data, error } = await q;
  if (error) throw dbError(error);
  res.json({ leases: data ?? [], role: t.landlord_id === req.user.id ? 'landlord' : 'tenant' });
});
/** Landlord starts an agreement, pre-filled from the tenancy. */
r.post('/:id/leases', requireRole(...MANAGERS), async (req, res) => {
  const t = await tenancyFor(String(req.params.id), req.user.id);
  if (t.landlord_id !== req.user.id) throw forbidden();
  const fields: LeaseFields = {
    landlordName: fullName(t.landlord ?? {}) || 'The Landlord', tenantName: fullName(t.tenant ?? {}) || t.invite_name || 'The Tenant',
    propertyAddress: [t.properties?.title, t.properties?.address].filter(Boolean).join(', '), unitLabel: t.unit_label ?? t.units?.label ?? null,
    rentNaira: naira(t.rent_kobo), frequency: t.frequency, startDate: t.lease_start, endDate: t.lease_end,
    cautionNaira: t.properties?.caution_fee_kobo ? naira(t.properties.caution_fee_kobo) : null, state: t.properties?.state ?? 'Lagos',
  };
  const lease = unwrap(await db.from('lease_agreements').insert({ tenancy_id: t.id, landlord_id: t.landlord_id, tenant_id: t.tenant_id, fields, clauses: defaultClauses(fields) }).select().single());
  res.status(201).json({ lease });
});
r.get('/leases/:lid', async (req, res) => {
  const l = await leaseFor(String(req.params.lid), req.user.id);
  if (l.tenant_id === req.user.id && l.status === 'draft') throw notFound('Agreement not found');
  res.json({ lease: l, role: l.landlord_id === req.user.id ? 'landlord' : 'tenant', hashOk: !l.content_hash || l.content_hash === contentHash(l.fields, l.clauses) });
});
const clauseSchema = z.object({ heading: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(4000) });
r.patch('/leases/:lid', requireRole(...MANAGERS), async (req, res) => {
  const b = z.object({ title: z.string().trim().min(2).max(120).optional(), clauses: z.array(clauseSchema).min(1).max(60).optional() }).parse(req.body);
  const l = await leaseFor(String(req.params.lid), req.user.id);
  if (l.landlord_id !== req.user.id) throw forbidden();
  if (!['draft', 'declined'].includes(l.status)) throw badRequest('A sent or signed agreement cannot be edited. Void it and start a new one.', 'LOCKED');
  res.json({ lease: unwrap(await db.from('lease_agreements').update({ ...b, status: 'draft', updated_at: new Date().toISOString() }).eq('id', l.id).select().single()) });
});
/** Landlord signs and sends to the tenant. */
r.post('/leases/:lid/send', requireRole(...MANAGERS), async (req, res) => {
  const { signature } = z.object({ signature: z.string().trim().min(3).max(120) }).parse(req.body);
  const l = await leaseFor(String(req.params.lid), req.user.id);
  if (l.landlord_id !== req.user.id) throw forbidden();
  if (!['draft', 'declined'].includes(l.status)) throw badRequest('Already sent', 'BAD_STATE');
  if (!l.tenant_id) throw badRequest('The tenant has not joined RentCreeb yet. Send it once they sign up with the invited email or phone.', 'NO_TENANT');
  const now = new Date().toISOString();
  await db.from('lease_agreements').update({ status: 'sent', landlord_signature: signature, landlord_signed_at: now, tenant_signature: null, tenant_signed_at: null, declined_reason: null, sent_at: now, content_hash: contentHash(l.fields, l.clauses), updated_at: now }).eq('id', l.id);
  await notify(l.tenant_id, 'lease_agreement', 'Tenancy agreement to sign', `${l.title}: read it and sign in the app.`, { tenancyId: l.tenancy_id, leaseId: l.id });
  res.json({ status: 'sent' });
});
r.post('/leases/:lid/sign', requireRole('tenant'), async (req, res) => {
  const { signature, agree } = z.object({ signature: z.string().trim().min(3).max(120), agree: z.literal(true) }).parse(req.body);
  const l = await leaseFor(String(req.params.lid), req.user.id);
  if (l.tenant_id !== req.user.id) throw forbidden();
  if (l.status !== 'sent') throw badRequest('Nothing to sign', 'BAD_STATE');
  if (l.content_hash !== contentHash(l.fields, l.clauses)) throw conflict('This agreement changed after it was sent. Ask your landlord to resend it.', 'CHANGED');
  await db.from('lease_agreements').update({ status: 'signed', tenant_signature: signature, tenant_signed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', l.id);
  await notify(l.landlord_id, 'lease_agreement', 'Tenancy agreement signed ✅', `${fullName(req.user) || 'Your tenant'} signed ${l.title}.`, { tenancyId: l.tenancy_id, leaseId: l.id });
  res.json({ status: 'signed' });
});
r.post('/leases/:lid/decline', requireRole('tenant'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);
  const l = await leaseFor(String(req.params.lid), req.user.id);
  if (l.tenant_id !== req.user.id || l.status !== 'sent') throw badRequest('Nothing to decline', 'BAD_STATE');
  await db.from('lease_agreements').update({ status: 'declined', declined_reason: reason, updated_at: new Date().toISOString() }).eq('id', l.id);
  await notify(l.landlord_id, 'lease_agreement', 'Changes requested on the agreement', reason.slice(0, 140), { tenancyId: l.tenancy_id, leaseId: l.id });
  res.json({ status: 'declined' });
});
r.post('/leases/:lid/void', requireRole(...MANAGERS), async (req, res) => {
  const l = await leaseFor(String(req.params.lid), req.user.id);
  if (l.landlord_id !== req.user.id || l.status === 'void') throw badRequest('Nothing to void', 'BAD_STATE');
  await db.from('lease_agreements').update({ status: 'void', updated_at: new Date().toISOString() }).eq('id', l.id);
  if (l.tenant_id && l.status !== 'draft') await notify(l.tenant_id, 'lease_agreement', 'Agreement withdrawn', `${l.title} was withdrawn by your landlord.`, { tenancyId: l.tenancy_id, leaseId: l.id });
  res.json({ status: 'void' });
});
r.get('/leases/:lid/pdf', async (req, res) => {
  const l = await leaseFor(String(req.params.lid), req.user.id);
  if (l.tenant_id === req.user.id && l.status === 'draft') throw notFound('Agreement not found');
  const doc = pdfResponse(res, `tenancy-agreement-${String(l.id).slice(0, 8)}.pdf`);
  doc.moveDown(0.5).fontSize(16).text(l.title, { align: 'center' }).moveDown(0.3);
  doc.fontSize(9).fillColor('#666').text(l.status === 'signed' ? 'Signed electronically on RentCreeb' : `Status: ${l.status}`, { align: 'center' }).fillColor('#000').moveDown(1);
  (l.clauses as Clause[]).forEach((c, i) => { doc.fontSize(11.5).text(`${i + 1}. ${c.heading}`).moveDown(0.2); doc.fontSize(10.5).text(c.body, { align: 'justify' }).moveDown(0.7); });
  doc.moveDown(1);
  row(doc, 'Landlord', l.landlord_signature ? `${l.landlord_signature} · signed ${new Date(l.landlord_signed_at).toLocaleString('en-NG')}` : 'not signed');
  row(doc, 'Tenant', l.tenant_signature ? `${l.tenant_signature} · signed ${new Date(l.tenant_signed_at).toLocaleString('en-NG')}` : 'not signed');
  if (l.content_hash) doc.moveDown(0.5).fontSize(8).fillColor('#888').text(`Document fingerprint (SHA-256): ${l.content_hash}`);
  doc.end();
});

export default r;
