-- Run once in the Supabase SQL editor. Applies migrations 002-005 in order, all-or-nothing.
begin;

-- ===== 002_revisions_and_rentsave.sql =====
-- Revised final amount on job completion
alter table jobs
  add column revised_amount_kobo bigint,
  add column revision_status text check (revision_status in ('pending','awaiting_payment','approved','rejected')),
  add column revision_note text;

-- Top-up payments (landlord approves a higher final amount)
alter table payments drop constraint payments_purpose_check;
alter table payments add constraint payments_purpose_check
  check (purpose in ('inspection','subscription','rent','rentsave','job_escrow','job_topup'));

-- RentSave payout: apply savings to rent
create or replace function rentsave_debit(p_plan uuid, p_amount bigint) returns void language plpgsql as $$
begin
  update rentsave_plans
     set saved_kobo = saved_kobo - p_amount,
         status = case when status = 'completed' and saved_kobo - p_amount < target_kobo then 'active' else status end
   where id = p_plan and saved_kobo >= p_amount;
  if not found then raise exception 'INSUFFICIENT_SAVINGS'; end if;
end $$;

-- ===== 003_profile_settings.sql =====
-- Settings → Personal Information fields, and soft account deletion.
alter table profiles
  add column username text,
  add column gender text check (gender in ('male','female','other','prefer_not_to_say')),
  add column date_of_birth date,
  add column agency_name text,
  add column license_number text,
  add column location text,
  add column deleted_at timestamptz;

-- Usernames are unique case-insensitively; NULL allowed for everyone who hasn't picked one.
create unique index profiles_username_lower_idx on profiles (lower(username)) where username is not null;

-- ===== 004_notification_prefs.sql =====
-- Settings → Notification Settings. Partial map of preference key → boolean; missing keys use the
-- defaults in api/src/services/notify.ts (NOTIFICATION_DEFAULTS).
alter table profiles add column notification_prefs jsonb not null default '{}'::jsonb;

-- ===== 005_property_management.sql =====
-- Landlord / estate-manager property management (Figma: Add Property & Tenant Setup, Tenant Management,
-- Rent Payment Tracking, Maintenance Oversight, Mobile Property Management).

-- ───────────────────────── Multi-unit properties ─────────────────────────
create table units (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  label text not null,                                        -- "1A", "Flat 3C"
  unit_type text not null default '2_bed' check (unit_type in ('studio','1_bed','2_bed','3_bed','4_bed','other')),
  rent_kobo bigint not null default 0 check (rent_kobo >= 0),  -- monthly rent
  size_sqm numeric, bathrooms int not null default 1,
  status text not null default 'vacant' check (status in ('vacant','occupied','unavailable')),
  created_at timestamptz not null default now(),
  unique (property_id, label)
);
create index on units(property_id);
alter table properties add column unit_mode text not null default 'single' check (unit_mode in ('single','same','mixed'));

-- Every existing property becomes a single-unit property; existing tenancies move onto that unit.
insert into units (property_id, label, unit_type, rent_kobo, size_sqm, bathrooms, status)
select p.id, 'Main',
  case when p.bedrooms <= 0 then 'studio' when p.bedrooms = 1 then '1_bed' when p.bedrooms = 2 then '2_bed'
       when p.bedrooms = 3 then '3_bed' else '4_bed' end,
  case when p.price_period = 'year' then p.price_kobo / 12 else p.price_kobo end,
  p.size_sqm, greatest(p.bathrooms, 1),
  case when exists (select 1 from tenancies t where t.property_id = p.id and t.status = 'active') then 'occupied' else 'vacant' end
from properties p;

-- ───────────────────────── Tenancies: units, invites, notices ─────────────────────────
alter table tenancies
  add column unit_id uuid references units(id),
  alter column tenant_id drop not null,                        -- invited tenants have no account yet
  add column invite_name text, add column invite_email text, add column invite_phone text,
  add column emergency_contact_name text, add column emergency_contact_phone text,
  add column notice_given_at timestamptz, add column notice_days int,
  add column terminates_on date, add column termination_reason text;
update tenancies t set unit_id = u.id from units u where u.property_id = t.property_id and u.label = 'Main' and t.unit_id is null;
create index on tenancies(unit_id);
create index on tenancies(lower(invite_email)) where tenant_id is null;
create index on tenancies(invite_phone) where tenant_id is null;
alter table tenancies add constraint tenancy_has_tenant_or_invite
  check (tenant_id is not null or invite_email is not null or invite_phone is not null);

-- When an invited tenant signs up (or their email/phone is set), attach their pending tenancies.
create or replace function public.claim_tenancy_invites() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role <> 'tenant' then return new; end if;
  update tenancies set tenant_id = new.id
   where tenant_id is null and status = 'active'
     and ((new.email is not null and lower(invite_email) = lower(new.email))
       or (new.phone is not null and invite_phone = new.phone));
  return new;
