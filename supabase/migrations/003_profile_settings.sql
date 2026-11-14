-- Settings → Personal Information fields, and soft account deletion.
alter table profiles
  add column username text,
  add column gender text check (gender in ('male','female','other','prefer_not_to_say')),
  add column date_of_birth date,
  add column agency_name text,
  add column license_number text,
  add column location text,
  add column deleted_at timestamptz;

-- Usernames are unique case-insensitively; NULL allowed for everyone who hasn't picked one.
create unique index profiles_username_lower_idx on profiles (lower(username)) where username is not null;
