import { db } from '../lib/supabase';
import { logger } from '../lib/logger';

export type MaintenanceEventKind =
  | 'submitted' | 'job_posted' | 'rejected' | 'assigned' | 'started' | 'estimate' | 'approved' | 'changes_requested'
  | 'countered' | 'counter_accepted' | 'counter_declined' | 'completed_by_artisan' | 'resolved' | 'escalated' | 'priority_changed';

/** Appends to a ticket's activity timeline (Figma "Ticket Detail" → Activity Timeline). Never throws. */
export async function logMaintenance(requestId: string | null | undefined, actorId: string | null, kind: MaintenanceEventKind, note?: string) {
  if (!requestId) return;
  try { await db.from('maintenance_events').insert({ request_id: requestId, actor_id: actorId, kind, note: note ?? null }); }
  catch (err) { logger.error({ err, requestId, kind }, 'maintenance event failed'); }
}

/** Same, for a job that may have come from a maintenance ticket. */
export const logForJob = (job: { maintenance_request_id?: string | null }, actorId: string | null, kind: MaintenanceEventKind, note?: string) =>
  logMaintenance(job.maintenance_request_id, actorId, kind, note);

/** SLA window by priority (matches the `maintenance_defaults` trigger). */
export const SLA_HOURS = { emergency: 6, high: 24, medium: 72, low: 168 } as const;
