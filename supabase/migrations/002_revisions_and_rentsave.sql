-- Revised final amount on job completion
alter table jobs
  add column revised_amount_kobo bigint,
  add column revision_status text check (revision_status in ('pending','awaiting_payment','approved','rejected')),
  add column revision_note text;

-- Top-up payments (landlord approves a higher final amount)
alter table payments drop constraint payments_purpose_check;
alter table payments add constraint payments_purpose_check
  check (purpose in ('inspection','subscription','rent','rentsave','job_escrow','job_topup'));

-- RentSave payout: apply savings to rent
create or replace function rentsave_debit(p_plan uuid, p_amount bigint) returns void language plpgsql as $$
begin
  update rentsave_plans
     set saved_kobo = saved_kobo - p_amount,
         status = case when status = 'completed' and saved_kobo - p_amount < target_kobo then 'active' else status end
   where id = p_plan and saved_kobo >= p_amount;
  if not found then raise exception 'INSUFFICIENT_SAVINGS'; end if;
end $$;
