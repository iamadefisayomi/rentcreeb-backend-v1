-- 025: job orders from tenants and landlords (who created it, who pays, cancellation).
--
--   Tenant creates + pays     → posted to artisans at once; the tenant runs it; the landlord can see and cancel it.
--   Tenant asks landlord to pay → waits for the landlord to accept paying (funding_status); declined → the tenant
--                                 can pay themselves, edit and resend, or cancel.
--   Landlord creates          → the landlord runs and pays; the tenant of that property sees it.
--
-- Existing rows keep today's behaviour: tenant tickets were landlord-paid, standalone jobs were landlord jobs.

alter table maintenance_requests add column if not exists created_by text not null default 'tenant';
alter table maintenance_requests add column if not exists funding text not null default 'landlord';
alter table maintenance_requests add column if not exists funding_status text;
alter table maintenance_requests add column if not exists funding_note text;
alter table maintenance_requests add column if not exists cancelled_at timestamptz;
alter table maintenance_requests add column if not exists cancelled_by uuid references profiles(id);
alter table maintenance_requests add column if not exists cancel_reason text;
alter table maintenance_requests drop constraint if exists maintenance_requests_created_by_check;
alter table maintenance_requests add constraint maintenance_requests_created_by_check check (created_by in ('tenant', 'landlord'));
alter table maintenance_requests drop constraint if exists maintenance_requests_funding_check;
alter table maintenance_requests add constraint maintenance_requests_funding_check check (funding in ('tenant', 'landlord'));
alter table maintenance_requests drop constraint if exists maintenance_requests_funding_status_check;
alter table maintenance_requests add constraint maintenance_requests_funding_status_check check (funding_status is null or funding_status in ('pending', 'accepted', 'declined'));
-- Old open tickets were waiting for the landlord, i.e. a pending landlord-funded request.
update maintenance_requests set funding_status = case when status = 'open' then 'pending' when status in ('rejected') then 'declined' else 'accepted' end
  where funding_status is null and funding = 'landlord';

alter table jobs add column if not exists created_by text not null default 'landlord';
alter table jobs add column if not exists payer text not null default 'landlord';
alter table jobs add column if not exists cancelled_at timestamptz;
alter table jobs add column if not exists cancelled_by uuid references profiles(id);
alter table jobs add column if not exists cancel_reason text;
alter table jobs drop constraint if exists jobs_created_by_check;
alter table jobs add constraint jobs_created_by_check check (created_by in ('tenant', 'landlord'));
alter table jobs drop constraint if exists jobs_payer_check;
alter table jobs add constraint jobs_payer_check check (payer in ('tenant', 'landlord'));
-- Jobs that came from a tenant's ticket were ordered (and are approved) by the tenant.
update jobs set created_by = 'tenant' where maintenance_request_id is not null and tenant_id is not null and created_by = 'landlord'
  and not exists (select 1 from maintenance_requests m where m.id = jobs.maintenance_request_id and m.created_by = 'landlord');

notify pgrst, 'reload schema';
