import { db } from '../lib/supabase';
import { logger } from '../lib/logger';

/**
 * The chat between two people about one booking or job, created if it does not exist yet.
 * Select-then-insert (not upsert) so it works both before and after migration 016, which allows several chats per job.
 */
export async function ensureConversation(contextType: 'booking' | 'job', contextId: string, a: string, b: string): Promise<{ id: string } | null> {
  const find = () => db.from('conversations').select('id').eq('context_type', contextType).eq('context_id', contextId)
    .or(`and(participant_a.eq.${a},participant_b.eq.${b}),and(participant_a.eq.${b},participant_b.eq.${a})`).limit(1).maybeSingle();
  const { data: existing } = await find();
  if (existing) return existing;
  const { data, error } = await db.from('conversations').insert({ context_type: contextType, context_id: contextId, participant_a: a, participant_b: b }).select('id').single();
  if (data) return data;
  // Lost a race with another request, or (before migration 016) the job already has its one chat.
  const { data: again } = await find();
  if (!again) logger.warn({ err: error?.message, contextType, contextId }, 'could not create conversation (apply migration 016 for tenant ↔ artisan job chats)');
  return again ?? null;
}
