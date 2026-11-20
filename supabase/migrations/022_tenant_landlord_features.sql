-- 022: saved-search alerts, map search, virtual inspections, rent instalments, roommate matching, move-in/out
-- condition reports, rental history & receipts, digital tenancy agreements, tenant screening, service-charge & utility bills.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor after 021.

-- ───────── Saved-search alerts ─────────
create table if not exists saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  filters jsonb not null default '{}'::jsonb,       -- same shape as GET /properties (+ optional map area)
  alerts boolean not null default true,
  last_alert_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists saved_searches_user_idx on saved_searches (user_id);
create table if not exists saved_search_hits (
  search_id uuid not null references saved_searches(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  notified_at timestamptz not null default now(),
  primary key (search_id, property_id)
);
-- Map search: listings near a point / inside an area.
create index if not exists properties_geo_idx on properties (lat, lng) where status = 'approved';

-- ───────── Virtual inspections (live video walkthrough) ─────────
alter table bookings add column if not exists mode text not null default 'in_person' check (mode in ('in_person', 'virtual'));

-- ───────── Rent in instalments (landlord-approved payment plan) ─────────
create table if not exists rent_instalment_plans (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  tenant_id uuid not null references profiles(id) on delete cascade,
  landlord_id uuid not null references profiles(id) on delete cascade,
  period_due_date date not null,                    -- the rent due date being split
  total_kobo bigint not null check (total_kobo > 0),
  parts int not null check (parts between 2 and 12),
  frequency text not null default 'monthly' check (frequency in ('monthly', 'quarterly')),
  first_due_date date not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'declined', 'cancelled', 'completed')),
  tenant_note text, landlord_note text,
  created_at timestamptz not null default now(), responded_at timestamptz
);
create unique index if not exists rent_instalment_one_open on rent_instalment_plans (tenancy_id) where status in ('requested', 'approved');
alter table rent_payments add column if not exists instalment_plan_id uuid references rent_instalment_plans(id) on delete set null;
alter table rent_payments add column if not exists instalment_no int;

-- ───────── Roommate matching ─────────
create table if not exists roommate_profiles (
  user_id uuid primary key references profiles(id) on delete cascade,
  active boolean not null default true,
  looking_for text not null default 'need_room' check (looking_for in ('need_room', 'have_room')),
  areas text[] not null default '{}',
  budget_min_kobo bigint not null default 0, budget_max_kobo bigint not null default 0,
  move_in_date date,
  gender text check (gender in ('male', 'female', 'other')),
  preferred_gender text not null default 'any' check (preferred_gender in ('any', 'male', 'female')),
  occupation text, about text check (char_length(about) <= 600),
  lifestyle text[] not null default '{}',
  property_id uuid references properties(id) on delete set null,   -- have_room: the place they're sharing (optional)
  updated_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table if not exists roommate_requests (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references profiles(id) on delete cascade,
  to_user uuid not null references profiles(id) on delete cascade,
  message text check (char_length(message) <= 500),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at timestamptz not null default now(), responded_at timestamptz,
  unique (from_user, to_user)
);
alter table conversations drop constraint if exists conversations_context_type_check;
alter table conversations add constraint conversations_context_type_check check (context_type in ('booking', 'job', 'support', 'roommate'));

-- ───────── Move-in / move-out condition reports ─────────
create table if not exists condition_reports (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  kind text not null check (kind in ('move_in', 'move_out')),
  created_by uuid not null references profiles(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'signed', 'disputed')),
  items jsonb not null default '[]'::jsonb,          -- [{ room, item, condition: good|fair|poor|damaged, note, photos: [private paths] }]
  notes text,
  tenant_signature text, tenant_signed_at timestamptz,
  landlord_signature text, landlord_signed_at timestamptz,
  dispute_note text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists condition_reports_tenancy_idx on condition_reports (tenancy_id, created_at desc);

-- ───────── Digital tenancy agreements ─────────
create table if not exists lease_agreements (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  landlord_id uuid not null references profiles(id) on delete cascade,
  tenant_id uuid references profiles(id) on delete set null,
  title text not null default 'Tenancy Agreement',
  fields jsonb not null default '{}'::jsonb,         -- the values the template was filled with
  clauses jsonb not null default '[]'::jsonb,        -- [{ heading, body }]
  status text not null default 'draft' check (status in ('draft', 'sent', 'signed', 'declined', 'void')),
  landlord_signature text, landlord_signed_at timestamptz,
  tenant_signature text, tenant_signed_at timestamptz,
  declined_reason text, content_hash text,           -- sha256 of what was signed (tamper evidence)
  sent_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists lease_agreements_tenancy_idx on lease_agreements (tenancy_id, created_at desc);

-- ───────── Tenant screening (consent-based) ─────────
create table if not exists screening_requests (
  id uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references profiles(id) on delete cascade,
  tenant_id uuid not null references profiles(id) on delete cascade,
  property_id uuid references properties(id) on delete set null,
  message text check (char_length(message) <= 400),
  status text not null default 'requested' check (status in ('requested', 'shared', 'declined', 'revoked')),
  responded_at timestamptz, expires_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists screening_one_open on screening_requests (landlord_id, tenant_id) where status = 'requested';

-- ───────── Service charge & utility bills ─────────
create table if not exists bills (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  landlord_id uuid not null references profiles(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 120),
  category text not null default 'service_charge' check (category in ('service_charge', 'electricity', 'diesel', 'water', 'security', 'waste', 'maintenance', 'other')),
  period_label text,                                  -- e.g. "November 2026"
  total_kobo bigint not null check (total_kobo > 0),
  split text not null default 'equal' check (split in ('equal', 'custom')),
  due_date date not null,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists bills_property_idx on bills (property_id, created_at desc);
create table if not exists bill_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills(id) on delete cascade,
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  tenant_id uuid references profiles(id) on delete set null,
  unit_label text,
  amount_kobo bigint not null check (amount_kobo > 0),
  status text not null default 'due' check (status in ('due', 'paid', 'overdue', 'waived')),
  method text check (method in ('paystack', 'bank_transfer', 'cash', 'waived')),
  payment_id uuid references payments(id) on delete set null,
  paid_at timestamptz, recorded_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists bill_items_tenant_idx on bill_items (tenant_id, status);
alter table payments add column if not exists bill_item_id uuid references bill_items(id) on delete set null;
alter table payments drop constraint if exists payments_purpose_check;
alter table payments add constraint payments_purpose_check
  check (purpose in ('inspection', 'subscription', 'rent', 'rentsave', 'job_escrow', 'job_topup', 'bill'));

-- API (service role) only, like the rest of the schema.
alter table saved_searches enable row level security;
alter table saved_search_hits enable row level security;
alter table rent_instalment_plans enable row level security;
alter table roommate_profiles enable row level security;
alter table roommate_requests enable row level security;
alter table condition_reports enable row level security;
alter table lease_agreements enable row level security;
alter table screening_requests enable row level security;
alter table bills enable row level security;
alter table bill_items enable row level security;

notify pgrst, 'reload schema';
