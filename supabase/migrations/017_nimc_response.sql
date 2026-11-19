-- 017: keep the full NIN check response for the admin reviewer: every field Bytid/NIMC returned (pictures removed)
-- and the pictures themselves (the NIMC ID photo, signature …) as private files.
-- Only the API (service role) can read them. Kept on file for every outcome (selfies are the ones deleted later).
-- Idempotent: safe to run more than once. Run in the Supabase SQL editor after 016.

alter table verifications add column if not exists nimc_record jsonb;  -- provider response, pictures replaced by placeholders
alter table verifications add column if not exists nimc_files jsonb;   -- [{ field, path, type }] in the private storage zone

notify pgrst, 'reload schema';
