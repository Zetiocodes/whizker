-- 012_room_status_closed.sql
--
-- Adds the terminal 'closed' state to the room_status enum — and ONLY that.
--
-- WHY THIS MUST BE A STANDALONE MIGRATION:
--   PostgreSQL forbids *using* a newly added enum value in the same
--   transaction that adds it (SQLSTATE 55P04 "unsafe use of new value of enum
--   type"). Every consumer of 'closed' — the rooms_status_valid check
--   constraint, leave_room/join_room, the closed-room RLS policies and the
--   RPC guards — lives in 013, which Supabase applies only after this
--   migration has committed. Keeping the value addition in its own migration
--   is the required split; see the leave-chat notes in 013.
--
-- The value is appended at the end of the enum; existing values ('waiting',
-- 'active', 'expired') and their relative order are untouched, so every
-- previously stored row keeps its meaning.

alter type public.room_status add value if not exists 'closed';
