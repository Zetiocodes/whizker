-- 013_immutable_messages_leave_chat.sql
--
-- Two changes:
--
-- A) IMMUTABLE MESSAGES (hardening)
--    Messages were already immutable under RLS (no UPDATE/DELETE policies exist
--    on messages/attachments — checked in supabase/tests/rls_checks.sql §7/§10,
--    and receipts advance status only through the mark_messages_* RPCs of
--    migration 007). This migration additionally revokes the table-level
--    UPDATE/DELETE privileges from every client role so a message row can never
--    be mutated or deleted even if a policy ever regressed, and it fails loudly
--    if an UPDATE/DELETE policy is ever introduced. Clients keep INSERT only:
--    send ciphertext, mark receipts via RPC. Nothing here changes E2EE.
--
-- B) LEAVE CHAT
--    Extends the existing room lifecycle state machine (`room_status`) with a
--    terminal 'closed' state instead of inventing a parallel one. The enum
--    value itself is added in migration 012 (its own transaction, so it is
--    committed before any statement here references it); this migration wires
--    it into the constraint, policies and RPCs. `leave_room` (SECURITY
--    DEFINER, executed with the user's session so auth.uid() is the caller)
--    atomically:
--      1. verifies the caller is a participant of a non-expired, non-closed room;
--      2. marks the room 'closed'  — every participant-scoped write/read policy
--         and the join path refuse the room from this instant;
--      3. inserts a `room_events` row (participant id + display-name snapshot
--         ONLY — never message content, keys or plaintext) which is published
--         on the realtime publication at commit, so the remaining participant's
--         browser sees "[Name] left the chat." BEFORE the room data disappears;
--      4. deletes the room's key material and encrypted content (messages +
--         attachment metadata via cascade);
--      5. removes the leaver's membership (their dashboard no longer lists the
--         room and their RLS can no longer reach it).
--    Encrypted storage blobs cannot be removed from SQL, so the leave server
--    action deletes them with the service-role storage API afterwards; if that
--    best-effort step fails, the hourly purge sweeps closed rooms' blobs too
--    (see src/lib/storage/cleanup.ts). The room row and the remaining
--    participant's membership are kept so the remaining dashboard can show the
--    room as "ended" until the natural 24h purge.

-- ---------------------------------------------------------------------------
-- 0. Lock ordering (deadlock safety) — do this FIRST.
-- ---------------------------------------------------------------------------
-- WHY THIS IS HERE:
--   Every statement below that touches messages / attachments / room_keys /
--   storage.objects / rooms (revokes, the rooms constraint rewrite, and the
--   policy drops/recreates) takes an ACCESS EXCLUSIVE lock on a live table.
--   Those tables are also read every moment by PostgREST and Realtime, whose
--   participant-scoped RLS policies themselves read public.rooms. Such a live
--   query locks ITS target table first and public.rooms afterwards. The
--   original migration instead locked rooms early (the ADD CONSTRAINT below)
--   and only locked the policy-owned tables much later, so a running query
--   could hold its target table (e.g. attachments) at the moment the migration
--   held rooms and wanted that target table. PostgreSQL then detected the
--   resulting wait cycle and aborted the migration:
--
--       ERROR: deadlock detected (SQLSTATE 40P01)
--       Process A waits for AccessExclusiveLock on <attachments>
--       Process B waits for AccessShareLock on <rooms>
--     (failing at "drop policy attachments_select_participant")
--
-- FIX:
--   1. Acquire every table lock this migration needs in ONE deterministic
--      order BEFORE any DDL: the policy-owned tables first, public.rooms LAST
--      — exactly the order live queries lock them (target table first, rooms
--      via the RLS subquery). Locks persist to the migration's commit, so the
--      later ALTER/DROP POLICY/CREATE POLICY statements below simply re-use
--      the locks already held and can never acquire them in a conflicting
--      order against a concurrent transaction.
--   2. The acquisition uses NOWAIT inside a retry loop: the migration never
--      blocks while holding a table lock, so it can never become the "B waits
--      for A, A waits for B" half of a lock cycle. A transient lock conflict
--      releases the partial set, sleeps briefly and retries until the whole
--      set is held at once.
--
-- THE LOCK SET IS EXACTLY THE DDL TARGETS:
--   messages, attachments, room_keys, storage.objects (policy rewrites) and
--   rooms (constraint rewrite). room_participants / profiles / auth.users /
--   user_public_keys are only referenced, never schema-modified, so they are
--   deliberately left OUT of the lock set — locking them would only add
--   lock-ordering risk with no benefit.

do $$
begin
  loop
    begin
      lock table
        public.attachments,
        public.messages,
        public.room_keys,
        storage.objects,
        public.rooms
      in access exclusive mode nowait;
      exit;
    exception
      when lock_not_available then
        perform pg_sleep(0.25);
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- A. Immutable messages: no client role can UPDATE or DELETE message rows.
-- ---------------------------------------------------------------------------
revoke update, delete on public.messages from anon, authenticated;
revoke update, delete on public.attachments from anon, authenticated;

