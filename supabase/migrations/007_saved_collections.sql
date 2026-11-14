-- Saved Properties (Figma 4510:13893): collections + price-drop alerts. Safe to run more than once.

-- Price when the property was saved, so the Saved screen can flag price drops.
alter table saved_properties add column if not exists saved_price_kobo bigint;
update saved_properties sp set saved_price_kobo = p.price_kobo
  from properties p where p.id = sp.property_id and sp.saved_price_kobo is null;

-- User-named groups of saved properties ("Lekki Options", "Budget Picks" …). "All Saved" is implicit.
create table if not exists saved_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now()
);
create unique index if not exists saved_collections_user_name on saved_collections(user_id, lower(name));
alter table saved_collections enable row level security;

create table if not exists saved_collection_items (
  collection_id uuid not null references saved_collections(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (collection_id, property_id)
);
create index if not exists saved_collection_items_property on saved_collection_items(property_id);
alter table saved_collection_items enable row level security;

-- Report Agent (Figma 4507:5505): optional evidence photos.
alter table reports add column if not exists evidence_urls text[] not null default '{}';

-- Review Flow (Figma 4475:12808): optional separate "Rate the Agent" score. Agent averages use it when given.
alter table reviews add column if not exists agent_rating int check (agent_rating between 1 and 5);
create or replace function refresh_rating(p_user uuid) returns void language sql as $$
  update profiles p set rating_avg = coalesce(s.a, 0), rating_count = coalesce(s.c, 0)
  from (select round(avg(rating)::numeric, 2) a, count(*) c from (
          select coalesce(agent_rating, rating) as rating from reviews where agent_id = p_user and not hidden
          union all select rating from job_reviews where reviewee_id = p_user) x) s
  where p.id = p_user;
$$;

-- Subscription Plans (Figma 4549:3078): Monthly / Yearly (save 20%) billing.
alter table subscriptions add column if not exists billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly','yearly'));

-- Add New Property (Figma 4561:7410): extra listing details.
alter table properties add column if not exists parking_spaces int check (parking_spaces >= 0);
alter table properties add column if not exists year_built int check (year_built between 1900 and 2100);
alter table properties add column if not exists landmark text;
alter table properties add column if not exists caution_fee_kobo bigint check (caution_fee_kobo >= 0);
alter table properties add column if not exists agency_fee_kobo bigint check (agency_fee_kobo >= 0);
alter table properties add column if not exists security_features text[] not null default '{}';

notify pgrst, 'reload schema';
