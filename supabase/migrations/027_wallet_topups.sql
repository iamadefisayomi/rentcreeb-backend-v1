-- Wallet top-ups: any user can add money to their RentCreeb wallet by card / bank transfer (Paystack, purpose
-- 'wallet_topup'). The credit happens in services/paymentProcessor.ts (onWalletTopup), idempotent via the wallet
-- reference "topup:<payment id>". Safe to run before or after 026 (this check is a superset).
alter table payments drop constraint if exists payments_purpose_check;
alter table payments add constraint payments_purpose_check
  check (purpose in ('inspection', 'subscription', 'rent', 'rentsave', 'job_escrow', 'job_topup', 'bill', 'utility', 'wallet_topup'));
create index if not exists payments_topup_idx on payments(user_id, paid_at) where purpose = 'wallet_topup';
