-- 004_realtime.sql
-- Realtime publication for the chat tables.
--
-- Realtime respects Row Level Security: subscribers only receive rows that
-- their JWT is allowed to read. The participant-scoped policies arrive in
-- Part 3, so no client can currently subscribe to arbitrary data.
--
-- This file references the `supabase_realtime` publication that Supabase
-- provisions on every project.

alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.room_participants;
alter publication supabase_realtime add table public.messages;

-- RLS-filtered replication requires the roles to hold SELECT on the tables.
grant select on public.rooms, public.room_participants, public.messages to authenticated;
