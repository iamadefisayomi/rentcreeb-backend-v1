-- 010: reply to a specific chat message.
-- Idempotent: safe to run more than once.
alter table messages add column if not exists reply_to_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'messages_reply_to_id_fkey') then
    alter table messages add constraint messages_reply_to_id_fkey foreign key (reply_to_id) references messages(id) on delete set null;
  end if;
end $$;
create index if not exists messages_reply_to_idx on messages (reply_to_id);

notify pgrst, 'reload schema';
