import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import type { RoomStatus } from "@/types/room";

export interface MyRoomSummary {
  id: string;
  code: string;
  expiresAt: string;
  status: RoomStatus;
}

/**
 * The signed-in user's rooms, most recently joined first. Used by the
 * dashboard and the global sidebar so both show the same list. RLS guarantees
 * only rooms the caller participates in are returned.
 */
export async function getMyRoomSummaries(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<MyRoomSummary[]> {
  const { data } = await client
    .from("room_participants")
    .select("room_id, role, rooms(id, code, created_at, expires_at, status)")
    .eq("user_id", userId)
    .order("joined_at", { ascending: false });

  return (data ?? [])
    .map((membership) => membership.rooms)
    .filter((room): room is NonNullable<typeof room> => room !== null)
    .map((room) => ({
      id: room.id,
      code: room.code,
      expiresAt: room.expires_at,
      status: room.status,
    }));
}
