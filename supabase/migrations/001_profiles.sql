-- 001_profiles.sql
-- Account metadata + username enforcement
--
-- Accounts are created through Supabase Auth (GoTrue). Because the product
-- has no email, GoTrue stores a synthetic identifier:
--     <normalized_username>@whisper.invalid
-- (see src/config/index.ts -> auth.syntheticEmailDomain).
-- The username is also carried in raw_user_meta_data at signup and mirrored
-- into public.profiles by the trigger below. The UNIQUE constraint on
-- profiles.username is the race-safe guarantee that no two accounts can
-- share a username: a concurrent duplicate signup rolls back the auth user.

create table public.profiles (
  id          uuid        primary key references auth.users (id) on delete cascade,
  username    text        not null,
  display_name text       not null,
  created_at  timestamptz not null default now(),
  constraint profiles_username_chars       check (username ~ '^[a-z0-9_]+$'),
  constraint profiles_username_length     check (char_length(username) between 3 and 20),
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 32)
);

create unique index profiles_username_unique on public.profiles (username);

-- ---------------------------------------------------------------------------
-- Trigger: create a profile row for every new auth user.
-- Normalizes the username defensively (lowercase + trim). Raises on a
-- duplicate username so the whole auth.users insert is rolled back.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_username text;
  raw_display  text;
begin
  raw_username := lower(btrim(new.raw_user_meta_data ->> 'username'));
  raw_display  := btrim(new.raw_user_meta_data ->> 'display_name');

  if raw_username is null or raw_username = '' then
    raise exception 'username_required';
  end if;

  if raw_display is null or raw_display = '' then
    raw_display := raw_username;
  end if;

  insert into public.profiles (id, username, display_name)
  values (new.id, raw_username, left(raw_display, 32));

  return new;

exception
  when unique_violation then
    raise exception 'username_taken';
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Trigger: usernames are immutable. Changing one would break the synthetic
-- email mapping used for login.
-- ---------------------------------------------------------------------------
create or replace function public.protect_username()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.username is distinct from old.username then
    raise exception 'username_immutable';
  end if;
  return new;
end;
$$;

create trigger profiles_protect_username
  before update of username on public.profiles
  for each row execute function public.protect_username();

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- - Users may read only their own profile row.
-- - Users may update only their own row (display name).
-- - No client insert/delete: profiles are created by the trigger above.
-- - FORCE RLS applies policies even to the table owner (superusers still
--   bypass, which the security-definer triggers rely on).
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

create policy "profiles_select_own" on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy "profiles_update_own" on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
