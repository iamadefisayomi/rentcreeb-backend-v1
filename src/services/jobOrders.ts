import { db, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden } from '../lib/errors';
import { logger } from '../lib/logger';
import { notify } from './notify';
import { refundEscrow } from './escrow';
import { logMaintenance } from './maintenance';

/**
 * Job orders (migration 025). Who does what:
 *
 *   created_by  tenant   → the tenant approves the estimate and signs off the work.
 *               landlord → the landlord does.
 *   payer       tenant   → the tenant accepts a quote, pays into escrow and decides price revisions.
 *               landlord → the landlord does.
 *
 * Both parties can always see the order, and both are notified of every step (except the one who took it).
 */
type JobLike = { id?: string; landlord_id: string; tenant_id?: string | null; created_by?: string | null; payer?: string | null };

/** Approves the estimate and confirms completion. Rows from before 025 have no created_by: a tenant on the job ordered it. */
export const approverOf = (job: JobLike) =>
  (job.created_by ?? (job.tenant_id ? 'tenant' : 'landlord')) === 'tenant' && job.tenant_id ? job.tenant_id : job.landlord_id;
/** Accepts quotes, pays into escrow, decides revised prices. */
export const payerOf = (job: JobLike) => (job.payer === 'tenant' && job.tenant_id ? job.tenant_id : job.landlord_id);
export const partiesOf = (x: { landlord_id: string; tenant_id?: string | null }) => [...new Set([x.landlord_id, x.tenant_id].filter(Boolean) as string[])];
const roleWord = (x: { landlord_id: string }, userId: string) => (userId === x.landlord_id ? 'landlord' : 'tenant');

/** Notify the tenant and landlord of an order, except whoever just acted. Never throws. */
export async function tellParties(x: { landlord_id: string; tenant_id?: string | null }, actorId: string | null, type: string, title: string, body: string, data: Record<string, unknown>) {
  for (const uid of partiesOf(x)) if (uid !== actorId) await notify(uid, type, title, body, data);
}

/** Creates the artisan job for a ticket (tenant self-funded, or landlord accepted paying). */
export async function createJobForRequest(m: any, o: { payer: 'tenant' | 'landlord'; budgetMinKobo: number; budgetMaxKobo: number; urgency?: string; accessNotes?: string | null }) {
  if (o.budgetMinKobo > o.budgetMaxKobo) throw badRequest('Min budget cannot exceed max');
  const job = unwrap(await db.from('jobs').insert({
    property_id: m.property_id, landlord_id: m.landlord_id, tenant_id: m.tenant_id, maintenance_request_id: m.id,
    title: `${m.category} — ${String(m.description).slice(0, 40)}`, category: m.category, description: m.description,
    urgency: o.urgency ?? m.urgency, budget_min_kobo: o.budgetMinKobo, budget_max_kobo: o.budgetMaxKobo, access_notes: o.accessNotes ?? null,
    created_by: m.created_by ?? 'tenant', payer: o.payer,
  }).select().single());
  const { data: media } = await db.from('maintenance_media').select('url').eq('request_id', m.id);
  if (media?.length) await db.from('job_media').insert(media.map((x: any) => ({ job_id: job.id, kind: 'issue', url: x.url })));
  return job;
}

/** States in which an order can still be cancelled: nobody has started work on site. */
const CANCELLABLE_JOB = ['open', 'assigned'];

export function cancelPolicy(userId: string, m: any | null, job: any | null): { allowed: boolean; reason?: string } {
  const owner = m ?? job;
  if (!owner) return { allowed: false };
  if (![owner.landlord_id, owner.tenant_id].includes(userId)) return { allowed: false, reason: 'Not your job order' };
  const status = m?.status ?? null;
  if (status && ['completed', 'cancelled'].includes(status)) return { allowed: false, reason: 'This job order is already closed' };
  if (job && ['completed', 'cancelled'].includes(job.status)) return { allowed: false, reason: 'This job order is already closed' };
  const createdBy = owner.created_by ?? 'tenant';
  const isLandlord = userId === owner.landlord_id;
  // Tenants can't cancel what the landlord ordered.
  if (!isLandlord && createdBy === 'landlord') return { allowed: false, reason: 'Your landlord created this job order, so only they can cancel it.' };
  if (job && !CANCELLABLE_JOB.includes(job.status))
    return { allowed: false, reason: 'The artisan has already started work, so this can’t be cancelled in the app. Contact RentCreeb Support and we’ll settle it fairly with the artisan.' };
  return { allowed: true };
}

/**
 * Cancels a job order (ticket and/or its job). Held escrow is refunded to whoever paid; pending quotes are closed;
 * tenant, landlord and the assigned artisan are told.
 */
export async function cancelOrder(actor: { id: string }, m: any | null, job: any | null, reason?: string) {
  const policy = cancelPolicy(actor.id, m, job);
  if (!policy.allowed) throw policy.reason === 'Not your job order' ? forbidden() : conflict(policy.reason ?? 'This job order can’t be cancelled', 'CANNOT_CANCEL');
  const now = new Date().toISOString();
  const who = roleWord(m ?? job, actor.id);
  let refundedKobo = 0;
  if (job) {
    const { data: e } = await db.from('escrows').select('id, amount_kobo').eq('job_id', job.id).eq('kind', 'job').eq('status', 'held').maybeSingle();
    if (e) {
      try { const r = await refundEscrow(e.id); refundedKobo = r?.refunded ?? 0; }
      catch (err) { logger.error({ err, jobId: job.id }, 'cancel: escrow refund failed'); throw conflict('We couldn’t refund the escrow payment just now, so the job was not cancelled. Please try again or contact support.', 'REFUND_FAILED'); }
    }
    await db.from('jobs').update({ status: 'cancelled', cancelled_at: now, cancelled_by: actor.id, cancel_reason: reason ?? null }).eq('id', job.id);
    await db.from('job_quotes').update({ status: 'declined' }).eq('job_id', job.id).eq('status', 'pending');
    if (job.artisan_id) await notify(job.artisan_id, 'job_cancelled', 'Job cancelled', `${job.title} was cancelled by the ${who}.${reason ? ` “${reason}”` : ''}`, { jobId: job.id });
  }
  if (m) await db.from('maintenance_requests').update({ status: 'cancelled', cancelled_at: now, cancelled_by: actor.id, cancel_reason: reason ?? null }).eq('id', m.id);
  const ref = m?.ticket_no ? `${m.ticket_no}: ` : '';
  const title = (m?.category ?? job?.title ?? 'Repair');
  await logMaintenance(m?.id ?? job?.maintenance_request_id, actor.id, 'cancelled', `Cancelled by ${who}${reason ? `: ${reason}` : ''}${refundedKobo ? ` · ₦${(refundedKobo / 100).toLocaleString('en-NG')} refunded` : ''}`);
  const body = `${ref}${title} was cancelled by the ${who}.${refundedKobo ? ` ₦${(refundedKobo / 100).toLocaleString('en-NG')} is being refunded to the payer.` : ''}${reason ? ` “${reason}”` : ''}`;
  // Both parties hear about it, the one who cancelled included (so their other devices update too).
  for (const uid of partiesOf(m ?? job)) await notify(uid, 'maintenance_update', 'Job order cancelled', body, m ? { requestId: m.id } : { jobId: job.id });
  return { status: 'cancelled' as const, refundedKobo };
}
