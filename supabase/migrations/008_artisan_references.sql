-- 008: richer artisan references (company, role, relationship, socials, consent).
-- Idempotent: safe to run more than once.
alter table artisan_references add column if not exists email text;
alter table artisan_references add column if not exists relationship text;
alter table artisan_references add column if not exists company text;
alter table artisan_references add column if not exists job_title text;
alter table artisan_references add column if not exists years_known int;
alter table artisan_references add column if not exists socials jsonb not null default '[]'::jsonb;
alter table artisan_references add column if not exists note text;
alter table artisan_references add column if not exists consent boolean not null default false;
alter table artisan_references add column if not exists created_at timestamptz not null default now();

notify pgrst, 'reload schema';
