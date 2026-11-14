import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { kobo, uuid } from '../lib/common';
import { authenticate, requireRole } from '../middleware/auth';
import { notify } from '../services/notify';
import { logMaintenance, SLA_HOURS } from '../services/maintenance';

const r = Router();
r.use(authenticate);
const SELECT = '*, maintenance_media(url), properties(id, title, address), tenancies(unit_label, units(label)), ' +
  'tenant:profiles!maintenance_requests_tenant_id_fkey(id, first_name, last_name, phone, avatar_url), ' +
  'jobs(id, status, artisan_id, title, accepted_quote_id, revised_amount_kobo, revision_status, artisan:profiles!jobs_artisan_id_fkey(id, first_name, last_name, phone, avatar_url, rating_avg, rating_count))' as '*'; // concatenated → tell supabase-js to treat rows as untyped
const LANDLORDS = ['landlord', 'estate_manager'] as const;
const OPEN = ['open', 'job_posted', 'in_progress'];

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

/** Tenant: photo upload → category → submit. */
r.post('/', requireRole('tenant'), async (req, res) => {
  const b = z.object({
    tenancyId: uuid, category: z.string().min(2), description: z.string().min(5),
    urgency: z.enum(['standard', 'urgent']).default('standard'), mediaUrls: z.array(z.string().url()).max(6).default([]),
  }).parse(req.body);
  const { data: t } = await db.from('tenancies').select('*').eq('id', b.tenancyId).eq('tenant_id', req.user.id).eq('status', 'active').maybeSingle();
  if (!t) throw notFound('Active tenancy not found');
  const m = unwrap(await db.from('maintenance_requests').insert({
    tenancy_id: t.id, property_id: t.property_id, tenant_id: req.user.id, landlord_id: t.landlord_id,
    category: b.category, description: b.description, urgency: b.urgency }).select().single());
  if (b.mediaUrls.length) await db.from('maintenance_media').insert(b.mediaUrls.map((url) => ({ request_id: m.id, url })));
  await logMaintenance(m.id, req.user.id, 'submitted', 'Ticket submitted by tenant');
  await notify(t.landlord_id, 'maintenance_request', 'New maintenance request', `${b.category}: ${b.description.slice(0, 80)}`, { requestId: m.id });
  res.status(201).json({ request: m });
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
  res.json({ request: ticketView(data), job: job ?? null, report, events: events ?? [], timeline: { stages, current } });
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

/** Landlord approves the ticket by posting it as a job for artisans. */
r.post('/:id/post-job', requireRole('landlord', 'estate_manager'), async (req, res) => {
  const b = z.object({ budgetMinKobo: kobo, budgetMaxKobo: kobo, urgency: z.enum(['standard', 'urgent']).optional(), accessNotes: z.string().optional() }).parse(req.body);
  if (b.budgetMinKobo > b.budgetMaxKobo) throw badRequest('Min budget cannot exceed max');
  const { data: m } = await db.from('maintenance_requests').select('*, maintenance_media(url)').eq('id', req.params.id).maybeSingle();
  if (!m) throw notFound('Request not found');
  if (m.landlord_id !== req.user.id) throw forbidden();
  if (m.status !== 'open') throw badRequest('Request already processed', 'BAD_STATE');

  const job = unwrap(await db.from('jobs').insert({
    property_id: m.property_id, landlord_id: m.landlord_id, tenant_id: m.tenant_id, maintenance_request_id: m.id,
    title: `${m.category} — ${m.description.slice(0, 40)}`, category: m.category, description: m.description,
    urgency: b.urgency ?? m.urgency, budget_min_kobo: b.budgetMinKobo, budget_max_kobo: b.budgetMaxKobo, access_notes: b.accessNotes,
  }).select().single());
  const media = ((m as any).maintenance_media ?? []).map((x: any) => ({ job_id: job.id, kind: 'issue', url: x.url }));
  if (media.length) await db.from('job_media').insert(media);
  await db.from('maintenance_requests').update({ status: 'job_posted' }).eq('id', m.id);
  await logMaintenance(m.id, req.user.id, 'job_posted', 'Ticket reviewed and posted to artisans');
  await notify(m.tenant_id, 'maintenance_update', 'Repair approved', 'Your landlord is finding an artisan.', { requestId: m.id });
  res.status(201).json({ job });
});

r.post('/:id/reject', requireRole('landlord', 'estate_manager'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
  const { data: m } = await db.from('maintenance_requests').update({ status: 'rejected', rejection_reason: reason })
    .eq('id', req.params.id).eq('landlord_id', req.user.id).eq('status', 'open').select().maybeSingle();
  if (!m) throw notFound('Open request not found');
  await logMaintenance(m.id, req.user.id, 'rejected', reason);
  await notify(m.tenant_id, 'maintenance_update', 'Request declined', reason, { requestId: m.id });
  res.json({ request: m });
});

export default r;
