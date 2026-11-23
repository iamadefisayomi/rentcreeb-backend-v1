-- Admin overview in ONE database call (GET /admin/overview). It replaces about 25 separate queries and the download of
-- up to 40,000 payment and profile rows that were summed in Node. p_full = false (admin managers) leaves out money
-- and the audit trail. Days are counted in Africa/Lagos time. Only the API (service role) may run it.

create index if not exists profiles_created_at_idx on profiles (created_at);
create index if not exists payments_status_created_idx on payments (status, created_at);
create index if not exists properties_status_idx on properties (status);

create or replace function public.admin_overview(p_full boolean default true) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  now_ timestamptz := now();
  d7 timestamptz := now() - interval '7 days';
  d14 timestamptz := now() - interval '14 days';
  d30 timestamptz := now() - interval '30 days';
  h1 timestamptz := now() - interval '1 hour';
  today date := (now() at time zone 'Africa/Lagos')::date;
  out jsonb;
begin
  with
  days as (select generate_series(today - 29, today, interval '1 day')::date as day),
  p as (select * from profiles where deleted_at is null)
  select jsonb_build_object(
    'generatedAt', now_,
    'users', (select jsonb_build_object(
        'total', count(*), 'new7d', count(*) filter (where created_at >= d7), 'newPrev7d', count(*) filter (where created_at >= d14 and created_at < d7),
        'today', count(*) filter (where (created_at at time zone 'Africa/Lagos')::date = today),
        'phoneVerified', count(*) filter (where phone_verified), 'verified', count(*) filter (where nin_verified),
        'onboarded', count(*) filter (where onboarding_completed), 'suspended', count(*) filter (where is_suspended),
        'tenants', count(*) filter (where role = 'tenant'), 'landlords', count(*) filter (where role in ('landlord', 'estate_manager')),
        'agents', count(*) filter (where role = 'agent'), 'artisans', count(*) filter (where role = 'artisan'),
        'byRole', (select coalesce(jsonb_object_agg(role, n), '{}') from (select role, count(*) n from p group by role) r)) from p),
    'queues', jsonb_build_object(
        'pendingProperties', (select count(*) from properties where status = 'pending'),
        'pendingArtisans', (select count(*) from artisan_profiles where review_status = 'pending'),
        'manualVerifications', (select count(*) from verifications where status = 'manual_review'),
        'openReports', (select count(*) from reports where status in ('open', 'investigating')),
        'openTickets', (select count(*) from support_tickets where status in ('open', 'in_progress')),
        'flaggedReviews', (select count(*) from reviews where flag_count > 0 and not hidden),
        'scamAlerts', (select count(*) from scam_alerts where status in ('open', 'reported')),
        'pendingWithdrawals', case when p_full then (select count(*) from withdrawals where status = 'pending' and created_at < h1) end,
        'stuckPayments', case when p_full then (select count(*) from payments where status = 'pending' and created_at < h1 and created_at >= d7) end),
    'listings', jsonb_build_object(
        'byStatus', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from properties group by status) s),
        'new7d', (select count(*) from properties where created_at >= d7),
        'newPrev7d', (select count(*) from properties where created_at >= d14 and created_at < d7),
        'topCities', (select coalesce(jsonb_agg(jsonb_build_object('city', city, 'n', n, 'avgKobo', avg_kobo) order by n desc), '[]') from (
            select initcap(trim(coalesce(nullif(trim(city), ''), nullif(trim(state), ''), 'Unknown'))) as city, count(*) n, round(avg(price_kobo)) avg_kobo
            from properties where status = 'approved' group by 1 order by count(*) desc limit 6) t)),
    'activity', jsonb_build_object(
        'liveProperties', (select count(*) from properties where status = 'approved'),
        'bookings7d', (select count(*) from bookings where created_at >= d7),
        'bookingsPrev7d', (select count(*) from bookings where created_at >= d14 and created_at < d7),
        'activeTenancies', (select count(*) from tenancies where status = 'active'),
        'openJobs', (select count(*) from jobs where status not in ('completed', 'cancelled')),
        'activeSubscriptions', (select count(*) from subscriptions where status = 'active'),
        'heldEscrows', (select count(*) from escrows where status = 'held'),
        'waitlist', (select count(*) from mailing_contacts where tags @> array['waitlist']),
        'waitlist7d', (select count(*) from mailing_contacts where tags @> array['waitlist'] and coalesce((attributes->>'waitlistJoinedAt')::timestamptz, created_at) >= d7),
        'tickets7d', (select count(*) from support_tickets where created_at >= d7)),
    'money', case when p_full then jsonb_build_object(
        'payments7dKobo', (select coalesce(sum(amount_kobo), 0) from payments where status = 'success' and created_at >= d7),
        'paymentsPrev7dKobo', (select coalesce(sum(amount_kobo), 0) from payments where status = 'success' and created_at >= d14 and created_at < d7),
        'payments30dKobo', (select coalesce(sum(amount_kobo), 0) from payments where status = 'success' and created_at >= d30),
        'paymentsCount30d', (select count(*) from payments where status = 'success' and created_at >= d30),
        'revenue30dKobo', (select coalesce(sum(amount_kobo), 0) from payments where status = 'success' and purpose = 'subscription' and created_at >= d30)
                          + (select coalesce(sum(fee_kobo), 0) from escrows where status = 'released' and released_at >= d30),
        'escrowHeldKobo', (select coalesce(sum(amount_kobo), 0) from escrows where status = 'held'),
        'walletsKobo', (select coalesce(sum(available_kobo), 0) from wallets),
        'withdrawalsPendingKobo', (select coalesce(sum(amount_kobo), 0) from withdrawals where status = 'pending'),
        'byPurpose30d', (select coalesce(jsonb_agg(x order by (x->>'kobo')::bigint desc), '[]') from (
            select jsonb_build_object('purpose', purpose, 'n', count(*), 'kobo', sum(amount_kobo)) x
            from payments where status = 'success' and created_at >= d30 group by purpose) t),
        'failed7d', (select count(*) from payments where status = 'failed' and created_at >= d7)) end,
    'trends', jsonb_build_object(
        'signups', (select jsonb_agg(jsonb_build_object('day', d.day, 'value', coalesce(c.n, 0)) order by d.day) from days d left join (
            select (created_at at time zone 'Africa/Lagos')::date as day, count(*) n from p where created_at >= d30 - interval '1 day' group by 1) c using (day)),
        'listings', (select jsonb_agg(jsonb_build_object('day', d.day, 'value', coalesce(c.n, 0)) order by d.day) from days d left join (
            select (created_at at time zone 'Africa/Lagos')::date as day, count(*) n from properties where created_at >= d30 - interval '1 day' group by 1) c using (day)),
        'paymentsKobo', case when p_full then (select jsonb_agg(jsonb_build_object('day', d.day, 'value', coalesce(c.n, 0)) order by d.day) from days d left join (
            select (coalesce(paid_at, created_at) at time zone 'Africa/Lagos')::date as day, sum(amount_kobo) n from payments
            where status = 'success' and created_at >= d30 - interval '2 days' group by 1) c using (day)) end),
    'recent', jsonb_build_object(
        'signups', (select coalesce(jsonb_agg(s), '[]') from (select id, first_name, last_name, email, role, avatar_url, nin_verified, phone_verified, created_at
            from p order by created_at desc limit 8) s),
        'payments', case when p_full then (select coalesce(jsonb_agg(x), '[]') from (
            select y.id, y.purpose, y.amount_kobo, y.status, y.created_at, y.paid_at,
              (select jsonb_build_object('id', u.id, 'first_name', u.first_name, 'last_name', u.last_name) from profiles u where u.id = y.user_id) as user
            from payments y order by y.created_at desc limit 8) x) end)
  ) into out;
  return out;
end $$;

revoke execute on function public.admin_overview(boolean) from public, anon, authenticated;
grant execute on function public.admin_overview(boolean) to service_role;
