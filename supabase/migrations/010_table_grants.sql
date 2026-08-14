-- 010_table_grants.sql
--
-- Restores the missing TABLE-level GRANTs that back the existing RLS policies
-- for the authenticated application flow.
--
-- WHY THIS MIGRATION EXISTS:
--   On the hosted project, Supabase's default privileges (GRANT ALL on tables
--   in schema public to anon/authenticated/service_role) were not applied to
--   every table, so some tables carry no table-level grants at all. The
--   `authenticated` role could not SELECT from public.profiles, so after a
--   successful signup/login getCurrentUser() returned null while the proxy's
--   token check still saw a valid session — /dashboard redirected to /login,
--   /login redirected back to /dashboard, an infinite loop that Chrome
--   throttles ("Throttling navigation to prevent the browser from hanging").
--
--   Fixing the privilege at the database is the root-cause fix; the loop
--   disappears once the page and the proxy agree that the session is valid.
--
-- SCOPE / SAFETY:
--   - GRANTs are restricted to the `authenticated` role. No anon grants are
--     added, no service_role grants are added, and no DELETE privilege is ever
--     granted to clients (destructive operations remain RPC-only, see below).
--   - Row Level Security is untouched: every table keeps FORCE RLS and its
--     existing policies. These GRANTs only control table-level access; the
--     policies still filter every row, so a client can never read or mutate a
--     row its policies forbid.
--   - GRANT is idempotent, so this migration is safe to run on a project that
--     already has the privileges (e.g. via Supabase default privileges).

-- ---------------------------------------------------------------------------
-- 1. profiles: SELECT + UPDATE
-- ---------------------------------------------------------------------------
-- SELECT backs getCurrentUser() (src/lib/auth/session.ts) and the
-- profiles_select_own policy (migration 001). This is the grant whose absence
-- caused the redirect loop. UPDATE backs the profiles_update_own policy
-- (migration 001): an authenticated user may change their own display name.
-- No INSERT/DELETE: profiles are created only by the handle_new_user trigger
-- (security definer, runs as the table owner) and never deleted by clients.
grant select on public.profiles to authenticated;
grant update on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 2. messages: INSERT
-- ---------------------------------------------------------------------------
-- Backs the messages_insert_participant policy (migration 006): an
-- authenticated participant inserts only their own ciphertext message rows
-- (chat-panel.tsx). SELECT is already granted (migrations 003/004). UPDATE is
-- deliberately NOT granted — delivery/read receipts go exclusively through the
-- SECURITY DEFINER RPCs mark_messages_delivered / mark_messages_read
-- (migration 007), so clients can never advance a status directly.
grant insert on public.messages to authenticated;

-- ---------------------------------------------------------------------------
-- 3. room_keys: INSERT + UPDATE
-- ---------------------------------------------------------------------------
-- Backs the room_keys_insert_own / room_keys_update_own policies
-- (migration 006): the two participants publish their ephemeral public keys
-- and self-wrapped DEK material during E2EE key agreement (room-crypto.ts).
-- SELECT is already granted (migrations 002/006).
grant insert, update on public.room_keys to authenticated;

-- ---------------------------------------------------------------------------
-- 4. user_public_keys: INSERT + UPDATE
-- ---------------------------------------------------------------------------
-- Backs the user_public_keys_insert_own / user_public_keys_update_own policies
-- (migration 006): a user publishes and later rotates their own public
-- identity key (room-crypto.ts). SELECT is already granted (migration 006).
grant insert, update on public.user_public_keys to authenticated;
