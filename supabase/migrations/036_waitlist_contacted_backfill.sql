-- Waitlist: a delivered welcome email now moves someone from "pending" to "contacted" (Admin → Waitlist).
-- The backend does this from now on; this catches up everyone who already got the welcome before that change.
-- Only "pending" people change; anyone an admin already moved on (invited, joined, not interested) is left alone.
update mailing_contacts c
set attributes = coalesce(c.attributes, '{}'::jsonb)
      || jsonb_build_object('waitlistStatus', 'contacted', 'waitlistContactedAt', to_jsonb(s.sent_at)),
    updated_at = now()
from (
  select ms.contact_id, min(ms.sent_at) as sent_at
  from mailing_sends ms
  join mailing_automations a on a.id = ms.automation_id
  where a.trigger = 'waitlist_joined' and ms.status = 'sent' and ms.sent_at is not null
  group by ms.contact_id
) s
where s.contact_id = c.id
  and 'waitlist' = any(c.tags)
  and coalesce(c.attributes->>'waitlistStatus', 'pending') = 'pending';
