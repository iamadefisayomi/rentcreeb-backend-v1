-- Utility payments (airtime, data, electricity, cable TV, internet, exam PINs) bought in the app and delivered through
-- VTpass. Paid by card (Paystack, purpose 'utility') or from the RentCreeb wallet. Failed deliveries are refunded to the
-- wallet. See backend/src/services/utilities.ts.

create table if not exists utility_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  category text not null check (category in ('airtime', 'data', 'electricity', 'tv', 'internet', 'education')),
  service_id text not null,                 -- VTpass serviceID, e.g. mtn, ikeja-electric, dstv
  provider_name text not null,
  customer_id text not null,                -- phone, meter number, smartcard / IUC, account ID
  customer_name text,
  meter_type text check (meter_type in ('prepaid', 'postpaid')),
  variation_code text,                      -- data plan / bouquet / exam PIN type
  variation_name text,
  phone text,                               -- contact phone sent to the biller
  amount_kobo bigint not null check (amount_kobo > 0),
  fee_kobo bigint not null default 0 check (fee_kobo >= 0),
  total_kobo bigint not null check (total_kobo > 0),
  pay_method text not null check (pay_method in ('card', 'wallet')),
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'processing', 'delivered', 'failed', 'refunded', 'cancelled')),
  payment_id uuid references payments(id) on delete set null,
  request_id text not null unique,          -- our idempotency key at VTpass
  provider_ref text,                        -- VTpass transactionId
  token text,                               -- electricity token / exam PIN(s)
  units text,                               -- kWh for prepaid electricity
  error text,
  provider_response jsonb,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists utility_orders_user_idx on utility_orders(user_id, created_at desc);
create index if not exists utility_orders_processing_idx on utility_orders(status, updated_at) where status = 'processing';

alter table utility_orders enable row level security; -- server-only (service role); no client policies

alter table payments add column if not exists utility_order_id uuid references utility_orders(id) on delete set null;
alter table payments drop constraint if exists payments_purpose_check;
alter table payments add constraint payments_purpose_check
  check (purpose in ('inspection', 'subscription', 'rent', 'rentsave', 'job_escrow', 'job_topup', 'bill', 'utility'));
