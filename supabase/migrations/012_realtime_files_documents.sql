-- 012: Supabase Realtime for chat/typing/calls, chat attachments + read receipts, tenant documents,
--      commercial & land listings. Idempotent: safe to run more than once.

-- ── Chat attachments (photos/files live in the PRIVATE storage zone; the API signs short-lived URLs) ──
alter table messages add column if not exists attachment_path text;
alter table messages add column if not exists attachment_name text;
alter table messages add column if not exists attachment_type text;
alter table messages add column if not exists attachment_size int;
create index if not exists messages_conversation_created_idx on messages (conversation_id, created_at desc);

-- ── Realtime: calls rows stream to the caller and callee (incoming-call ring + instant answer) ──
drop policy if exists "parties read calls" on calls;
create policy "parties read calls" on calls for select to authenticated using (auth.uid() in (caller_id, callee_id));

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'calls') then
    alter publication supabase_realtime add table calls;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages') then
    alter publication supabase_realtime add table messages;
  end if;
end $$;

-- ── Realtime Authorization: private broadcast channel "chat:<conversation id>" (typing indicator) ──
-- Only the two people in the conversation may join, send or receive on it.
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'realtime' and table_name = 'messages') then
    execute 'drop policy if exists "chat participants receive" on realtime.messages';
    execute 'drop policy if exists "chat participants send" on realtime.messages';
    execute $p$
      create policy "chat participants receive" on realtime.messages for select to authenticated using (
        realtime.topic() like 'chat:%' and exists (
          select 1 from public.conversations c
          where c.id::text = split_part(realtime.topic(), ':', 2) and auth.uid() in (c.participant_a, c.participant_b)))
    $p$;
    execute $p$
      create policy "chat participants send" on realtime.messages for insert to authenticated with check (
        realtime.topic() like 'chat:%' and exists (
          select 1 from public.conversations c
          where c.id::text = split_part(realtime.topic(), ':', 2) and auth.uid() in (c.participant_a, c.participant_b)))
    $p$;
  end if;
end $$;

-- ── Tenant document storage (leases, IDs, receipts…), optionally shared with the landlord of a tenancy ──
create table if not exists user_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  tenancy_id uuid references tenancies(id) on delete set null,
  category text not null default 'other' check (category in ('lease', 'id', 'receipt', 'utility', 'letter', 'other')),
  title text not null,
  storage_path text not null,
  mime_type text,
  size_bytes int,
  shared_with_landlord boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists user_documents_user_idx on user_documents (user_id, created_at desc);
create index if not exists user_documents_tenancy_idx on user_documents (tenancy_id) where shared_with_landlord;
alter table user_documents enable row level security; -- API only

-- ── Commercial & land listings ──
alter table properties add column if not exists title_document text;   -- land: C of O, Governor's Consent, Deed, Survey…
alter table properties add column if not exists plot_count numeric;    -- land: number of plots
alter table properties add column if not exists commercial_use text;   -- commercial: office, shop, warehouse, event centre…
-- Land is usually sold outright, not rented per year/month.
alter table properties drop constraint if exists properties_price_period_check;
alter table properties add constraint properties_price_period_check check (price_period in ('year', 'month', 'outright'));

notify pgrst, 'reload schema';
