-- 005_rooms_part3.sql
-- Room lifecycle RPCs, participant-scoped RLS policies, and cleanup grants.
--
-- Server-side rules enforced here:
-- - create_room / join_room / touch_presence are SECURITY DEFINER (owned by
--   the migration role, a superuser) so they bypass RLS. They are the ONLY
--   mutation path for clients: no insert/update/delete policies exist on
--   rooms / room_participants.
-- - join_room takes a FOR UPDATE row lock so two concurrent joins can never
--   both pass the two-participant capacity check.
-- - Expired rooms are never deleted inside join_room: raising an exception
--   rolls the whole operation back. purge_expired_rooms() removes them, and
--   it is triggered by both the hourly cron job and the expired-room page.

-- ---------------------------------------------------------------------------
-- 1. Room state model: 'full' -> 'waiting'
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'room_status'
      and e.enumlabel = 'full'
  ) then
    alter type public.room_status rename value 'full' to 'waiting';
  end if;
end;
$$;

-- 002's check constraint still lists the literal 'full' on projects that
-- applied the original migration, and the enum rename does not rewrite those
-- literals. Drop and re-add so fresh and upgraded databases converge.
alter table public.rooms drop constraint if exists rooms_status_valid;
alter table public.rooms
  add constraint rooms_status_valid check (status in ('waiting', 'active', 'expired'));

alter table public.rooms alter column status set default 'waiting';

-- ---------------------------------------------------------------------------
-- 2. RPCs
-- ---------------------------------------------------------------------------

-- create_room: create a room owned by the caller and record the owner's
-- membership. Raises 'invalid_code' for malformed codes; a unique violation
-- on rooms.code propagates untouched so callers can detect it and retry.
create or replace function public.create_room(p_code text)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  new_room public.rooms;
  v_display_name text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if p_code !~ '^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){2}$' then
    raise exception 'invalid_code';
  end if;

  select display_name into v_display_name
  from public.profiles
  where id = auth.uid();

  if v_display_name is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.rooms (code, owner_id, status)
  values (p_code, auth.uid(), 'waiting')
  returning * into new_room;

  insert into public.room_participants (room_id, user_id, role, display_name)
  values (new_room.id, auth.uid(), 'owner', v_display_name);

  return new_room;
end;
$$;

-- join_room: join a room by code. Idempotent for existing members. Rejects
-- missing / malformed / full / expired rooms. Serialized via FOR UPDATE.
create or replace function public.join_room(p_code text)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.rooms;
  v_display_name text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if p_code !~ '^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){2}$' then
    raise exception 'invalid_code';
  end if;

  select display_name into v_display_name
  from public.profiles
  where id = auth.uid();

  if v_display_name is null then
    raise exception 'not_authenticated';
  end if;

  select *
  into target
  from public.rooms
  where code = p_code
  for update;

  if not found then
    raise exception 'room_not_found';
  end if;

  if target.status = 'expired' or target.expires_at <= now() then
    raise exception 'room_expired';
  end if;

  if exists (
    select 1
    from public.room_participants rp
    where rp.room_id = target.id
      and rp.user_id = auth.uid()
  ) then
    return target;
  end if;

  if (select count(*)
      from public.room_participants rp
      where rp.room_id = target.id) >= 2 then
    raise exception 'room_full';
  end if;

  insert into public.room_participants (room_id, user_id, role, display_name)
  values (target.id, auth.uid(), 'guest', v_display_name);

  update public.rooms
  set status = 'active'
  where id = target.id
  returning * into target;

  return target;
end;
$$;

-- touch_presence: refresh the caller's last_seen_at for a room (heartbeat).
create or replace function public.touch_presence(p_room uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  update public.room_participants
  set last_seen_at = now()
  where room_id = p_room
    and user_id = auth.uid();
end;
$$;

-- purge_expired_rooms: hard-delete expired rooms. Cascade removes their
-- participants, keys, messages and attachment metadata. Storage blobs are
-- deleted by the application-side purge job (Part 4).
create or replace function public.purge_expired_rooms()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.rooms
  where expires_at <= now()
     or status = 'expired'
  returning count(*) into v_count;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. RLS policies (participant-scoped, expiry-aware)
-- ---------------------------------------------------------------------------

-- rooms: participants may read a room only while it is within its lifetime.
create policy "rooms_select_participant" on public.rooms
  for select
  to authenticated
  using (is_room_participant(id) and expires_at > now());

-- room_participants: participants may read memberships of their own rooms.
create policy "room_participants_select" on public.room_participants
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.rooms r
      where r.id = room_id
        and r.expires_at > now()
        and is_room_participant(r.id)
    )
  );

-- room_keys: participants may read only their own wrapped key material.
create policy "room_keys_select_own" on public.room_keys
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and is_room_participant(room_id)
    and exists (
      select 1
      from public.rooms r
      where r.id = room_id
        and r.expires_at > now()
    )
  );

-- messages / attachments: participants may read only their own rooms' data,
-- and only while the room has not expired.
create policy "messages_select_participant" on public.messages
  for select
  to authenticated
  using (
    is_room_participant(room_id)
    and exists (
      select 1
      from public.rooms r
      where r.id = room_id
        and r.expires_at > now()
    )
  );

create policy "attachments_select_participant" on public.attachments
  for select
  to authenticated
  using (
    is_room_participant(room_id)
    and exists (
      select 1
      from public.rooms r
      where r.id = room_id
        and r.expires_at > now()
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Grants: RPCs are the only mutation path for clients.
-- ---------------------------------------------------------------------------
revoke execute on function public.create_room(text) from public;
revoke execute on function public.join_room(text) from public;
revoke execute on function public.touch_presence(uuid) from public;
revoke execute on function public.purge_expired_rooms() from public;

grant execute on function public.create_room(text) to authenticated;
grant execute on function public.join_room(text) to authenticated;
grant execute on function public.touch_presence(uuid) to authenticated;
grant execute on function public.purge_expired_rooms() to service_role;
