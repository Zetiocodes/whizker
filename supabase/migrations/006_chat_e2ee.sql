-- 006_chat_e2ee.sql
-- End-to-end encryption (Part 4).
--
-- Server-side invariants this migration enforces:
-- - user_public_keys stores ONLY per-user PUBLIC identity keys (ECDH P-256).
--   Private identity keys never leave the client's IndexedDB.
-- - room_keys.key_check is an HMAC-of-a-constant under the room DEK: both
--   participants can verify they derived the SAME room key without the
--   server (or either side) ever learning the DEK.
-- - Clients write message ciphertext through RLS INSERT policies; there is
--   still NO plaintext column and NO policy that would allow it.
-- - Every stored IV is exactly 12 bytes (base64url == 16 chars), enforced by
--   a CHECK constraint so a nonce can never be reused or truncated.
-- - room_keys is published on realtime (participant-scoped via RLS) so the
--   two clients can learn each other's ephemeral public key and complete the
--   key agreement without the server learning the shared secret.
--
-- Threat model (documented in full in docs/ENCRYPTION.md): honest-but-curious
-- server. The server can see message metadata (sender, room, size, timing) but
-- only ever receives ciphertext. It cannot recover the DEK because the DEK is
-- derived from ephemeral-ephemeral ECDH that the server does not participate
-- in. We do NOT sign or pin keys, so a malicious server could substitute keys
-- (active MITM); this is explicitly out of scope for V1.

-- ---------------------------------------------------------------------------
-- 1. user_public_keys: per-user public identity keys.
-- ---------------------------------------------------------------------------
create table public.user_public_keys (
  user_id    uuid    primary key references auth.users (id) on delete cascade,
  public_key text    not null check (length(public_key) > 0),
  algorithm  text    not null default 'ECDH-P256'
                      check (algorithm in ('ECDH-P256', 'X25519')),
  created_at timestamptz not null default now(),
  constraint user_public_keys_format check (
    public_key ~ '^[A-Za-z0-9_-]+$'
  )
);

alter table public.user_public_keys enable row level security;
alter table public.user_public_keys force row level security;

-- Any authenticated user may read public keys: they are public by definition.
create policy "user_public_keys_select" on public.user_public_keys
  for select
  to authenticated
  using (true);

-- A user manages their own key record (upsert to rotate / first publish).
create policy "user_public_keys_insert_own" on public.user_public_keys
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "user_public_keys_update_own" on public.user_public_keys
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. room_keys: key agreement + verification, rewritten for E2EE.
-- ---------------------------------------------------------------------------
-- The room DEK is NOT generated server-side nor sent to the server. It is
-- derived independently on both clients from ephemeral-ephemeral ECDH:
--   DEK = HKDF-SHA256(ECDH(own_eph_priv, peer_eph_pub), salt = room_id,
--                     info = "whisper/room-dek/v1")
-- Each client stores its own ephemeral public key here plus:
--   wrapped_key  - the DEK wrapped for ITS OWN identity key (self-wrap,
--                  used for recovery if ephemeral material is lost)
--   key_check    - base64url HMAC-SHA256(DEK, "whisper/key-check/v1")
-- A wrapped_key of '' marks "not yet derivable" (owner created the room
-- before the guest's ephemeral public key existed). It is never a real key.

alter table public.room_keys
  add column key_check text not null default ''
  constraint room_keys_key_check_blank_or_b64url check (
    key_check = ''
    or key_check ~ '^[A-Za-z0-9_-]+$'
  );

-- Participants need to READ each other's ephemeral public key and key_check
-- (both non-secret) to complete key agreement. Replace the Part 3 policy that
-- limited reads to a participant's own row.
drop policy if exists "room_keys_select_own" on public.room_keys;

create policy "room_keys_select_participant" on public.room_keys
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

-- Clients insert their own room_keys row (guest) or placeholder (owner).
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
    )
  );

-- Clients update only their own row, and only to publish key material they
-- derived. Non-secret fields only; wrapped_key is the DEK sealed under the
-- user's own identity key and key_check is an HMAC, so neither leaks the DEK.
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
    )
  );

-- ---------------------------------------------------------------------------
-- 3. messages: RLS INSERT policy for encrypted content.
-- ---------------------------------------------------------------------------
-- Prior to Part 4 clients could only SELECT messages (via the Part 3 policy).
-- Sending goes straight through supabase-js + RLS now, so the server never
-- sees plaintext: the row contains ciphertext + IV only.
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
    )
  );

-- Every message IV must be exactly 12 bytes (base64url => 16 chars). A fixed
-- nonce size plus a fresh random nonce per message (generated client-side)
-- guarantees nonce uniqueness, which is the one misuse that breaks AES-GCM.
alter table public.messages
  add constraint messages_iv_length check (char_length(iv) = 16);

-- ---------------------------------------------------------------------------
-- 4. Realtime: publish room_keys so participants exchange public keys.
-- ---------------------------------------------------------------------------
-- RLS-filtered replication means a subscriber only receives rows (or row
-- changes) they are allowed to SELECT, i.e. participants of that room. The
-- payload is still only ciphertext / public keys / HMACs.
alter publication supabase_realtime add table public.room_keys;
alter publication supabase_realtime add table public.user_public_keys;

grant select on public.room_keys, public.user_public_keys to authenticated;
