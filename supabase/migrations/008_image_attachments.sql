-- 008_image_attachments.sql
-- End-to-end encrypted image sharing (Part 6).
--
-- Security invariants this migration enforces:
-- - A PRIVATE storage bucket holds only ciphertext blobs. The bucket is
--   `public = false`, so there are no public URLs; every access is an
--   authenticated request that must satisfy a storage policy.
-- - Storage policies scope access to the room encoded in the object path:
--   `<roomId>/<attachmentId>.bin`. Only the two room participants may
--   SELECT/INSERT objects, and only while the room has not expired. A random
--   authenticated user cannot retrieve another room's attachment even if they
--   know its path, attachment id or room id.
-- - Blobs are uploaded as opaque `application/octet-stream` ciphertext. The
--   server never stores or serves an image content type.
-- - attachment_room_id() extracts the room id from a path defensively and
--   never errors on malformed paths (which would otherwise be a DoS vector on
--   the policy).
-- - Clients may INSERT attachment metadata rows, but the INSERT policy binds
--   the row to its storage object: storage_path MUST equal
--   `<room_id>/<id>.bin`, the MIME type must be an allow-listed image type and
--   the IV must be 12 bytes. There is no UPDATE or DELETE policy on
--   attachments: metadata is immutable once written and blobs are deleted only
--   by the server-side purge (service_role), never by clients.
-- - Expiration reuses the existing purge_expired_rooms architecture: the cron
--   first deletes expired storage blobs (application-side, see
--   src/lib/storage/cleanup.ts) then purges the room rows, whose cascade
--   removes attachment metadata + messages.

-- ---------------------------------------------------------------------------
-- 1. Private bucket (idempotent; `public = false` is the point).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('encrypted-attachments', 'encrypted-attachments', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Defensive room-id extraction from a storage path.
-- ---------------------------------------------------------------------------
create or replace function public.attachment_room_id(p_name text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, storage
as $$
declare
  v_segment text;
begin
  v_segment := (storage.foldername(p_name))[1];
  if v_segment is null
     or v_segment !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v_segment::uuid;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Storage policies on storage.objects (bucket-scoped, participant-scoped,
--    expiry-aware). No public access: the bucket has no anon policies at all.
-- ---------------------------------------------------------------------------
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
    )
  );

-- Deliberately NO delete policy on storage.objects for clients: blobs are
-- removed only by the server-side purge (service_role). This matches the
-- message table, where clients also have no delete path.

-- ---------------------------------------------------------------------------
-- 4. attachments: INSERT policy for metadata rows + IV length constraint.
-- ---------------------------------------------------------------------------
alter table public.attachments
  add constraint attachments_iv_length check (char_length(iv) = 16);

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
    )
    and storage_path = room_id::text || '/' || id::text || '.bin'
    and mime_type in ('image/jpeg', 'image/png', 'image/gif', 'image/webp')
    and char_length(iv) = 16
  );

grant insert on public.attachments to authenticated;
