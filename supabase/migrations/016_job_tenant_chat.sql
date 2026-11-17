-- 016: more than one chat per job. A repair the tenant requested gets a tenant ↔ artisan chat alongside the
-- landlord ↔ artisan one, so whoever ordered the work can talk to the artisan directly.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor after 015.

alter table conversations drop constraint if exists conversations_context_type_context_id_key;
create unique index if not exists conversations_context_pair_key
  on conversations (context_type, context_id, least(participant_a, participant_b), greatest(participant_a, participant_b));
create index if not exists conversations_context_idx on conversations (context_type, context_id);

notify pgrst, 'reload schema';