-- Fail loudly if an UPDATE/DELETE policy is ever added: immutability is a DB
-- invariant, not just a client convention. (There are none today.)
do $$
begin
  if exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('messages', 'attachments')
      and p.cmd in ('UPDATE', 'DELETE')
  ) then
    raise exception 'immutable messages violated: UPDATE/DELETE policy on messages/attachments';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- B. Leave chat: extend the room lifecycle state machine with 'closed'.
--    The 'closed' enum value itself was added and committed by migration 012,
--    so this constraint can safely reference it here.
-- ---------------------------------------------------------------------------
alter table public.rooms drop constraint if exists rooms_status_valid;
alter table public.rooms
  add constraint rooms_status_valid check (status in ('waiting', 'active', 'expired', 'closed'));

-- ---------------------------------------------------------------------------
-- 1. room_events: minimal, append-only leave events for realtime delivery.
--    Holds ONLY metadata (participant id + display-name snapshot). No message
--    content, no keys, no plaintext ever.
-- ---------------------------------------------------------------------------
create type public.room_event_type as enum ('left');

create table public.room_events (
  id           uuid               primary key default gen_random_uuid(),
  room_id      uuid               not null references public.rooms (id) on delete cascade,
  user_id      uuid               not null references auth.users (id) on delete cascade,
  display_name text               not null check (char_length(display_name) between 1 and 32),
  type         public.room_event_type not null default 'left',
  created_at   timestamptz        not null default now()
);

create index room_events_room_created_idx on public.room_events (room_id, created_at);

alter table public.room_events enable row level security;
alter table public.room_events force row level security;

-- Only the two participants of a still-live room may read its events. A closed
-- room is deliberately still readable by its remaining participant (the room
-- row + their membership survive until the purge) so the 'left' event can be
-- delivered after the room is closed. The leaver's membership is deleted in the
-- same transaction that inserts the event, so their RLS can never read it.
create policy "room_events_select_participant" on public.room_events
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

-- No insert/update/delete policies: leave_room() is the only writer.
grant select on public.room_events to authenticated;

-- ---------------------------------------------------------------------------
-- 2. leave_room: atomic, authorized leave operation.
-- ---------------------------------------------------------------------------
create or replace function public.leave_room(p_room uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_display_name text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select *
  into v_room
  from public.rooms
  where id = p_room
  for update;

  if not found then
    raise exception 'room_not_found';
  end if;

  if not public.is_room_participant(p_room) then
    raise exception 'not_a_participant';
  end if;

  if v_room.expires_at <= now() or v_room.status = 'expired' then
    raise exception 'room_expired';
  end if;

  if v_room.status = 'closed' then
    raise exception 'room_closed';
  end if;

  select display_name into v_display_name
  from public.room_participants
  where room_id = p_room
    and user_id = auth.uid();

  if v_display_name is null then
    raise exception 'not_a_participant';
  end if;

  -- Mark the room closed. From this instant every participant-scoped policy
  -- (messages, attachments, room_keys, storage) and join_room refuse it.
  update public.rooms
  set status = 'closed'
  where id = p_room;

  -- Emit the leave event; realtime publishes it to the remaining participant
  -- at commit (their membership + the room row still exist).
  insert into public.room_events (room_id, user_id, display_name)
  values (p_room, auth.uid(), v_display_name);

  -- Destroy the room's key material and encrypted content immediately:
  -- room_keys (all participants' wrapped keys) and messages (attachments
  -- metadata rows cascade away with their messages).
  delete from public.room_keys where room_id = p_room;
  delete from public.messages where room_id = p_room;

  -- Remove the leaver from the active room: their dashboard no longer lists it
  -- and their RLS can no longer reach it.
  delete from public.room_participants
  where room_id = p_room
    and user_id = auth.uid();
end;
$$;

revoke execute on function public.leave_room(uuid) from public;
grant execute on function public.leave_room(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. join_room: a closed room can never be reused, even by a former member.
-- ---------------------------------------------------------------------------
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

  if target.status = 'closed' then
    raise exception 'room_closed';
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

-- ---------------------------------------------------------------------------
-- 4. Prevent further message/key/receipt/upload operations on closed rooms.
-- ---------------------------------------------------------------------------
-- messages: no new rows, no reads once the room is closed.
drop policy if exists "messages_insert_participant" on public.messages;
drop policy if exists "messages_select_participant" on public.messages;

create policy "messages_insert_participant" on public.messages
  for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and is_room_participant(room_id)
    and exists (
      select 1
      from public.rooms r
      where r.id = room_id
        and r.expires_at > now()
        and r.status <> 'closed'
    )
  );

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
        and r.status <> 'closed'
    )
  );

-- attachments metadata: no new rows, no reads once the room is closed.
drop policy if exists "attachments_select_participant" on public.attachments;
drop policy if exists "attachments_insert_participant" on public.attachments;

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
        and r.status <> 'closed'
    )
  );

