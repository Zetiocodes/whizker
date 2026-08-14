-- 999_test_helpers.sql
--
-- TEST-ONLY. DO NOT apply this migration to production.
--
-- The E2E expiration suite (e2e/expiration.spec.ts) needs a way to force a
-- room into the past without waiting 24h. The production app deliberately has
-- NO such path: rooms.expires_at is immutable for every role via the
-- rooms_protect_lifetime trigger, and RLS blocks clients from touching rooms
-- rows at all. This fixture exists only so a disposable Supabase test project
-- can simulate an expired room.
--
-- It is a SECURITY DEFINER function granted to service_role alone — an
-- authenticated app client can never invoke it, and it is never called by the
-- application. Keep it out of any production project.

create or replace function public.force_expire_room_for_test(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room uuid;
begin
  select id into v_room from public.rooms where code = p_code;
  if v_room is null then
    raise exception 'room_not_found';
  end if;

  -- The lifetime trigger blocks this update for every role (by design). For
  -- the test fixture alone, suspend it for the single statement.
  alter table public.rooms disable trigger rooms_protect_lifetime;
  update public.rooms
    set expires_at = now() - interval '1 minute'
    where id = v_room;
  alter table public.rooms enable trigger rooms_protect_lifetime;
end;
$$;

revoke execute on function public.force_expire_room_for_test(text) from public;
grant execute on function public.force_expire_room_for_test(text) to service_role;
