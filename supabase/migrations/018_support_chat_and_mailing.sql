-- 018: (1) support tickets become chat threads in the user's Messages, closed by support;
--      (2) mailing list service: contacts, lists, templates, campaigns, automations, delivery tracking.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor after 017.

-- ───────────────────────── Support chat ─────────────────────────
-- A support thread is a conversation with context_type 'support' (context_id = the ticket). participant_a is the user;
-- there is no fixed participant_b: any admin can answer, and their messages show as "RentCreeb Support".
alter table conversations drop constraint if exists conversations_context_type_check;
alter table conversations add constraint conversations_context_type_check check (context_type in ('booking', 'job', 'support'));
alter table conversations alter column participant_b drop not null;
alter table conversations add column if not exists closed_at timestamptz;   -- set → nobody can send messages any more

-- Status lines inside a chat ("Support closed this conversation")
alter table messages add column if not exists system boolean not null default false;

alter table support_tickets add column if not exists conversation_id uuid references conversations(id) on delete set null;
alter table support_tickets add column if not exists last_message_at timestamptz;
alter table support_tickets add column if not exists awaiting text check (awaiting in ('staff', 'user'));  -- who owes the next reply
alter table support_tickets add column if not exists assigned_to uuid references profiles(id) on delete set null;
alter table support_tickets add column if not exists closed_at timestamptz;
update support_tickets set last_message_at = coalesce(last_message_at, created_at), awaiting = coalesce(awaiting, case when status in ('open', 'in_progress') then 'staff' end);
create index if not exists support_tickets_awaiting_idx on support_tickets (awaiting, last_message_at desc);

-- ───────────────────────── Mailing list ─────────────────────────
-- Everyone we can email: app users (synced from profiles) and outside contacts (imports, website sign-up form).
create table if not exists mailing_contacts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  first_name text, last_name text,
  user_id uuid unique references profiles(id) on delete set null,
  source text not null default 'manual' check (source in ('manual', 'import', 'signup_form', 'app_user', 'api')),
  -- pending = waiting for double opt-in; unsubscribed = no marketing; bounced/complained = never email again.
  status text not null default 'subscribed' check (status in ('pending', 'subscribed', 'unsubscribed', 'bounced', 'complained')),
  tags text[] not null default '{}',
  attributes jsonb not null default '{}'::jsonb,   -- custom merge fields: {{company}}, {{city}} …
  token text not null unique default encode(gen_random_bytes(18), 'hex'),  -- unsubscribe / preferences / confirm links
  consent_at timestamptz, confirmed_at timestamptz,
  unsubscribed_at timestamptz, unsubscribe_reason text,
  last_sent_at timestamptz, last_opened_at timestamptz, last_clicked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mailing_contacts_status_idx on mailing_contacts (status, created_at desc);
create index if not exists mailing_contacts_tags_idx on mailing_contacts using gin (tags);

create table if not exists mailing_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 80),
  description text,
  is_public boolean not null default false,       -- shown on the preferences page and usable by the public sign-up form
  double_opt_in boolean not null default true,    -- sign-ups must click a confirmation link first
  created_at timestamptz not null default now()
);

create table if not exists mailing_list_members (
  list_id uuid not null references mailing_lists(id) on delete cascade,
  contact_id uuid not null references mailing_contacts(id) on delete cascade,
  status text not null default 'subscribed' check (status in ('subscribed', 'unsubscribed')),
  added_at timestamptz not null default now(),
  primary key (list_id, contact_id)
);
create index if not exists mailing_list_members_contact_idx on mailing_list_members (contact_id);

create table if not exists mailing_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null, subject text not null default '', preheader text, html text not null default '',
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- kind: marketing (needs consent, has an unsubscribe link) or service (account news every user should get).
create table if not exists mailing_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'marketing' check (kind in ('marketing', 'service')),
  subject text not null default '', preheader text, from_name text, reply_to text, html text not null default '',
  audience jsonb not null default '{}'::jsonb,   -- { listIds, tags, roles, verification, appUsersOnly, excludeTags }
  track boolean not null default true,           -- open pixel + click tracking
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled')),
  scheduled_at timestamptz, started_at timestamptz, finished_at timestamptz,
  recipients int not null default 0,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists mailing_campaigns_status_idx on mailing_campaigns (status, scheduled_at);

-- Automated emails: one email per automation, sent `delay_hours` after the trigger. Chain several for a drip series.
create table if not exists mailing_automations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trigger text not null check (trigger in ('user_signup', 'contact_added', 'list_joined')),
  list_id uuid references mailing_lists(id) on delete cascade,   -- list_joined only
  roles text[] not null default '{}',                             -- user_signup only; empty = every role
  delay_hours int not null default 0 check (delay_hours between 0 and 8760),
  kind text not null default 'marketing' check (kind in ('marketing', 'service')),
  subject text not null, preheader text, html text not null, from_name text, reply_to text,
  active boolean not null default false,
  activated_at timestamptz,           -- only people who trigger it after this moment get it (no back-sending)
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- One row per email to one person (campaign or automation): the send queue and its delivery/engagement record.
create table if not exists mailing_sends (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references mailing_campaigns(id) on delete cascade,
  automation_id uuid references mailing_automations(id) on delete cascade,
  contact_id uuid not null references mailing_contacts(id) on delete cascade,
  email text not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'bounced', 'complained', 'skipped')),
  provider_id text, error text, attempts int not null default 0,
  send_after timestamptz not null default now(),
  sent_at timestamptz, delivered_at timestamptz,
  opened_at timestamptz, open_count int not null default 0,
  clicked_at timestamptz, click_count int not null default 0,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  check (campaign_id is not null or automation_id is not null)
);
-- Full (not partial) unique indexes so the API can insert with ON CONFLICT DO NOTHING; NULLs never collide.
create unique index if not exists mailing_sends_campaign_contact on mailing_sends (campaign_id, contact_id);
create unique index if not exists mailing_sends_automation_contact on mailing_sends (automation_id, contact_id);
create index if not exists mailing_sends_queue_idx on mailing_sends (send_after) where status = 'queued';
create index if not exists mailing_sends_provider_idx on mailing_sends (provider_id) where provider_id is not null;
create index if not exists mailing_sends_contact_idx on mailing_sends (contact_id, created_at desc);

-- Clicks per link (campaign report), opens, unsubscribes, bounces, complaints.
create table if not exists mailing_events (
  id bigserial primary key,
  send_id uuid references mailing_sends(id) on delete cascade,
  contact_id uuid references mailing_contacts(id) on delete cascade,
  type text not null check (type in ('open', 'click', 'unsubscribe', 'bounce', 'complaint', 'delivered', 'confirm', 'subscribe')),
  url text,
  created_at timestamptz not null default now()
);
create index if not exists mailing_events_send_idx on mailing_events (send_id, type);
create index if not exists mailing_events_created_idx on mailing_events (type, created_at desc);

-- API (service role) only, like the rest of the schema.
alter table mailing_contacts enable row level security;
alter table mailing_lists enable row level security;
alter table mailing_list_members enable row level security;
alter table mailing_templates enable row level security;
alter table mailing_campaigns enable row level security;
alter table mailing_automations enable row level security;
alter table mailing_sends enable row level security;
alter table mailing_events enable row level security;

notify pgrst, 'reload schema';