create policy "attachments_insert_participant" on public.attachments
  for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and is_room_participant(room_id)
    and exists (
      select 1
      from public.rooms r
      where r.id = room_id
        and r.expires_at > now()
        and r.status <> 'closed'
    )
    and storage_path = room_id::text || '/' || id::text || '.bin'
    and mime_type in ('image/jpeg', 'image/png', 'image/gif', 'image/webp')
    and char_length(iv) = 16
    and exists (
      select 1
      from public.messages m
      where m.id = message_id
        and m.room_id = room_id
        and m.sender_id = auth.uid()
        and m.type = 'image'
    )
  );

-- room_keys: no new key rows or key updates once the room is closed.
drop policy if exists "room_keys_insert_own" on public.room_keys;
drop policy if exists "room_keys_update_own" on public.room_keys;

create policy "room_keys_insert_own" on public.room_keys
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and is_room_participant(room_id)
    and key_exchange in ('ECDH-P256', 'X25519')
    and exists (
      select 1
      from public.rooms r
      where r.id = room_id
        and r.expires_at > now()
        and r.status <> 'closed'
    )
  );

create policy "room_keys_update_own" on public.room_keys
  for update
  to authenticated
  using (
    user_id = auth.uid()
    and is_room_participant(room_id)
  )
  with check (
    user_id = auth.uid()
    and is_room_participant(room_id)
    and key_exchange in ('ECDH-P256', 'X25519')
    and exists (
      select 1
      from public.rooms r
      where r.id = room_id
        and r.expires_at > now()
        and r.status <> 'closed'
    )
  );

-- Storage objects: no reads/inserts once the room is closed (still no client
-- DELETE path — blobs are removed by the service role).
drop policy if exists "attachments_read_participant" on storage.objects;
drop policy if exists "attachments_insert_participant" on storage.objects;

create policy "attachments_read_participant" on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'encrypted-attachments'
    and public.is_room_participant(public.attachment_room_id(name))
    and exists (
      select 1
      from public.rooms r
      where r.id = public.attachment_room_id(name)
        and r.expires_at > now()
        and r.status <> 'closed'
    )
  );

create policy "attachments_insert_participant" on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'encrypted-attachments'
    and public.is_room_participant(public.attachment_room_id(name))
    and exists (
      select 1
      from public.rooms r
      where r.id = public.attachment_room_id(name)
        and r.expires_at > now()
        and r.status <> 'closed'
    )
  );

-- Receipt RPCs: refuse closed rooms (still refuse expired and non-participants).
create or replace function public.mark_messages_delivered(p_room uuid, p_message_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if not public.is_room_participant(p_room) then
    raise exception 'room_not_found';
  end if;

  if exists (
    select 1
    from public.rooms r
    where r.id = p_room
      and r.status = 'closed'
  ) then
    raise exception 'room_closed';
  end if;

  if not exists (
    select 1
    from public.rooms r
    where r.id = p_room
      and r.expires_at > now()
  ) then
    raise exception 'room_expired';
  end if;

  if p_message_ids is null or cardinality(p_message_ids) = 0 then
    return 0;
  end if;

  if cardinality(p_message_ids) > 500 then
    raise exception 'too_many_messages';
  end if;

  update public.messages m
  set status = 'delivered',
      delivered_at = coalesce(m.delivered_at, now())
  where m.room_id = p_room
    and m.sender_id <> auth.uid()
    and m.status = 'sent'
    and m.id = any (p_message_ids);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.mark_messages_read(p_room uuid, p_message_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if not public.is_room_participant(p_room) then
    raise exception 'room_not_found';
  end if;

  if exists (
    select 1
    from public.rooms r
    where r.id = p_room
      and r.status = 'closed'
  ) then
    raise exception 'room_closed';
  end if;

  if not exists (
    select 1
    from public.rooms r
    where r.id = p_room
      and r.expires_at > now()
  ) then
    raise exception 'room_expired';
  end if;

  if p_message_ids is null or cardinality(p_message_ids) = 0 then
    return 0;
  end if;

  if cardinality(p_message_ids) > 500 then
    raise exception 'too_many_messages';
  end if;

  update public.messages m
  set status = 'read',
      delivered_at = coalesce(m.delivered_at, now()),
      read_at = coalesce(m.read_at, now())
  where m.room_id = p_room
    and m.sender_id <> auth.uid()
    and m.status in ('sent', 'delivered')
    and m.id = any (p_message_ids);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Presence heartbeat: refuse closed rooms.
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

  if exists (
    select 1
    from public.rooms r
    where r.id = p_room
      and r.status = 'closed'
  ) then
    raise exception 'room_closed';
  end if;

  update public.room_participants
  set last_seen_at = now()
  where room_id = p_room
    and user_id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Realtime: publish room_events so the remaining participant receives the
--    leave event over its open websocket.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.room_events;
