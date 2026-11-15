-- 009: in-app voice/video calls between conversation participants.
-- Signalling (SDP offer/answer) is stored on the row; media flows peer-to-peer over WebRTC.
-- Idempotent: safe to run more than once.
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  caller_id uuid not null references profiles(id) on delete cascade,
  callee_id uuid not null references profiles(id) on delete cascade,
  kind text not null default 'audio' check (kind in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'accepted', 'declined', 'missed', 'cancelled', 'ended', 'failed')),
  offer jsonb,
  answer jsonb,
  end_reason text,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);
create index if not exists calls_callee_status_idx on calls (callee_id, status, created_at desc);
create index if not exists calls_caller_status_idx on calls (caller_id, status, created_at desc);
create index if not exists calls_conversation_idx on calls (conversation_id, created_at desc);
alter table calls enable row level security; -- only the API (service role) touches this table

notify pgrst, 'reload schema';
