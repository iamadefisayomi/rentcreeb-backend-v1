-- Paid NIN verification. Each Bytid check costs the user NIN_VERIFICATION_FEE naira (backend .env; 0 = free).
-- One successful 'nin_verification' payment = one check. The check claims the payment by setting used_at
-- (compare-and-set, so a payment can never pay for two checks); a provider outage gives it back (used_at = null).
-- verifications.payment_id links each check to the payment that paid for it (shown on the admin ID review page).
-- Safe to re-run.

alter table payments drop constraint if exists payments_purpose_check;
alter table payments add constraint payments_purpose_check
  check (purpose in ('inspection', 'subscription', 'rent', 'rentsave', 'job_escrow', 'job_topup', 'bill', 'utility', 'wallet_topup', 'nin_verification'));

alter table payments add column if not exists used_at timestamptz;
create index if not exists payments_nin_credit_idx on payments(user_id, paid_at) where purpose = 'nin_verification' and status = 'success' and used_at is null;

alter table verifications add column if not exists payment_id uuid references payments(id) on delete set null;

notify pgrst, 'reload schema';
