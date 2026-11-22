import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { kobo, uuid } from '../lib/common';
import { authenticate, requireRole } from '../middleware/auth';
import { notify } from '../services/notify';
import { logMaintenance, SLA_HOURS } from '../services/maintenance';
import { approverOf, cancelOrder, cancelPolicy, createJobForRequest, payerOf } from '../services/jobOrders';

const r = Router();
r.use(authenticate);
const SELECT = '*, maintenance_media(url), properties(id, title, address), tenancies(unit_label, units(label)), ' +
  'tenant:profiles!maintenance_requests_tenant_id_fkey(id, first_name, last_name, phone, avatar_url), ' +
  'jobs(id, status, artisan_id, title, accepted_quote_id, revised_amount_kobo, revision_status, landlord_id, tenant_id, created_by, payer, budget_min_kobo, budget_max_kobo, artisan:profiles!jobs_artisan_id_fkey(id, first_name, last_name, phone, avatar_url, rating_avg, rating_count))' as '*'; // concatenated → tell supabase-js to treat rows as untyped
const LANDLORDS = ['landlord', 'estate_manager'] as const;
const OPEN = ['open', 'job_posted', 'in_progress'];

/** What the signed-in user may do on this order (the app shows buttons from this). */
function viewerFlags(userId: string, m: any, job: any | null) {
  const isLandlord = userId === m.landlord_id;
  const cancel = cancelPolicy(userId, m, job);
  const waitingOnLandlord = m.status === 'open' && m.funding === 'landlord' && (m.funding_status ?? 'pending') === 'pending';
  const declined = m.status === 'open' && m.funding === 'landlord' && m.funding_status === 'declined';
  return {
    role: isLandlord ? 'landlord' : 'tenant', createdBy: m.created_by ?? 'tenant', funding: m.funding ?? 'landlord', fundingStatus: m.funding_status ?? null,
    isPayer: job ? payerOf(job) === userId : (m.funding === 'tenant' ? !isLandlord : isLandlord),
    isApprover: job ? approverOf(job) === userId : (m.created_by === 'landlord' ? isLandlord : !isLandlord),
    canDecideFunding: isLandlord && waitingOnLandlord,
    canSelfFund: !isLandlord && m.created_by !== 'landlord' && (waitingOnLandlord || declined),
    canResubmit: !isLandlord && declined,
    canCancel: cancel.allowed, cancelBlockedReason: cancel.allowed ? null : cancel.reason ?? null,
  };
}

/** Adds the fields the oversight screens show: unit label, SLA state, artisan, ticket age. */
function ticketView(m: any) {
  const job = (m.jobs ?? [])[0] ?? null;
  const open = OPEN.includes(m.status);
  const now = Date.now();
  return {
    ...m,
    unitLabel: m.tenancies?.units?.label ?? m.tenancies?.unit_label ?? null,
    slaOverdue: open && !!m.sla_due_at && new Date(m.sla_due_at).getTime() < now,
    slaHoursLeft: open && m.sla_due_at ? Math.round((new Date(m.sla_due_at).getTime() - now) / 36e5) : null,
    stage: m.status === 'completed' ? 'completed' : m.status === 'open' ? 'pending' : open ? 'in_progress' : m.status,
    artisan: job?.artisan ?? null,
    job,
  };
}

/**
 * Tenant: photo upload → category → submit. They choose who pays:
 *   funding 'tenant'   → posted to artisans straight away (needs a budget); the landlord is told and can cancel.
 *   funding 'landlord' → waits for the landlord to accept paying.
 */
