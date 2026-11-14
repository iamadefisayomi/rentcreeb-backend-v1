-- Settings → Contact Support / Report a Bug / Rate RentCreeb / Privacy & Cookie preferences.

-- Support requests and bug reports raised from the app. `meta` carries device/app details for bug reports.
create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  kind text not null check (kind in ('support','bug','data_request')),
  category text not null,
  subject text not null,
  message text not null,
  severity text check (severity in ('low','medium','high')),
  meta jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on support_tickets(user_id, created_at desc);
create index on support_tickets(status, created_at desc);
alter table support_tickets enable row level security;

-- "Rate RentCreeb" in-app feedback. One row per submission; the latest is shown back to the user.
create table app_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  tags text[] not null default '{}',
  comment text,
  platform text,
  app_version text,
  created_at timestamptz not null default now()
);
create index on app_feedback(user_id, created_at desc);
alter table app_feedback enable row level security;

-- Privacy / cookie consent. Partial map of key → boolean; missing keys use PRIVACY_DEFAULTS in support.routes.ts.
alter table profiles add column privacy_prefs jsonb not null default '{}'::jsonb;
