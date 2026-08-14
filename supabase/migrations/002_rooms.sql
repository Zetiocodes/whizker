-- 002_rooms.sql
-- Temporary 1-to-1 rooms, memberships, and wrapped-key material.
--
-- RLS is enabled but policies are added in 005_rooms_part3.sql. Until then
-- every non-superuser access to these tables is denied, so no client can read
-- arbitrary rooms or messages.

create type public.room_status as enum ('waiting', 'active', 'expired');
create type public.participant_role as enum ('owner', 'guest');

-- ---------------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------------
create table public.rooms (
  id         uuid             primary key default gen_random_uuid(),
  -- Human-readable join code: XXXX-XXXX-XXXX over the unambiguous alphabet
  -- A-H J-N P-Z 2-9 (no I, O, 0, 1). Never used as an encryption key.
  code       text             not null,
  owner_id   uuid             not null references auth.users (id) on delete cascade,
  created_at timestamptz      not null default now(),
  expires_at timestamptz      not null,
  status     public.room_status not null default 'waiting',
  constraint rooms_code_format  check (code ~ '^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){2}$'),
  constraint rooms_status_valid check (status in ('waiting', 'active', 'expired'))
);

create unique index rooms_code_unique on public.rooms (code);
create index rooms_expires_at_idx on public.rooms (expires_at);

-- Set expires_at deterministically to exactly 24h after created_at and make
-- both immutable afterwards.
create or replace function public.set_room_expiry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.expires_at := new.created_at + interval '24 hours';
  return new;
end;
$$;

create trigger rooms_set_expiry
  before insert on public.rooms
  for each row execute function public.set_room_expiry();

create or replace function public.protect_room_lifetime()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'room_lifetime_immutable';
  end if;
  return new;
end;
$$;

create trigger rooms_protect_lifetime
  before update of created_at, expires_at on public.rooms
  for each row execute function public.protect_room_lifetime();

-- ---------------------------------------------------------------------------
-- room_participants
-- ---------------------------------------------------------------------------
create table public.room_participants (
  id           uuid                  primary key default gen_random_uuid(),
  room_id      uuid                  not null references public.rooms (id) on delete cascade,
  user_id      uuid                  not null references auth.users (id) on delete cascade,
  role         public.participant_role not null default 'guest',
  -- Peer-visible name snapshot at join time.
  display_name text                  not null,
  joined_at    timestamptz           not null default now(),
  last_seen_at timestamptz,
  constraint room_participants_unique          unique (room_id, user_id),
  constraint room_participants_display_length check (char_length(display_name) between 1 and 32)
);

create index room_participants_user_idx on public.room_participants (user_id);

-- Exactly one owner per room.
create unique index one_owner_per_room on public.room_participants (room_id)
  where role = 'owner';

-- A room holds at most two participants. Cross-row limits cannot be a CHECK
-- constraint, so enforce with a BEFORE INSERT trigger.
create or replace function public.enforce_two_participants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.room_participants where room_id = new.room_id) >= 2 then
    raise exception 'room_full';
  end if;
  return new;
end;
$$;

create trigger room_participants_two_limit
  before insert on public.room_participants
  for each row execute function public.enforce_two_participants();

-- ---------------------------------------------------------------------------
-- room_keys: the room DEK wrapped for each participant.
-- Only the wrapped key and non-secret exchange parameters are stored; the
-- server never holds the plaintext DEK.
-- ---------------------------------------------------------------------------
create table public.room_keys (
  id                    uuid   primary key default gen_random_uuid(),
  room_id               uuid   not null references public.rooms (id) on delete cascade,
  user_id               uuid   not null references auth.users (id) on delete cascade,
  wrapped_key           text   not null,
  ephemeral_public_key  text   not null,
  key_exchange          text   not null check (key_exchange in ('ECDH-P256', 'X25519')),
  version               int    not null default 1,
  created_at            timestamptz not null default now(),
  constraint room_keys_unique unique (room_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Helper used by Part 3 RLS policies: is the current user a participant?
-- ---------------------------------------------------------------------------
create or replace function public.is_room_participant(target_room uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.room_participants rp
    where rp.room_id = target_room
      and rp.user_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: deny everything for clients until Part 3 adds policies.
-- ---------------------------------------------------------------------------
alter table public.rooms enable row level security;
alter table public.rooms force row level security;

alter table public.room_participants enable row level security;
alter table public.room_participants force row level security;

alter table public.room_keys enable row level security;
alter table public.room_keys force row level security;

-- Minimal grants so realtime subscriptions (which carry the user JWT) can
-- run once Part 3 policies exist. SELECT via anon/authenticated is still
-- blocked by the absence of policies above.
grant select on public.rooms, public.room_participants, public.room_keys to authenticated;
