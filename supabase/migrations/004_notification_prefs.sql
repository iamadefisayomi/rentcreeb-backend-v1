-- Settings → Notification Settings. Partial map of preference key → boolean; missing keys use the
-- defaults in api/src/services/notify.ts (NOTIFICATION_DEFAULTS).
alter table profiles add column notification_prefs jsonb not null default '{}'::jsonb;
