-- Admin manager: a dashboard account with day-to-day moderation and support powers only (see
-- src/routes/admin/access.ts for exactly what it may do). It can't be chosen at sign-up (handle_new_user and
-- /auth/register only allow the public roles); a full admin grants it from Users -> Change role, or in SQL:
--   update profiles set role = 'admin_manager' where email = 'person@example.com';
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('tenant', 'landlord', 'estate_manager', 'artisan', 'agent', 'developer', 'investor', 'admin_manager', 'admin'));
