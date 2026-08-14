-- 007_realtime_receipts.sql
-- Delivery + read receipts (Part 5).
--
-- Security invariants this migration enforces:
-- - Only the RECIPIENT may advance a message's status, and only forward
--   (sent -> delivered -> read). A sender can never mark their own message, so
--   no participant can forge another's receipt.
-- - Receipts carry only message ids + room id: they never touch the
--   ciphertext, IV, version, sender or type columns, and nothing here
--   reads, writes or logs any message content.
-- - Receipts are batched client-side and applied here in ONE write per
--   status, so a busy conversation does not produce one UPDATE per message.
-- - Implemented as SECURITY DEFINER RPCs (the same pattern as create_room /
--   join_room): there is deliberately NO update policy on messages, so the
--   existing RLS posture is not weakened and clients still cannot mutate
--   message rows directly.
-- - All guards re-check the room lifetime server-side, so an expired room
--   can never receive receipt updates.

-- ---------------------------------------------------------------------------
-- 1. mark_messages_delivered: sent -> delivered (recipient only).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2. mark_messages_read: sent/delivered -> read (recipient only).
--    Marking read implies delivered, so delivered_at is backfilled too.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3. Grants: authenticated clients only; never anon or public.
-- ---------------------------------------------------------------------------
revoke execute on function public.mark_messages_delivered(uuid, uuid[]) from public;
revoke execute on function public.mark_messages_read(uuid, uuid[]) from public;

grant execute on function public.mark_messages_delivered(uuid, uuid[]) to authenticated;
grant execute on function public.mark_messages_read(uuid, uuid[]) to authenticated;
