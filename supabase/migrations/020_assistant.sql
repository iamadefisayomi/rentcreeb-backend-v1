-- 020: RentCreeb Assistant (in-app AI help) and live support agents it can hand a chat over to.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor after 019.

-- One assistant chat per user at a time ("active"); a handover turns it into a support ticket thread.
create table if not exists assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'handed_off', 'ended')),
  ticket_id uuid references support_tickets(id) on delete set null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists assistant_conversations_user_idx on assistant_conversations (user_id, created_at desc);
create index if not exists assistant_conversations_status_idx on assistant_conversations (status, updated_at desc);

create table if not exists assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  actions jsonb not null default '[]'::jsonb,   -- buttons the app shows under a reply: [{ label, screen, params }]
  meta jsonb not null default '{}'::jsonb,      -- tools used, token usage, errors (admins only)
  feedback smallint check (feedback in (-1, 1)),
  created_at timestamptz not null default now()
);
create index if not exists assistant_messages_conv_idx on assistant_messages (conversation_id, created_at);

-- Knowledge the team edits in the admin dashboard; the assistant reads it on every chat (no deploy needed).
create table if not exists assistant_knowledge (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 2 and 160),
  body text not null check (char_length(body) between 2 and 8000),
  tags text[] not null default '{}',
  active boolean not null default true,
  updated_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Admins who answer support chats. "Available" + seen in the dashboard recently = can take a handover now.
create table if not exists support_agents (
  admin_id uuid primary key references profiles(id) on delete cascade,
  available boolean not null default false,
  max_open int not null default 15 check (max_open between 1 and 500),
  last_seen_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists support_tickets_assigned_idx on support_tickets (assigned_to, status);

alter table assistant_conversations enable row level security;
alter table assistant_messages enable row level security;
alter table assistant_knowledge enable row level security;
alter table support_agents enable row level security;

notify pgrst, 'reload schema';
