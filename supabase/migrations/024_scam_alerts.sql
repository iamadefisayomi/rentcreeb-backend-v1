-- 024: scam alerts in chats. Every message is screened after it is sent (services/scamGuard.ts): pattern rules first,
-- then the AI reads the recent conversation when something looks suspicious. The person at risk sees a warning in
-- the chat (the sender is never told); admins review everything in Admin → Scam alerts.

create table if not exists scam_alerts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  suspect_id uuid references profiles(id) on delete set null,     -- who sent the suspicious message
  recipient_id uuid not null references profiles(id) on delete cascade, -- who is warned
  risk text not null check (risk in ('medium', 'high')),
  category text not null,
  reason text not null,                                           -- shown to the recipient
  signals jsonb not null default '[]'::jsonb,                     -- rule hits, for admins
  source text not null default 'rules' check (source in ('rules', 'ai')),
  excerpt text,                                                   -- the flagged text (trimmed), for admins
  status text not null default 'open' check (status in ('open', 'dismissed', 'reported', 'confirmed', 'cleared')),
  user_action_at timestamptz,
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  admin_note text,
  created_at timestamptz not null default now()
);

create index if not exists scam_alerts_conv_idx on scam_alerts (conversation_id, recipient_id, status);
create index if not exists scam_alerts_status_idx on scam_alerts (status, created_at desc);
create index if not exists scam_alerts_suspect_idx on scam_alerts (suspect_id, created_at desc);

-- Only the backend (service role) reads and writes alerts.
alter table scam_alerts enable row level security;

notify pgrst, 'reload schema';
