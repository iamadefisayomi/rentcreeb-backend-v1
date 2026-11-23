-- Security hardening for money.
-- 1) Only the API (service role) may run the functions that move money. Supabase grants EXECUTE on new functions to
--    anon + authenticated by default, so a signed-in user holding the public anon key (the app ships it for Realtime)
--    could call them through PostgREST. Today Row Level Security makes those calls fail, but one careless policy later
--    ("users can update their own wallet") would turn wallet_credit into free money. Revoke instead of relying on luck.
-- 2) The functions refuse zero / negative amounts themselves (a negative debit would otherwise be a credit).
-- 3) bank_accounts.changed_at: withdrawals pause for 24 h after the payout account is changed (account-takeover guard).

create or replace function wallet_credit(p_user uuid, p_amount bigint, p_kind text, p_desc text, p_ref text)
returns boolean language plpgsql as $$
declare n int;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  insert into wallet_transactions(user_id, direction, amount_kobo, kind, description, reference)
  values (p_user, 'credit', p_amount, p_kind, p_desc, p_ref) on conflict (reference) do nothing;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  update wallets set available_kobo = available_kobo + p_amount, updated_at = now() where user_id = p_user;
  if not found then raise exception 'NO_WALLET'; end if;
  return true;
end $$;

create or replace function wallet_debit(p_user uuid, p_amount bigint, p_kind text, p_desc text, p_ref text)
returns void language plpgsql as $$
begin
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  update wallets set available_kobo = available_kobo - p_amount, updated_at = now()
   where user_id = p_user and available_kobo >= p_amount;
  if not found then raise exception 'INSUFFICIENT_FUNDS'; end if;
  insert into wallet_transactions(user_id, direction, amount_kobo, kind, description, reference)
  values (p_user, 'debit', p_amount, p_kind, p_desc, p_ref);
end $$;

create or replace function rentsave_add(p_plan uuid, p_amount bigint) returns void language plpgsql as $$
begin
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  update rentsave_plans set saved_kobo = saved_kobo + p_amount,
    status = case when saved_kobo + p_amount >= target_kobo then 'completed' else status end
   where id = p_plan;
end $$;

create or replace function rentsave_debit(p_plan uuid, p_amount bigint) returns void language plpgsql as $$
begin
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  update rentsave_plans
     set saved_kobo = saved_kobo - p_amount,
         status = case when status = 'completed' and saved_kobo - p_amount < target_kobo then 'active' else status end
   where id = p_plan and saved_kobo >= p_amount;
  if not found then raise exception 'INSUFFICIENT_SAVINGS'; end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'wallet_credit(uuid, bigint, text, text, text)', 'wallet_debit(uuid, bigint, text, text, text)',
    'rentsave_add(uuid, bigint)', 'rentsave_debit(uuid, bigint)', 'refresh_rating(uuid)'
  ] loop
    if to_regprocedure('public.' || f) is not null then
      execute format('revoke execute on function public.%s from public, anon, authenticated', f);
      execute format('grant execute on function public.%s to service_role', f);
    end if;
  end loop;
end $$;

-- Functions created later stay private unless granted on purpose.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

alter table bank_accounts add column if not exists changed_at timestamptz;

-- Belt and braces: balances can never go negative and transactions are always positive (already true in 001; kept
-- here so the guarantee is visible next to the functions that rely on it).
alter table wallets drop constraint if exists wallets_available_kobo_check;
alter table wallets add constraint wallets_available_kobo_check check (available_kobo >= 0);
