-- Waitlist welcome email.
-- 1) New automation trigger 'waitlist_joined': someone joins the waitlist on the website (POST /web/waitlist).
--    The website route sends it the moment they sign up; the minute job is only a safety net (e.g. contacts tagged
--    "waitlist" by import). Edit or switch it off in Admin → Mailing → Automations.
-- 2) A ready-made "Waitlist welcome" automation, switched on, plus a "Waitlist update" template for campaigns.
--    People who joined before this migration don't get the welcome (no back-sending); reach them with a campaign whose
--    audience is "Waitlist".

alter table mailing_automations drop constraint if exists mailing_automations_trigger_check;
alter table mailing_automations add constraint mailing_automations_trigger_check
  check (trigger in ('user_signup', 'contact_added', 'list_joined', 'waitlist_joined'));

insert into mailing_automations (name, trigger, delay_hours, kind, subject, preheader, html, active, activated_at)
select 'Waitlist welcome', 'waitlist_joined', 0, 'marketing',
  'You''re on the RentCreeb waitlist, {{first_name|there}} 🎉',
  'Thanks for joining. Here''s what happens next, and what RentCreeb will do for you.',
  $html$<h1>You're on the list, {{first_name|there}}! 🎉</h1>
<p>Thanks for joining the RentCreeb waitlist. You're one of the first people to get access to a simpler, safer way to rent in Nigeria.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:#f4f6fb;border-radius:10px;padding:16px 18px">
<p style="margin:0 0 12px"><strong>🏠 Verified homes</strong><br>Real photos, clear prices, and landlords and agents whose identity we've checked.</p>
<p style="margin:0 0 12px"><strong>🛡️ Safer payments</strong><br>Inspection fees and repair payments are held safely until the job is done.</p>
<p style="margin:0 0 12px"><strong>💬 Chat and call in the app</strong><br>Talk to landlords and agents without giving out your phone number.</p>
<p style="margin:0"><strong>🔧 Trusted artisans</strong><br>Plumbers, electricians, cleaners and more, rated by people like you.</p>
</td></tr></table>
<h2>What happens next</h2>
<p>We're letting people in a few at a time. We'll email you at <strong>{{email}}</strong> as soon as your spot is ready, along with early-access perks for waitlist members.</p>
<p>Know someone tired of house-hunting stress? Send them to <a href="https://www.rentcreeb.com" style="color:#2563eb;font-weight:600">rentcreeb.com</a> so they can join too.</p>
<p style="margin:22px 0"><a href="https://www.rentcreeb.com" class="btn" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600">Visit RentCreeb</a></p>
<p>Speak soon,<br>The RentCreeb team</p>$html$,
  true, now()
where not exists (select 1 from mailing_automations where trigger = 'waitlist_joined');

insert into mailing_templates (name, subject, preheader, html)
select 'Waitlist update', 'News from RentCreeb, {{first_name|there}}',
  'An update for our waitlist members.',
  $html$<h1>Hi {{first_name|there}}, here's an update</h1>
<p>You joined the RentCreeb waitlist, and we wanted you to be the first to know what's new.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:#f4f6fb;border-radius:10px;padding:16px 18px">
<p style="margin:0 0 12px"><strong>[Headline: e.g. RentCreeb is now live in Lagos]</strong><br>[One or two sentences about the news.]</p>
<p style="margin:0"><strong>[Second point: e.g. Your early-access perk]</strong><br>[What it is and how to claim it.]</p>
</td></tr></table>
<p style="margin:22px 0"><a href="{{app_url}}" class="btn" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600">Get started</a></p>
<p>Thanks for being with us early,<br>The RentCreeb team</p>$html$
where not exists (select 1 from mailing_templates where name = 'Waitlist update');
