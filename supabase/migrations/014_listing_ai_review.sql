-- 014: automatic AI review of new listings (see src/services/listingReview.ts).
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor.
alter table properties add column if not exists ai_review jsonb;            -- latest result: verdict, checks, issues, summary
alter table properties add column if not exists ai_reviewed_at timestamptz;  -- when it ran (re-runs if the listing changes after this)
create index if not exists properties_pending_review_idx on properties (status, ai_reviewed_at) where status = 'pending';

notify pgrst, 'reload schema';
