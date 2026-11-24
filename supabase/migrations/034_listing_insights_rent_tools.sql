-- 034: listing price history (price-drop alerts, fair-price check), landlord rent rules (automatic reminders and
-- late fees) and verifiable rental-history certificates.

-- ───────── Price history: one row per price change, written by a trigger so every path (app, website, admin) counts ─────────
create table if not exists property_price_history (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  old_price_kobo bigint not null,
  new_price_kobo bigint not null,
  price_period text,
  changed_at timestamptz not null default now()
);
create index if not exists property_price_history_idx on property_price_history (property_id, changed_at desc);

create or replace function log_property_price_change() returns trigger language plpgsql as $$
begin
  if new.price_kobo is distinct from old.price_kobo then
    insert into property_price_history (property_id, old_price_kobo, new_price_kobo, price_period)
    values (new.id, old.price_kobo, new.price_kobo, new.price_period);
  end if;
  return new;
end $$;
drop trigger if exists property_price_change on properties;
create trigger property_price_change after update of price_kobo on properties
  for each row execute function log_property_price_change();

-- ───────── Rent rules per landlord: reminder schedule + optional late fee ─────────
create table if not exists rent_settings (
  landlord_id uuid primary key references profiles(id) on delete cascade,
  reminders_enabled boolean not null default true,
  remind_days_before int[] not null default '{7,3,1}',   -- days before the due date
  remind_on_due_day boolean not null default true,
  remind_days_after int[] not null default '{1,7}',      -- days after, while still unpaid
  late_fee_enabled boolean not null default false,
  late_fee_type text not null default 'percent' check (late_fee_type in ('percent', 'fixed')),
  late_fee_value numeric not null default 5 check (late_fee_value >= 0),  -- percent of the rent, or kobo when fixed
  late_fee_grace_days int not null default 7 check (late_fee_grace_days between 0 and 90),
  updated_at timestamptz not null default now()
);

-- The late fee is added onto the overdue rent itself, so paying the rent pays the fee (no change to the payment flow).
alter table rent_payments add column if not exists late_fee_kobo bigint not null default 0;
alter table rent_payments add column if not exists late_fee_applied_at timestamptz;

-- One reminder per rent payment per tag ('before:7', 'due', 'after:1', 'late_fee') so the daily job never repeats one.
create table if not exists rent_reminder_log (
  rent_payment_id uuid not null references rent_payments(id) on delete cascade,
  tag text not null,
  sent_at timestamptz not null default now(),
  primary key (rent_payment_id, tag)
);

-- ───────── Rental-history certificates anyone can verify by code / QR ─────────
create table if not exists rent_certificates (
  code text primary key,                       -- e.g. RC-7K2Q-PX9M, printed on the PDF
  user_id uuid not null references profiles(id) on delete cascade,
  snapshot jsonb not null,                     -- what the certificate said when issued
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists rent_certificates_user_idx on rent_certificates (user_id, created_at desc);

-- Only the backend (service role) reads and writes these.
alter table property_price_history enable row level security;
alter table rent_settings enable row level security;
alter table rent_reminder_log enable row level security;
alter table rent_certificates enable row level security;

notify pgrst, 'reload schema';
