-- Permanently delete a user (admin dashboard: Users → person → Delete permanently).
--
-- One transaction: it either removes everything or changes nothing. Removed: the sign-in (auth.users), the profile and
-- everything tied to it, including records shared with other people (their chats, bookings, tenancies, jobs,
-- maintenance requests and reviews with this user, and this user's listings).
-- Kept but unlinked (user set to null): payments and escrows, so finance totals stay right.
-- Refused while money is in motion: a wallet or RentSave balance, held escrow, a pending withdrawal, an active tenancy,
-- or a paid / confirmed booking. Settle those first, or use "Close account" (anonymise) instead.
--
-- Only the API (service role) may run it.

alter table payments alter column user_id drop not null;
alter table escrows alter column payer_id drop not null;
alter table escrows alter column payee_id drop not null;

create or replace function public.admin_delete_user(p_uid uuid) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_props uuid[]; v_bookings uuid[]; v_tenancies uuid[]; v_mreqs uuid[]; v_jobs uuid[]; v_quotes uuid[]; v_subs uuid[]; v_convs uuid[];
  v_problem text;
  c record;
begin
  if not exists (select 1 from profiles where id = p_uid) then raise exception 'USER_NOT_FOUND'; end if;

  -- ── money guards ──
  select case
    when exists (select 1 from wallets where user_id = p_uid and available_kobo > 0) then 'their wallet still has a balance'
    when exists (select 1 from rentsave_plans where tenant_id = p_uid and saved_kobo > 0) then 'they have money saved in RentSave'
    when exists (select 1 from escrows where (payer_id = p_uid or payee_id = p_uid) and status = 'held') then 'money is held in escrow for them'
    when exists (select 1 from withdrawals where user_id = p_uid and status = 'pending') then 'a withdrawal is still pending'
    when exists (select 1 from tenancies where (landlord_id = p_uid or tenant_id = p_uid) and status = 'active') then 'they have an active tenancy'
    when exists (select 1 from bookings where (tenant_id = p_uid or host_id = p_uid) and status in ('paid', 'confirmed')) then 'they have a paid or confirmed booking'
  end into v_problem;
  if v_problem is not null then raise exception 'MONEY_IN_MOTION: %', v_problem; end if;

  -- ── what goes ──
  select coalesce(array_agg(id), '{}') into v_props from properties where owner_id = p_uid;
  select coalesce(array_agg(id), '{}') into v_bookings from bookings where tenant_id = p_uid or host_id = p_uid or property_id = any(v_props);
  select coalesce(array_agg(id), '{}') into v_tenancies from tenancies where landlord_id = p_uid or tenant_id = p_uid or property_id = any(v_props);
  select coalesce(array_agg(id), '{}') into v_mreqs from maintenance_requests
    where tenant_id = p_uid or landlord_id = p_uid or property_id = any(v_props) or tenancy_id = any(v_tenancies);
  select coalesce(array_agg(id), '{}') into v_jobs from jobs where landlord_id = p_uid or property_id = any(v_props) or maintenance_request_id = any(v_mreqs);
  select coalesce(array_agg(id), '{}') into v_quotes from job_quotes where artisan_id = p_uid or job_id = any(v_jobs);
  select coalesce(array_agg(id), '{}') into v_subs from subscriptions where agent_id = p_uid;
  select coalesce(array_agg(id), '{}') into v_convs from conversations where participant_a = p_uid or participant_b = p_uid;

  if exists (select 1 from escrows where status = 'held' and (booking_id = any(v_bookings) or job_id = any(v_jobs))) then
    raise exception 'MONEY_IN_MOTION: money is held in escrow on a booking or job of theirs';
  end if;

  -- ── keep payments and escrows, unlinked ──
  update payments set user_id = null where user_id = p_uid;
  update escrows set payer_id = null where payer_id = p_uid;
  update escrows set payee_id = null where payee_id = p_uid;
  update escrows set booking_id = null where booking_id = any(v_bookings);
  update escrows set job_id = null where job_id = any(v_jobs);
  -- every payments column that points at something being deleted (columns differ between installs, so look them up)
  for c in select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'payments'
             and column_name in ('booking_id', 'job_id', 'quote_id', 'subscription_id', 'tenancy_id', 'rentsave_plan_id') loop
    execute format('update payments set %I = null where %I = any($1)', c.column_name, c.column_name)
      using case c.column_name
        when 'booking_id' then v_bookings when 'job_id' then v_jobs when 'quote_id' then v_quotes
        when 'subscription_id' then v_subs when 'tenancy_id' then v_tenancies
        else (select coalesce(array_agg(id), '{}') from rentsave_plans where tenant_id = p_uid or tenancy_id = any(v_tenancies)) end;
  end loop;

  -- ── references this user only appears in as a bystander ──
  update jobs set artisan_id = null where artisan_id = p_uid and not (id = any(v_jobs));
  update jobs set tenant_id = null where tenant_id = p_uid and not (id = any(v_jobs));
  update jobs set cancelled_by = null where cancelled_by = p_uid;
  update maintenance_requests set cancelled_by = null where cancelled_by = p_uid;
  update maintenance_events set actor_id = null where actor_id = p_uid;
  update rent_payments set recorded_by = null where recorded_by = p_uid;
  update rentsave_plans set tenancy_id = null where tenancy_id = any(v_tenancies) and tenant_id <> p_uid;

  -- ── delete, children before parents ──
  delete from reviews where agent_id = p_uid or reviewer_id = p_uid or booking_id = any(v_bookings);
  delete from reports where reporter_id = p_uid or agent_id = p_uid or booking_id = any(v_bookings);
  delete from job_reviews where reviewer_id = p_uid or reviewee_id = p_uid;
  delete from job_reports where artisan_id = p_uid;
  delete from job_quotes where id = any(v_quotes);
  delete from jobs where id = any(v_jobs);
  delete from maintenance_requests where id = any(v_mreqs);
  delete from tenancies where id = any(v_tenancies);
  delete from bookings where id = any(v_bookings);
  delete from subscriptions where id = any(v_subs);
  delete from messages where sender_id = p_uid;
  delete from conversations where id = any(v_convs);
  delete from properties where id = any(v_props);
  delete from wallet_transactions where user_id = p_uid;
  delete from withdrawals where user_id = p_uid;
  delete from mailing_contacts where user_id = p_uid;

  -- The sign-in last: cascades to profiles, and from there to wallets, verifications, notifications, tickets, etc.
  delete from auth.users where id = p_uid;
  delete from profiles where id = p_uid; -- in case the profile wasn't linked to an auth user

  return jsonb_build_object('properties', cardinality(v_props), 'bookings', cardinality(v_bookings), 'tenancies', cardinality(v_tenancies),
    'maintenanceRequests', cardinality(v_mreqs), 'jobs', cardinality(v_jobs), 'conversations', cardinality(v_convs));
end $$;

revoke execute on function public.admin_delete_user(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_user(uuid) to service_role;
