-- supabase/tests/rls_checks.sql
-- Manual authorization-boundary checks for the Part 3 room system.
--
-- Run this in the Supabase SQL editor (as postgres) AFTER applying all
-- migrations, then follow the verification steps. Each block below raises an
-- exception when the boundary it checks is broken.

-- ---------------------------------------------------------------------------
-- 0. Fixtures: create two accounts and a room through the app, or insert
--    directly here (postgres bypasses RLS). Adapt to your own user ids.
-- ---------------------------------------------------------------------------
-- select id from auth.users order by created_at limit 5;
-- insert into public.rooms (code, owner_id, status)
--   values ('AAAA-AAAA-AAAA', '<owner_user_id>', 'waiting');
-- insert into public.room_participants (room_id, user_id, role, display_name)
--   values ((select id from public.rooms where code = 'AAAA-AAAA-AAAA'),
--           '<owner_user_id>', 'owner', 'Owner');

-- ---------------------------------------------------------------------------
-- 1. RPCs are the only client mutation path.
--    No insert/update/delete policies exist on rooms / room_participants, so
--    a normal JWT cannot mutate them directly (only via create_room /
--    join_room / touch_presence).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('rooms', 'room_participants')
      and p.policyname not in ('rooms_select_participant', 'room_participants_select')
  ) then
    raise exception 'unexpected policy on rooms/room_participants';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Anon cannot read anything.
--    With FORCE RLS and no anon policies, every table returns zero rows.
-- ---------------------------------------------------------------------------
set role anon;
do $$
declare
  v_rooms bigint;
  v_participants bigint;
  v_messages bigint;
begin
  select count(*) into v_rooms from public.rooms;
  select count(*) into v_participants from public.room_participants;
  select count(*) into v_messages from public.messages;
  if v_rooms <> 0 or v_participants <> 0 or v_messages <> 0 then
    raise exception 'anon role can read room data';
  end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 3. Anon cannot execute the mutation RPCs.
-- ---------------------------------------------------------------------------
set role anon;
do $$
begin
  perform public.join_room('AAAA-AAAA-AAAA');
  raise exception 'anon could call join_room';
exception
  when insufficient_privilege then null;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 4. A non-participant cannot see a room or its members.
--    Replace <other_user_id> with an authenticated user who is NOT a member.
-- ---------------------------------------------------------------------------
-- set local role authenticated;
-- set request.jwt.claim.sub = '<other_user_id>';
-- do $$
-- declare
--   v_count bigint;
-- begin
--   select count(*) into v_count from public.rooms;
--   if v_count <> 0 then
--     raise exception 'non-participant can see rooms';
--   end if;
-- end;
-- $$;

-- ---------------------------------------------------------------------------
-- 5. A participant sees their room while it is live, but nothing after the
--    expiry time passes. Expiry is not relied on: purge_expired_rooms()
--    hard-deletes the rows.
-- ---------------------------------------------------------------------------
-- -- force-expire for testing (postgres bypasses RLS):
-- update public.rooms
-- set expires_at = now() - interval '1 second'
-- where code = 'AAAA-AAAA-AAAA';
-- select purge_expired_rooms(); -- expect 1

-- ---------------------------------------------------------------------------
-- 6. Concurrent joins cannot exceed two participants: join_room serializes
--    on FOR UPDATE and the enforce_two_participants trigger is the backstop.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 7. Receipt RPCs (Part 5, migration 007) are the ONLY way a client can
--    advance a message status: there must be no UPDATE policy on messages.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'messages'
      and p.cmd = 'UPDATE'
  ) then
    raise exception 'unexpected UPDATE policy on messages; receipts must go through mark_messages_*';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Anon cannot execute the receipt RPCs.
-- ---------------------------------------------------------------------------
set role anon;
do $$
begin
  perform public.mark_messages_delivered(
    (select id from public.rooms limit 1),
    array[]::uuid[]
  );
  raise exception 'anon could call mark_messages_delivered';
