-- 015: keep the AI listing review entirely private to the backend and admins.
-- Moves the review out of `properties` (which listers can read) into its own table that only the API (service role)
-- can touch, and adds live progress (queued → running → done) for the admin dashboard.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor after 014.

create table if not exists listing_ai_reviews (
  property_id uuid primary key references properties(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done')),
  stage text,                         -- while running: rules | ai | deciding
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  listing_updated_at timestamptz,     -- the listing version that was checked (re-checked when the listing changes)
  decision text,                      -- auto_approved | needs_admin | error
  attempts int not null default 0,    -- consecutive tries without an AI answer for this version
  review jsonb,                       -- rule checks, AI verdict, reasons
  updated_at timestamptz not null default now()
);
create index if not exists listing_ai_reviews_status_idx on listing_ai_reviews (status, updated_at desc);
alter table listing_ai_reviews enable row level security;   -- no policies: app users can never read it
revoke all on listing_ai_reviews from anon, authenticated;

-- Carry over anything 014 already stored, then remove the columns from properties.
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'properties' and column_name = 'ai_review') then
    insert into listing_ai_reviews (property_id, status, decision, review, finished_at, listing_updated_at)
      select id, 'done', ai_review->>'decision', ai_review, ai_reviewed_at, nullif(ai_review->>'listingUpdatedAt', '')::timestamptz
      from properties where ai_review is not null
      on conflict (property_id) do nothing;
  end if;
end $$;
drop index if exists properties_pending_review_idx;
alter table properties drop column if exists ai_review;
alter table properties drop column if exists ai_reviewed_at;

notify pgrst, 'reload schema';
