-- 023: the rentcreeb.com website now uses this backend and database (it used MongoDB + ImageKit before).
-- Adds the listing/profile fields the website has that the app does not, enquiry chats about a listing,
-- and what the one-off MongoDB import needs (legacy ids and old password hashes).

-- Listings: website URL slug, rent / sale / short-let, and the website's extra details (kitchens, LGA, furnishing,
-- floor plans, feature groups, availability dates…). The app ignores web_details; the website reads it back.
alter table properties add column if not exists slug text;
alter table properties add column if not exists listed_in text not null default 'for-rent';
alter table properties add column if not exists web_details jsonb not null default '{}'::jsonb;
alter table properties add column if not exists legacy_id text;
create unique index if not exists properties_slug_key on properties (lower(slug)) where slug is not null;
create unique index if not exists properties_legacy_id_key on properties (legacy_id) where legacy_id is not null;
alter table properties drop constraint if exists properties_listed_in_check;
alter table properties add constraint properties_listed_in_check check (listed_in in ('for-rent', 'for-sale', 'short-let'));
create index if not exists properties_listed_in_idx on properties (listed_in, status);

-- Profiles: WhatsApp number, social links and the website's "professional details" form.
alter table profiles add column if not exists whatsapp text;
alter table profiles add column if not exists socials jsonb not null default '{}'::jsonb;
alter table profiles add column if not exists professional jsonb not null default '{}'::jsonb;
alter table profiles add column if not exists legacy_id text;
create unique index if not exists profiles_legacy_id_key on profiles (legacy_id) where legacy_id is not null;

-- Enquiry chats: a renter messages a listing's owner before booking (website "Message agent").
alter table conversations drop constraint if exists conversations_context_type_check;
alter table conversations add constraint conversations_context_type_check
  check (context_type in ('booking', 'job', 'support', 'roommate', 'property'));
alter table conversations add column if not exists legacy_id text;
create unique index if not exists conversations_legacy_id_key on conversations (legacy_id) where legacy_id is not null;
alter table messages add column if not exists legacy_id text;
create unique index if not exists messages_legacy_id_key on messages (legacy_id) where legacy_id is not null;
alter table reviews add column if not exists legacy_id text;
create unique index if not exists reviews_legacy_id_key on reviews (legacy_id) where legacy_id is not null;

-- Old website passwords (better-auth scrypt hashes). On the first successful sign-in the password is moved into
-- Supabase Auth and the row is deleted, so nobody has to reset their password after the move.
create table if not exists legacy_credentials (
  user_id uuid primary key references profiles(id) on delete cascade,
  algo text not null default 'better-auth-scrypt',
  hash text not null,
  created_at timestamptz not null default now()
);
alter table legacy_credentials enable row level security; -- service role only