exception
  when insufficient_privilege then null;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 9. Receipt boundaries (run as an authenticated participant, e.g. the guest
--    who RECEIVES a message from the owner). Replace the ids below with real
--    values. Expect:
--    - guest can mark the owner's message delivered then read (return counts
--      of 1), and the status is monotonic (sent -> delivered -> read, never
--      back);
--    - the OWNER cannot mark their own sent message (count 0) — receipts are
--      not forgeable;
--    - a non-participant receives 'room_not_found';
--    - an expired room receives 'room_expired'.
-- ---------------------------------------------------------------------------
-- select mark_messages_delivered('<room_id>', array['<message_sent_by_owner>']::uuid[]);  -- 1
-- select mark_messages_read('<room_id>', array['<message_sent_by_owner>']::uuid[]);       -- 1
-- select status from messages where id = '<message_sent_by_owner>';                        -- 'read'
-- -- owner side (must be the sender): mark_messages_delivered returns 0
-- select mark_messages_delivered('<room_id>', array['<message_sent_by_owner>']::uuid[]);  -- 0
-- -- missing messages are silently ignored (no error, count 0):
-- select mark_messages_read('<room_id>', array[gen_random_uuid()]::uuid[]);               -- 0
-- -- too many ids in one batch is rejected:
-- select mark_messages_read('<room_id>', (select array_agg(gen_random_uuid()) from generate_series(1, 501))::uuid[]);

-- ---------------------------------------------------------------------------
-- 10. Attachments metadata (Part 6, migration 008) is INSERT-only for clients:
--     no UPDATE/DELETE policies exist, so rows are immutable once written and
--     deletion happens only via the server-side purge cascade.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'attachments'
      and p.cmd in ('UPDATE', 'DELETE')
  ) then
    raise exception 'unexpected UPDATE/DELETE policy on attachments';
  end if;
  if not exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'attachments'
      and p.cmd = 'INSERT'
      and p.policyname = 'attachments_insert_participant'
  ) then
    raise exception 'missing attachments INSERT policy';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Attachment metadata shape is enforced by constraints: a 12-byte base64url
--     IV (16 chars) is a DB-level check, not just client code.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'attachments_iv_length'
      and conrelid = 'public.attachments'::regclass
  ) then
    raise exception 'missing attachments_iv_length constraint';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Storage boundaries (Part 6): the encrypted-attachments bucket must be
--     PRIVATE, reachable only via participant-scoped storage policies, with NO
--     client DELETE path, and the defensive attachment_room_id() helper must
--     exist. A public bucket would leak ciphertext URLs to the world.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from storage.buckets where id = 'encrypted-attachments' and public
  ) then
    raise exception 'encrypted-attachments bucket must be private';
  end if;
  if not exists (
    select 1
    from pg_policies p
    where p.schemaname = 'storage'
      and p.tablename = 'objects'
      and p.policyname in ('attachments_read_participant', 'attachments_insert_participant')
  ) then
    raise exception 'missing participant storage policies';
  end if;
  if exists (
    select 1
    from pg_policies p
    where p.schemaname = 'storage'
      and p.tablename = 'objects'
      and p.cmd = 'DELETE'
      and p.policyname like 'attachments_%'
  ) then
    raise exception 'unexpected client storage DELETE policy';
  end if;
  if not exists (
    select 1 from pg_proc where proname = 'attachment_room_id'
  ) then
    raise exception 'missing attachment_room_id() helper';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Manual two-browser checks (Part 6). Run as each authenticated user:
