-- 019: video tour links on listings (YouTube, Vimeo, TikTok, Instagram, Facebook, Loom, Dailymotion, Streamable).
-- The API only accepts links from those hosts (src/lib/videoLinks.ts) and stores them in canonical form.
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor after 018.
alter table properties add column if not exists video_urls text[] not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_video_urls_max') then
    alter table properties add constraint properties_video_urls_max check (coalesce(array_length(video_urls, 1), 0) <= 5);
  end if;
end $$;

notify pgrst, 'reload schema';
