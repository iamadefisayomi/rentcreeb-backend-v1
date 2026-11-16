-- 013: admin tooling — reviewable ID checks, internal notes, runtime settings, announcements.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor.

-- ID checks: evidence a person can review (private Bunny paths, deleted after a decision or after 30 days),
-- who decided, and whether a failed try still counts toward the attempt limit (admins can reset it).
alter table verifications add column if not exists selfie_path text;
alter table verifications add column if not exists document_path text;
alter table verifications add column if not exists document_type text;
alter table verifications add column if not exists counts_as_attempt boolean not null default true;
alter table verifications add column if not exists reviewed_by uuid references profiles(id) on delete set null;
alter table verifications add column if not exists reviewed_at timestamptz;
alter table verifications add column if not exists review_note text;
create index if not exists verifications_status_idx on verifications (status, created_at desc);

-- Why an account was suspended (shown to admins).
alter table profiles add column if not exists suspended_reason text;
alter table profiles add column if not exists suspended_at timestamptz;

-- Internal notes admins leave on users, listings, bookings, reports… (never shown to users).
create table if not exists admin_notes (
  id uuid primary key default gen_random_uuid(),
  target_type text not null,
  target_id text not null,
  admin_id uuid references profiles(id) on delete set null,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists admin_notes_target_idx on admin_notes (target_type, target_id, created_at desc);
alter table admin_notes enable row level security;

-- Runtime switches the admin dashboard can flip without a redeploy (maintenance mode, app banner).
create table if not exists app_settings (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  updated_by uuid references profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;

-- Announcements sent to groups of users from the dashboard.
create table if not exists announcements (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references profiles(id) on delete set null,
  title text not null, body text not null,
  audience jsonb not null default '{}'::jsonb,
  recipients int not null default 0,
  created_at timestamptz not null default now()
);
alter table announcements enable row level security;

-- Faster admin lists.
create index if not exists bookings_status_created_idx on bookings (status, created_at desc);
create index if not exists withdrawals_status_created_idx on withdrawals (status, created_at desc);
create index if not exists escrows_status_created_idx on escrows (status, created_at desc);
create index if not exists payments_status_created_idx on payments (status, created_at desc);

notify pgrst, 'reload schema';