--
--   Participant (owner):
--     -- insert succeeds only while the room is live and the path matches:
--     insert into public.attachments
--       (id, room_id, message_id, sender_id, storage_path, mime_type,
--        size_bytes, iv, version, expires_at)
--     values (gen_random_uuid(), '<room_id>', '<message_id>', '<owner_id>',
--             '<room_id>/' || gen_random_uuid()::text || '.bin',
--             'image/png', 123, 'AAAAAAAAAAAAAAAA', 1, now() + interval '1 day');
--     -- a tampered storage_path (not room_id/id.bin) is rejected: expect error
--     -- a MIME outside the allow-list is rejected: expect error
--     -- an iv that is not 16 base64url chars is rejected: expect error
--
--     -- download the encrypted blob via storage (participant):
--     select * from storage.objects
--     where bucket_id = 'encrypted-attachments';
--
--   Non-participant (<other_user_id>):
--     -- sees zero attachments rows and zero storage objects (even knowing the
--     -- path); inserting is rejected.
--
--   Expired room:
--     -- once expires_at passes, SELECT/INSERT on attachments and storage are
--     -- denied; run purge_expired_rooms() + the cron blob purge and the rows +
--     -- blobs are gone.
--
--   Uploaded object content-type is application/octet-stream, never image/*,
--   and the stored bytes are AES-GCM ciphertext (not a decodable image).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 14. Attachment/message binding (Part 8, migration 009): the attachments
--     INSERT policy must require the referenced message to exist, be in the
--     SAME room, be authored by the attachment's sender, and be an image
--     message — an attachment can never hang off another participant's (or
--     another room's, or a text) message.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'attachments'
      and p.policyname = 'attachments_insert_participant'
  ) then
    raise exception 'missing attachments INSERT policy';
  end if;
end;
$$;

-- Manual check (run as an authenticated participant, e.g. the owner):
--   -- valid: reference a message you authored in this room (type = image):
--   --   succeeds only when the message already exists
--   --   invalid: message_id pointing at a TEXT message -> rejected (type check)
--   --   invalid: message_id authored by the OTHER participant -> rejected
--   --   invalid: message_id in a different room -> rejected
--   --   invalid: message_id that does not exist yet -> rejected (FK + policy)
-- The app therefore always inserts the messages row before the attachments row.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 15. Table-level privileges (Part 8, migration 010). The `authenticated` role
--     must hold the table GRANTs that back its RLS policies:
--       - profiles    SELECT/UPDATE  (getCurrentUser + display-name policy, 001)
--       - messages    INSERT         (sending ciphertext, 006)
--       - room_keys   INSERT/UPDATE  (E2EE key agreement, 006)
--       - user_public_keys INSERT/UPDATE (identity key publish/rotate, 006)
--     A missing grant (e.g. profiles SELECT) manifests as `permission denied`
--     (SQLSTATE 42501) even though the policy allows the row: RLS can only
--     filter rows the role may touch at the table level. If any required
--     privilege is missing, apply migration 010.
--
--     Row-level access remains enforced by the RLS policies checked above;
--     these grants never widen what a role can read or mutate per row.
--     UPDATE on messages is intentionally absent: receipts go through the
--     SECURITY DEFINER RPCs (007). No DELETE grants are asserted here because
--     Supabase default privileges may legitimately grant them; the actual
--     mutation boundary is the absence of DELETE policies, already checked in
--     sections 1, 7, 10 and 12.
-- ---------------------------------------------------------------------------
do $$
begin
  if not (
    has_table_privilege('authenticated', 'public.profiles', 'SELECT')
    and has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
    and has_table_privilege('authenticated', 'public.messages', 'INSERT')
    and has_table_privilege('authenticated', 'public.room_keys', 'INSERT')
    and has_table_privilege('authenticated', 'public.room_keys', 'UPDATE')
    and has_table_privilege('authenticated', 'public.user_public_keys', 'INSERT')
    and has_table_privilege('authenticated', 'public.user_public_keys', 'UPDATE')
  ) then
    raise exception 'authenticated role is missing required table grants (run migration 010)';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 16. IMMUTABLE MESSAGES (Part 10, migrations 012-013). Messages/attachments must
--     be permanently immutable: no UPDATE/DELETE table privilege for any
--     client role (in addition to the policy-level checks in 7 and 10), so a
--     row can never be mutated or deleted even if a policy ever regressed.
-- ---------------------------------------------------------------------------
do $$
begin
  if has_table_privilege('authenticated', 'public.messages', 'UPDATE')
     or has_table_privilege('authenticated', 'public.messages', 'DELETE')
     or has_table_privilege('anon', 'public.messages', 'UPDATE')
     or has_table_privilege('anon', 'public.messages', 'DELETE')
     or has_table_privilege('authenticated', 'public.attachments', 'UPDATE')
     or has_table_privilege('authenticated', 'public.attachments', 'DELETE')
     or has_table_privilege('anon', 'public.attachments', 'UPDATE')
     or has_table_privilege('anon', 'public.attachments', 'DELETE')
  then
    raise exception 'messages/attachments must be immutable (no UPDATE/DELETE grants)';
  end if;
end;
$$;

-- Executable denial: even `where false` is rejected at the table level.
set role authenticated;
do $$
begin
  update public.messages set status = 'read' where false;
  raise exception 'authenticated could UPDATE messages';
exception
  when insufficient_privilege then null;
end;
$$;
do $$
begin
  delete from public.messages where false;
  raise exception 'authenticated could DELETE messages';
exception
  when insufficient_privilege then null;
end;
$$;
do $$
begin
  update public.attachments set mime_type = 'image/png' where false;
  raise exception 'authenticated could UPDATE attachments';
exception
  when insufficient_privilege then null;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 17. room_events (Part 10, migrations 012-013): append-only lifecycle metadata.
--     Only a participant SELECT policy exists; the leave_room RPC is the only
--     writer and authenticated holds SELECT only.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'room_events'
      and p.policyname = 'room_events_select_participant'
      and p.cmd = 'SELECT'
  ) then
    raise exception 'missing room_events participant SELECT policy';
  end if;
  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'room_events'
      and p.cmd in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'room_events must be append-only via leave_room';
  end if;
  if not (
    has_table_privilege('authenticated', 'public.room_events', 'SELECT')
    and not has_table_privilege('authenticated', 'public.room_events', 'INSERT')
    and not has_table_privilege('authenticated', 'public.room_events', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.room_events', 'DELETE')
  ) then
    raise exception 'authenticated must hold SELECT-only on room_events';
  end if;
end;
$$;

-- Executable denial: a client cannot write an event directly.
set role authenticated;
do $$
begin
  insert into public.room_events (room_id, user_id, display_name)
  values (gen_random_uuid(), gen_random_uuid(), 'spoof');
  raise exception 'authenticated could INSERT into room_events';
exception
  when insufficient_privilege then null;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 18. leave_room (Part 10, migrations 012-013): executable by authenticated only,
--     never by anon, and it is the ONLY way to close a room.
-- ---------------------------------------------------------------------------
do $$
begin
  if not has_function_privilege('authenticated', 'public.leave_room(uuid)', 'EXECUTE') then
    raise exception 'leave_room must be executable by authenticated';
  end if;
  if has_function_privilege('anon', 'public.leave_room(uuid)', 'EXECUTE') then
    raise exception 'leave_room must not be executable by anon';
  end if;
end;
$$;

set role anon;
do $$
begin
  perform public.leave_room(gen_random_uuid());
  raise exception 'anon could call leave_room';
exception
  when insufficient_privilege then null;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 19. Closed rooms (Part 10, migrations 012-013): every participant write/read
--     policy for messages, attachments and room_keys, plus the storage
--     policies, must gate on `status <> 'closed'`, so the instant a room is
--     left it is inert for every participant. (The receipts RPCs and
--     touch_presence also raise room_closed; join_room raises it too — see
--     the manual checks below.)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_ok boolean := true;
begin
  for r in
    select p.tablename, p.policyname,
           p.qual,
           p.with_check as wc
    from pg_policies p
    where p.schemaname = 'public'
      and p.policyname in (
        'messages_insert_participant', 'messages_select_participant',
        'attachments_insert_participant', 'attachments_select_participant',
        'room_keys_insert_own', 'room_keys_update_own'
      )
  loop
    if coalesce(r.qual, '') not ilike '%closed%'
       and coalesce(r.wc, '') not ilike '%closed%' then
      v_ok := false;
    end if;
  end loop;
  if not v_ok then
    raise exception 'a participant read/write policy does not gate on status <> closed';
  end if;
end;
$$;

do $$
declare
  r record;
  v_ok boolean := true;
begin
  for r in
    select p.policyname,
           p.qual,
           p.with_check as wc
    from pg_policies p
    where p.schemaname = 'storage'
      and p.policyname in ('attachments_read_participant', 'attachments_insert_participant')
  loop
    if coalesce(r.qual, '') not ilike '%closed%'
       and coalesce(r.wc, '') not ilike '%closed%' then
      v_ok := false;
    end if;
  end loop;
  if not v_ok then
    raise exception 'a storage policy does not gate on status <> closed';
  end if;
end;
$$;

-- Manual checks (Part 10). Run as an authenticated participant (the owner),
-- with '<room_id>' being a live room's id:
--
--   -- leaving destroys the room atomically:
--   select public.leave_room('<room_id>');
--   select status from public.rooms where id = '<room_id>';               -- 'closed'
--   select count(*) from public.room_participants where room_id = '<room_id>'; -- 1 (the leaver's row is gone)
--   select count(*) from public.messages where room_id = '<room_id>';     -- 0
--   select count(*) from public.room_keys where room_id = '<room_id>';    -- 0
--   select display_name from public.room_events where room_id = '<room_id>'; -- the leaver's snapshot
--   -- second leave attempt (same user) raises 'room_closed' (membership gone):
--   select public.leave_room('<room_id>');                                -- error 'room_closed'
--
--   -- a closed room can never be reused, even by a former member:
--   select public.join_room('<code of the closed room>');                 -- error 'room_closed'
--   -- and the remaining participant's views are inert immediately:
--   --   select count(*) from public.messages where room_id = '<room_id>';    -- 0
--   --   select count(*) from storage.objects where bucket_id = 'encrypted-attachments'
--   --        and name like '<room_id>/%';                                   -- 0 after blob purge
--   --   select public.mark_messages_delivered('<room_id>', array[]::uuid[]); -- error 'room_closed'
--   --   select public.touch_presence('<room_id>');                           -- error 'room_closed'