end $$;
create trigger profiles_claim_invites after insert or update of email, phone on profiles
  for each row execute function public.claim_tenancy_invites();

-- ───────────────────────── Lease renewals (tenant signs) ─────────────────────────
create table lease_renewals (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  landlord_id uuid not null references profiles(id),
  new_lease_end date not null,
  new_rent_kobo bigint not null check (new_rent_kobo >= 0),      -- per rent period of the tenancy
  status text not null default 'pending' check (status in ('pending','accepted','declined','cancelled')),
  created_at timestamptz not null default now(), responded_at timestamptz
);
create unique index lease_renewals_one_pending on lease_renewals(tenancy_id) where status = 'pending';

-- ───────────────────────── Rent payments: manual records + reminders ─────────────────────────
alter table rent_payments
  add column method text not null default 'paystack' check (method in ('paystack','bank_transfer','cash','cheque','escrow','rentsave')),
  add column reference text, add column notes text,
  add column recorded_by uuid references profiles(id);

create table rent_reminders (
  id uuid primary key default gen_random_uuid(),
  tenancy_id uuid not null references tenancies(id) on delete cascade,
  landlord_id uuid not null references profiles(id),
  channel text not null check (channel in ('in_app','sms','email')),
  message text not null,
  created_at timestamptz not null default now()
);
create index on rent_reminders(tenancy_id, created_at desc);

-- ───────────────────────── Property documents (private storage) ─────────────────────────
create table property_documents (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  doc_type text not null check (doc_type in ('title','survey','agreement','other')),
  storage_path text not null, original_name text, size_bytes bigint,
  created_at timestamptz not null default now()
);
create index on property_documents(property_id);

-- ───────────────────────── Listings: paused + performance ─────────────────────────
alter table properties drop constraint properties_status_check;
alter table properties add constraint properties_status_check
  check (status in ('unlisted','pending','approved','rejected','rented','archived','paused'));
create table property_views (
  id bigserial primary key,
  property_id uuid not null references properties(id) on delete cascade,
  viewer_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on property_views(property_id, created_at);

-- ───────────────────────── Maintenance oversight ─────────────────────────
create sequence maintenance_ticket_seq;
alter table maintenance_requests
  add column ticket_no text unique,
  add column priority text not null default 'medium' check (priority in ('low','medium','high','emergency')),
  add column sla_due_at timestamptz,
  add column escalated_at timestamptz,
  add column resolved_at timestamptz;
update maintenance_requests set
  priority = case when urgency = 'urgent' then 'high' else 'medium' end,
  sla_due_at = created_at + case when urgency = 'urgent' then interval '24 hours' else interval '72 hours' end,
  resolved_at = case when status = 'completed' then created_at end;
update maintenance_requests m set ticket_no = 'MR-' || to_char(m.created_at, 'YYYY') || '-' || lpad(nextval('maintenance_ticket_seq')::text, 5, '0')
 where ticket_no is null;

create or replace function public.maintenance_defaults() returns trigger language plpgsql as $$
begin
  if new.ticket_no is null then
    new.ticket_no := 'MR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('maintenance_ticket_seq')::text, 5, '0');
  end if;
  -- Tenants only choose standard/urgent; urgent tickets start as high priority (landlord can change it).
  if new.urgency = 'urgent' and new.priority = 'medium' then new.priority := 'high'; end if;
  if new.sla_due_at is null then
    new.sla_due_at := now() + case new.priority when 'emergency' then interval '6 hours' when 'high' then interval '24 hours'
                                                 when 'medium' then interval '72 hours' else interval '7 days' end;
  end if;
  return new;
end $$;
create trigger maintenance_defaults before insert on maintenance_requests
  for each row execute function public.maintenance_defaults();

create table maintenance_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references maintenance_requests(id) on delete cascade,
  actor_id uuid references profiles(id),
  kind text not null,          -- submitted, reviewed, job_posted, assigned, started, estimate, approved, countered, escalated, resolved, rejected
  note text, created_at timestamptz not null default now()
);
create index on maintenance_events(request_id, created_at);
insert into maintenance_events (request_id, actor_id, kind, note, created_at)
select id, tenant_id, 'submitted', 'Ticket submitted by tenant', created_at from maintenance_requests;

-- Landlord counter-offer on an artisan's repair estimate.
alter table job_reports drop constraint job_reports_status_check;
alter table job_reports add constraint job_reports_status_check check (status in ('pending','approved','rejected','countered'));
alter table job_reports add column counter_amount_kobo bigint, add column counter_note text;

-- New tables follow the same rule as the rest of the schema: API (service role) only.
alter table units enable row level security;
alter table lease_renewals enable row level security;
alter table rent_reminders enable row level security;
alter table property_documents enable row level security;
alter table property_views enable row level security;
alter table maintenance_events enable row level security;

commit;
