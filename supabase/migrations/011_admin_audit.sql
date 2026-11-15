-- 011: audit trail of admin actions (approvals, suspensions, moderation) for the admin dashboard.
-- Idempotent: safe to run more than once.
create table if not exists admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references profiles(id) on delete set null, -- kept if the admin account is later deleted
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_actions_created_idx on admin_actions (created_at desc);
create index if not exists admin_actions_target_idx on admin_actions (target_type, target_id);
alter table admin_actions enable row level security; -- only the API (service role) reads/writes it

notify pgrst, 'reload schema';
