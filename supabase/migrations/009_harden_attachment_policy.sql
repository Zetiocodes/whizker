-- 009_harden_attachment_policy.sql
-- Part 8 hardening: bind an attachments row to an existing, sender-owned
-- image message in the same room.
--
-- The Part 6 policy let a participant insert an attachments row whose
-- message_id referenced ANY message — including one they did not author, a
-- text message, or a message in another room. Combined with the storage_path
-- binding this could not leak plaintext (blobs are ciphertext and the message
-- payload must be decrypted to reveal the attachment id), but it allowed
-- metadata to be attached to another participant's message id and permitted an
-- attachment to reference a message row that did not exist yet.
--
-- This policy now additionally requires that the referenced message:
--   - already exists,
--   - belongs to the SAME room as the attachment,
--   - was authored by the attachment's sender (auth.uid()),
--   - is an image message.
-- Clients MUST therefore insert the messages row before the attachments row.
-- No update/delete policies exist on attachments; metadata is immutable.

drop policy if exists "attachments_insert_participant" on public.attachments;

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
    and exists (
      select 1
      from public.messages m
      where m.id = message_id
        and m.room_id = room_id
        and m.sender_id = auth.uid()
        and m.type = 'image'
    )
  );