r.post('/', requireRole('tenant'), async (req, res) => {
  const b = z.object({
    tenancyId: uuid, category: z.string().min(2), description: z.string().min(5),
    urgency: z.enum(['standard', 'urgent']).default('standard'), mediaUrls: z.array(z.string().url()).max(6).default([]),
    // Tenant's own read of how urgent it is (Figma: Low / Medium / High / Emergency). Landlords can change it later.
    priority: z.enum(['low', 'medium', 'high', 'emergency']).optional(),
    funding: z.enum(['tenant', 'landlord']).default('landlord'),
    budgetMinKobo: kobo.optional(), budgetMaxKobo: kobo.optional(), accessNotes: z.string().max(500).optional(),
  }).parse(req.body);
  if (b.funding === 'tenant' && (!b.budgetMinKobo || !b.budgetMaxKobo)) throw badRequest('Set your budget range so artisans can quote', 'BUDGET_REQUIRED');
  if (b.funding === 'tenant' && b.budgetMinKobo! > b.budgetMaxKobo!) throw badRequest('Min budget cannot exceed max');
  const urgency = b.priority ? (b.priority === 'high' || b.priority === 'emergency' ? 'urgent' : 'standard') : b.urgency;
  const { data: t } = await db.from('tenancies').select('*').eq('id', b.tenancyId).eq('tenant_id', req.user.id).eq('status', 'active').maybeSingle();
  if (!t) throw notFound('Active tenancy not found');
  const selfPay = b.funding === 'tenant';
  const m = unwrap(await db.from('maintenance_requests').insert({
    tenancy_id: t.id, property_id: t.property_id, tenant_id: req.user.id, landlord_id: t.landlord_id,
    category: b.category, description: b.description, urgency, ...(b.priority ? { priority: b.priority } : {}),
    created_by: 'tenant', funding: b.funding, funding_status: selfPay ? null : 'pending',
    status: selfPay ? 'job_posted' : 'open' }).select().single());
  if (b.mediaUrls.length) await db.from('maintenance_media').insert(b.mediaUrls.map((url) => ({ request_id: m.id, url })));
  await logMaintenance(m.id, req.user.id, 'submitted', 'Job order created by tenant');
  let job = null;
  if (selfPay) {
    job = await createJobForRequest(m, { payer: 'tenant', budgetMinKobo: b.budgetMinKobo!, budgetMaxKobo: b.budgetMaxKobo!, urgency, accessNotes: b.accessNotes });
    await logMaintenance(m.id, req.user.id, 'self_funded', 'Tenant is paying — posted to artisans');
    await notify(t.landlord_id, 'maintenance_request', 'Your tenant ordered a repair', `${b.category}: ${b.description.slice(0, 80)} · The tenant is paying. You can view or cancel it.`, { requestId: m.id });
  } else {
    await logMaintenance(m.id, req.user.id, 'funding_requested', 'Tenant asked the landlord to pay');
    await notify(t.landlord_id, 'maintenance_request', 'Repair request: will you pay?', `${b.category}: ${b.description.slice(0, 80)} · Your tenant asked you to cover the cost.`, { requestId: m.id });
  }
  res.status(201).json({ request: { ...m, jobs: job ? [job] : [] }, job });
});

/**
 * Tenant: their requests. Landlord: oversight list + summary.
 * ?status=open,job_posted  ?stage=pending|in_progress|completed|overdue  ?propertyId=
 */
r.get('/', async (req, res) => {
  const f = z.object({ status: z.string().optional(), stage: z.enum(['pending', 'in_progress', 'completed', 'overdue']).optional(), propertyId: uuid.optional() }).parse(req.query);
  const col = req.user.role === 'tenant' ? 'tenant_id' : 'landlord_id';
  let q = db.from('maintenance_requests').select(SELECT).eq(col, req.user.id).order('created_at', { ascending: false });
  if (f.status) q = q.in('status', f.status.split(','));
  if (f.propertyId) q = q.eq('property_id', f.propertyId);
  const all = ((await q).data ?? []).map(ticketView);
  const monthAgo = Date.now() - 30 * 864e5;
  const summary = {
    open: all.filter((m) => m.stage === 'pending').length,
    inProgress: all.filter((m) => m.stage === 'in_progress').length,
    resolved30d: all.filter((m) => m.status === 'completed' && new Date(m.resolved_at ?? m.created_at).getTime() >= monthAgo).length,
    slaOverdue: all.filter((m) => m.slaOverdue).length,
  };
  const requests = f.stage === 'overdue' ? all.filter((m) => m.slaOverdue) : f.stage ? all.filter((m) => m.stage === f.stage) : all;
  res.json({ requests, summary });
});

