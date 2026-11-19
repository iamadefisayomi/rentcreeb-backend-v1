-- 021: live support inbox. The API streams support-ticket changes to the admin dashboard (services/liveHub.ts),
-- so the table must be in the Realtime publication. Only the API (service role) can read it: RLS stays on, no policies.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor after 020.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'support_tickets') then
    alter publication supabase_realtime add table support_tickets;
  end if;
end $$;
