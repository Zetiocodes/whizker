import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeRoomCode } from "@/lib/rooms/code";
import { getMyRoomSummaries } from "@/lib/rooms/summaries";
import { InlineJoin } from "@/components/rooms/inline-join";
import { RoomShell } from "@/components/rooms/room-shell";

export const dynamic = "force-dynamic";

function hasExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() <= Date.now();
}

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const { code: rawCode } = await params;
  const code = normalizeRoomCode(rawCode);
  if (!code) {
    notFound();
  }

  const supabase = await createClient();

  // RLS guarantees this returns a room only when the caller is a participant
  // AND the room has not expired. A closed room's remaining participant still
  // sees it (their membership + the room row survive until the purge).
  const { data: room } = await supabase
    .from("rooms")
    .select("id, code, owner_id, created_at, expires_at, status")
    .eq("code", code)
    .maybeSingle();

  if (room) {
    const { data: participants } = await supabase
      .from("room_participants")
      .select("id, user_id, role, display_name, joined_at")
      .eq("room_id", room.id)
      .order("joined_at", { ascending: true });

    const rooms = await getMyRoomSummaries(supabase, user.id);

    return (
      <RoomShell
        user={{
          id: user.id,
          displayName: user.displayName,
          username: user.username,
        }}
        room={{
          id: room.id,
          code: room.code,
          expiresAt: room.expires_at,
          status: room.status,
        }}
        participants={(participants ?? []).map((p) => ({
          id: p.id,
          userId: p.user_id,
          displayName: p.display_name,
        }))}
        rooms={rooms}
        closed={room.status === "closed"}
      />
    );
  }

  // Not visible under RLS: the caller is not a participant, the room expired,
  // or it does not exist. Use the admin client to tell expired rooms apart
  // from genuinely unknown codes — without revealing anything about other
  // people's active rooms.
  const admin = createAdminClient();
  const { data: dbRoom } = await admin
    .from("rooms")
    .select("id, expires_at, status")
    .eq("code", code)
    .maybeSingle();

  if (!dbRoom) {
    notFound();
  }

  const isExpired = hasExpired(dbRoom.expires_at);

  if (!isExpired && dbRoom.status !== "closed") {
    return <InlineJoin code={code} />;
  }

  if (isExpired) {
    // Best-effort cleanup of the dead room; the hourly cron is authoritative.
    try {
      await admin.rpc("purge_expired_rooms");
    } catch {
      // Ignore: cleanup must never block the user-facing flow.
    }
  }

  // A closed room shows its ended screen to anyone who opens its code — the
  // leaver's membership is gone and its content is destroyed, so there is
  // nothing to reveal and nothing to join.
  const closed = dbRoom.status === "closed";

  return (
    <RoomShell
      user={{
        id: user.id,
        displayName: user.displayName,
        username: user.username,
      }}
      room={{
        id: dbRoom.id,
        code,
        expiresAt: dbRoom.expires_at,
        status: isExpired ? "expired" : "closed",
      }}
      participants={[]}
      rooms={closed ? await getMyRoomSummaries(supabase, user.id) : []}
      expired={isExpired}
      closed={closed}
    />
  );
}