/** Repair status tracking: request + linked job + timeline. */
r.get('/:id', async (req, res) => {
  const { data } = await db.from('maintenance_requests').select(SELECT).eq('id', req.params.id).maybeSingle();
  if (!data) throw notFound('Request not found');
  if (![data.tenant_id, data.landlord_id].includes(req.user.id)) throw forbidden();
  const job = (data as any).jobs?.[0];
  const stages = ['open', 'job_posted', 'assigned', 'diagnosing', 'awaiting_approval', 'approved', 'in_progress', 'awaiting_confirmation', 'completed'];
  const current = job ? job.status : data.status === 'rejected' ? 'rejected' : data.status;
  const [{ data: events }, { data: report }] = await Promise.all([
    db.from('maintenance_events').select('kind, note, created_at, actor:profiles!maintenance_events_actor_id_fkey(first_name, last_name, role)').eq('request_id', data.id).order('created_at'),
    job ? db.from('job_reports').select('*').eq('job_id', job.id).order('created_at', { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  res.json({ request: ticketView(data), job: job ?? null, report, events: events ?? [], timeline: { stages, current }, viewer: viewerFlags(req.user.id, data, job ?? null) });
});

/** Landlord changes a ticket's priority; the SLA deadline is recomputed from when it was opened. */
r.patch('/:id', requireRole(...LANDLORDS), async (req, res) => {
  const { priority } = z.object({ priority: z.enum(['low', 'medium', 'high', 'emergency']) }).parse(req.body);
  const { data: m } = await db.from('maintenance_requests').select('id, landlord_id, created_at, priority').eq('id', String(req.params.id)).maybeSingle();
  if (!m || m.landlord_id !== req.user.id) throw notFound('Request not found');
  const sla = new Date(new Date(m.created_at).getTime() + SLA_HOURS[priority] * 36e5).toISOString();
  await db.from('maintenance_requests').update({ priority, sla_due_at: sla }).eq('id', m.id);
  if (priority !== m.priority) await logMaintenance(m.id, req.user.id, 'priority_changed', `Priority set to ${priority}`);
  res.json({ priority, slaDueAt: sla });
});

/** Landlord escalates a stuck ticket: flags it, alerts the assigned artisan and RentCreeb support. */
r.post('/:id/escalate', requireRole(...LANDLORDS), async (req, res) => {
  const { note } = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const { data: m } = await db.from('maintenance_requests').select(SELECT).eq('id', String(req.params.id)).maybeSingle();
  if (!m || m.landlord_id !== req.user.id) throw notFound('Request not found');
  if (!OPEN.includes(m.status)) throw badRequest('Only open tickets can be escalated', 'BAD_STATE');
  await db.from('maintenance_requests').update({ escalated_at: new Date().toISOString(), priority: m.priority === 'emergency' ? 'emergency' : 'high' }).eq('id', m.id);
  await logMaintenance(m.id, req.user.id, 'escalated', note ?? 'Escalated by landlord');
  const job = (m as any).jobs?.[0];
  if (job?.artisan_id) await notify(job.artisan_id, 'maintenance_update', 'Repair escalated', `The landlord escalated ${m.ticket_no}. Please update them as soon as possible.`, { jobId: job.id });
  const { data: admins } = await db.from('profiles').select('id').eq('role', 'admin');
  for (const a of admins ?? []) await notify(a.id, 'maintenance_escalated', `Escalated: ${m.ticket_no}`, note ?? m.description.slice(0, 120), { requestId: m.id });
  res.json({ escalated: true });
});

/**
 * Landlord marks a ticket resolved. Tickets with an artisan job are resolved by confirming the job's completion
 * (which releases escrow) — this endpoint handles tickets fixed without one.
 */
r.post('/:id/resolve', requireRole(...LANDLORDS), async (req, res) => {
  const { note } = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const { data: m } = await db.from('maintenance_requests').select(SELECT).eq('id', String(req.params.id)).maybeSingle();
  if (!m || m.landlord_id !== req.user.id) throw notFound('Request not found');
  const job = (m as any).jobs?.[0];
  if (job && !['completed', 'cancelled'].includes(job.status)) throw conflict('Confirm the artisan’s completion on the job to resolve this ticket', 'JOB_IN_PROGRESS');
  if (!OPEN.includes(m.status)) throw badRequest('This ticket is already closed', 'BAD_STATE');
  await db.from('maintenance_requests').update({ status: 'completed', resolved_at: new Date().toISOString() }).eq('id', m.id);
  await logMaintenance(m.id, req.user.id, 'resolved', note ?? 'Marked as resolved by landlord');
  await notify(m.tenant_id, 'maintenance_update', 'Repair marked as resolved', `${m.ticket_no}: ${m.category}`, { requestId: m.id });
  res.json({ status: 'completed' });
});

/** Landlord accepts paying for the tenant's request and posts it to artisans (budget range). */
r.post('/:id/post-job', requireRole('landlord', 'estate_manager'), async (req, res) => {
  const b = z.object({ budgetMinKobo: kobo, budgetMaxKobo: kobo, urgency: z.enum(['standard', 'urgent']).optional(), accessNotes: z.string().optional() }).parse(req.body);
  if (b.budgetMinKobo > b.budgetMaxKobo) throw badRequest('Min budget cannot exceed max');
  const { data: m } = await db.from('maintenance_requests').select('*').eq('id', req.params.id).maybeSingle();
  if (!m) throw notFound('Request not found');
  if (m.landlord_id !== req.user.id) throw forbidden();
  if (m.status !== 'open') throw badRequest('Request already processed', 'BAD_STATE');
  const job = await createJobForRequest(m, { payer: 'landlord', budgetMinKobo: b.budgetMinKobo, budgetMaxKobo: b.budgetMaxKobo, urgency: b.urgency, accessNotes: b.accessNotes });
  await db.from('maintenance_requests').update({ status: 'job_posted', funding: 'landlord', funding_status: 'accepted' }).eq('id', m.id);
  await logMaintenance(m.id, req.user.id, 'funding_accepted', 'Landlord agreed to pay — posted to artisans');
  await notify(m.tenant_id, 'maintenance_update', 'Your landlord will pay for the repair', `${m.ticket_no ?? m.category}: they're finding an artisan now.`, { requestId: m.id });
  res.status(201).json({ job });
});

/** Landlord declines paying. The request stays open: the tenant can pay themselves, edit and resend, or cancel. */
async function declineFunding(req: any, res: any) {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
  const { data: m } = await db.from('maintenance_requests').update({ funding_status: 'declined', funding_note: reason, rejection_reason: reason })
    .eq('id', req.params.id).eq('landlord_id', req.user.id).eq('status', 'open').select().maybeSingle();
  if (!m) throw notFound('Open request not found');
  await logMaintenance(m.id, req.user.id, 'funding_declined', `Landlord declined to pay: ${reason}`);
  await notify(m.tenant_id, 'maintenance_update', 'Your landlord declined to pay', `${m.ticket_no ?? m.category}: “${reason}”. You can pay for it yourself, edit and resend, or cancel.`, { requestId: m.id });
  res.json({ request: m });
}
r.post('/:id/decline-funding', requireRole('landlord', 'estate_manager'), declineFunding);
r.post('/:id/reject', requireRole('landlord', 'estate_manager'), declineFunding); // older app builds

/** Tenant decides to pay themselves (instead of waiting, or after the landlord declined). */
r.post('/:id/self-fund', requireRole('tenant'), async (req, res) => {
  const b = z.object({ budgetMinKobo: kobo, budgetMaxKobo: kobo, accessNotes: z.string().max(500).optional() }).parse(req.body);
  const { data: m } = await db.from('maintenance_requests').select('*').eq('id', req.params.id).eq('tenant_id', req.user.id).maybeSingle();
  if (!m) throw notFound('Request not found');
  if (m.status !== 'open' || m.created_by === 'landlord') throw badRequest('This request can no longer be changed', 'BAD_STATE');
  const job = await createJobForRequest(m, { payer: 'tenant', budgetMinKobo: b.budgetMinKobo, budgetMaxKobo: b.budgetMaxKobo, accessNotes: b.accessNotes });
  await db.from('maintenance_requests').update({ status: 'job_posted', funding: 'tenant', funding_status: null }).eq('id', m.id);
  await logMaintenance(m.id, req.user.id, 'self_funded', 'Tenant chose to pay — posted to artisans');
  await notify(m.landlord_id, 'maintenance_update', 'Your tenant will pay for the repair', `${m.ticket_no ?? m.category}: posted to artisans. You can view or cancel it.`, { requestId: m.id });
  res.status(201).json({ job });
});

/** Tenant edits a declined request and asks the landlord again. */
r.post('/:id/resubmit', requireRole('tenant'), async (req, res) => {
  const b = z.object({ category: z.string().min(2).optional(), description: z.string().min(5).optional(), note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const { data: m } = await db.from('maintenance_requests').select('*').eq('id', req.params.id).eq('tenant_id', req.user.id).maybeSingle();
  if (!m) throw notFound('Request not found');
  if (m.status !== 'open' || m.funding_status !== 'declined') throw badRequest('Only a request your landlord declined can be resent', 'BAD_STATE');
  await db.from('maintenance_requests').update({ ...(b.category ? { category: b.category } : {}), ...(b.description ? { description: b.description } : {}), funding: 'landlord', funding_status: 'pending', funding_note: null, rejection_reason: null }).eq('id', m.id);
  await logMaintenance(m.id, req.user.id, 'resubmitted', b.note ? `Tenant edited and resent: ${b.note}` : 'Tenant edited and resent the request');
  await notify(m.landlord_id, 'maintenance_request', 'Repair request resent', `${m.ticket_no ?? m.category}: your tenant updated it and asks you to pay again.`, { requestId: m.id });
  res.json({ status: 'open', fundingStatus: 'pending' });
});

/** Cancel the order (rules in services/jobOrders.ts → cancelPolicy). Escrow is refunded to whoever paid. */
r.post('/:id/cancel', async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const { data: m } = await db.from('maintenance_requests').select('*').eq('id', req.params.id).maybeSingle();
  if (!m) throw notFound('Request not found');
  const { data: job } = await db.from('jobs').select('*').eq('maintenance_request_id', m.id).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(1).maybeSingle();
  res.json(await cancelOrder(req.user, m, job ?? null, reason));
});

export default r;
