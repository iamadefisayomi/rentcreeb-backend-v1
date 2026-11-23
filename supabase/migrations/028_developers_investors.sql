-- Developers & investors.
--   developer: publishes development projects (off-plan / under construction / completed) with unit types, posts
--              construction updates, and manages the interest (leads) investors and buyers send.
--   investor:  browses projects, watches them, sends interest / reservation requests, and tracks a portfolio.
-- No investment money moves through RentCreeb: an interest opens a chat with the developer, and the developer records
-- the outcome (reserved / purchased). Agents already exist; this migration only adds them to self sign-up paths.

-- ───────── roles ─────────
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('tenant', 'landlord', 'estate_manager', 'artisan', 'agent', 'developer', 'investor', 'admin'));

-- Developers reuse profiles.agency_name (company name) and profiles.license_number (CAC RC number) from 003.
alter table profiles add column if not exists investment_prefs jsonb;   -- investors: { cities, budgetMinKobo, budgetMaxKobo, goal }

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := new.raw_user_meta_data->>'role';
begin
  insert into profiles(id, email, first_name, last_name, phone, role)
  values (new.id, new.email, new.raw_user_meta_data->>'first_name', new.raw_user_meta_data->>'last_name',
          nullif(new.raw_user_meta_data->>'phone',''),
          case when r in ('tenant','landlord','estate_manager','artisan','agent','developer','investor') then r else 'tenant' end);
  insert into wallets(user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

-- ───────── projects ─────────
create table if not exists dev_projects (
  id uuid primary key default gen_random_uuid(),
  developer_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  tagline text,
  description text,
  kind text not null default 'residential' check (kind in ('residential', 'commercial', 'mixed_use', 'land')),
  status text not null default 'off_plan' check (status in ('off_plan', 'under_construction', 'completed', 'sold_out')),
  published boolean not null default false,
  city text not null,
  area text,
  address text,
  lat double precision, lng double precision,
  progress_pct int not null default 0 check (progress_pct between 0 and 100),
  launch_date date,
  completion_date date,
  title_document text,                       -- C of O, Governor's Consent, Registered Survey…
  payment_plan text,                         -- free text: "30% deposit, balance over 18 months"
  min_investment_kobo bigint check (min_investment_kobo is null or min_investment_kobo > 0),
  expected_roi_pct numeric(5,2),             -- developer's projected capital appreciation (not a promise)
  rental_yield_pct numeric(5,2),
  amenities text[] not null default '{}',
  images text[] not null default '{}',
  brochure_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dev_projects_dev_idx on dev_projects(developer_id, created_at desc);
create index if not exists dev_projects_pub_idx on dev_projects(published, city, status);

create table if not exists dev_unit_types (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references dev_projects(id) on delete cascade,
  name text not null,                        -- "3 Bedroom Terrace"
  bedrooms int check (bedrooms is null or bedrooms between 0 and 20),
  size_sqm numeric(8,2),
  price_kobo bigint not null check (price_kobo > 0),
  total_units int not null default 1 check (total_units >= 0),
  available_units int not null default 1 check (available_units >= 0),
  position int not null default 0
);
create index if not exists dev_unit_types_project_idx on dev_unit_types(project_id, position);

create table if not exists dev_project_updates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references dev_projects(id) on delete cascade,
  title text not null,
  body text,
  progress_pct int check (progress_pct is null or progress_pct between 0 and 100),
  images text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists dev_project_updates_idx on dev_project_updates(project_id, created_at desc);

-- An investor's / buyer's interest in a project: enquiry → contacted → negotiating → reserved → purchased.
create table if not exists dev_leads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references dev_projects(id) on delete cascade,
  developer_id uuid not null references profiles(id) on delete cascade,
  investor_id uuid not null references profiles(id) on delete cascade,
  unit_type_id uuid references dev_unit_types(id) on delete set null,
  kind text not null default 'enquiry' check (kind in ('enquiry', 'reservation', 'inspection')),
  units int not null default 1 check (units between 1 and 100),
  budget_kobo bigint,
  message text,
  status text not null default 'new' check (status in ('new', 'contacted', 'negotiating', 'reserved', 'purchased', 'declined', 'withdrawn')),
  agreed_kobo bigint,                        -- price recorded by the developer at reserved / purchased
  developer_note text,                       -- private to the developer
  conversation_id uuid references conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dev_leads_dev_idx on dev_leads(developer_id, status, created_at desc);
create index if not exists dev_leads_inv_idx on dev_leads(investor_id, created_at desc);
create index if not exists dev_leads_project_idx on dev_leads(project_id);

create table if not exists dev_watchlist (
  user_id uuid not null references profiles(id) on delete cascade,
  project_id uuid not null references dev_projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

-- Server-only tables (service role); no client policies.
alter table dev_projects enable row level security;
alter table dev_unit_types enable row level security;
alter table dev_project_updates enable row level security;
alter table dev_leads enable row level security;
alter table dev_watchlist enable row level security;

-- Investor ↔ developer chats hang off the project.
alter table conversations drop constraint if exists conversations_context_type_check;
alter table conversations add constraint conversations_context_type_check
  check (context_type in ('booking', 'job', 'support', 'roommate', 'property', 'project'));
