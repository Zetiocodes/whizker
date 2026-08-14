/**
 * Server-side cleanup of expired encrypted attachment blobs (Part 6).
 *
 * The DB cascade (purge_expired_rooms) deletes messages + attachment metadata
 * rows, but the storage objects themselves are not deleted by SQL — this
 * module removes them. It is invoked by the hourly cron BEFORE the room purge
 * (so the paths still exist to enumerate), and it is room-based rather than
 * row-based: any blob whose folder room is expired or gone is removed, which
 * also sweeps orphans from interrupted uploads. Service-role only.
 *
 * Never run from client code: this bypasses RLS by design and is what makes
 * "after the 24-hour lifetime, encrypted images are gone" true server-side.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { appConfig } from "@/config";
import { roomIdFromPath } from "@/lib/image/pipeline";

const LIST_PAGE_SIZE = 1000;
const REMOVE_BATCH_SIZE = 1000;

/**
 * Pure: given every blob's room folder and the set of still-alive room ids,
 * return the storage paths that are safe to delete (expired or missing room).
 */
export function selectExpiredPaths(
  pathsByRoom: ReadonlyMap<string, string[]>,
  aliveRoomIds: ReadonlySet<string>,
): string[] {
  const expired: string[] = [];
  for (const [roomId, paths] of pathsByRoom) {
    if (!aliveRoomIds.has(roomId)) {
      for (const path of paths) {
        expired.push(path);
      }
    }
  }
  return expired;
}

/**
 * Delete every object in the encrypted-attachments bucket whose room folder is
 * expired (or no longer exists). Returns how many objects were removed.
 */
export async function purgeExpiredAttachmentBlobs(
  admin: SupabaseClient<Database>,
): Promise<number> {
  const bucket = appConfig.supabase.storageBucket;

  // 1) Enumerate the bucket (paginated). A failed enumeration must abort the
  //    whole cleanup: we cannot know which blobs exist, so we must not report
  //    a successful purge.
  const names: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await admin.storage.from(bucket).list("", {
      limit: LIST_PAGE_SIZE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error || !data) {
      throw new Error(`cleanup: failed to list bucket "${bucket}": ${error?.message ?? "empty result"}`);
    }
    for (const file of data) {
      names.push(file.name);
    }
    if (data.length < LIST_PAGE_SIZE) {
      break;
    }
    offset += LIST_PAGE_SIZE;
  }

  // 2) Group paths by their room folder.
  const pathsByRoom = new Map<string, string[]>();
  for (const name of names) {
    const roomId = roomIdFromPath(name);
    if (roomId) {
      const list = pathsByRoom.get(roomId) ?? [];
      list.push(name);
      pathsByRoom.set(roomId, list);
    }
  }
  if (pathsByRoom.size === 0) {
    return 0;
  }

  // 3) Which rooms are still alive? A failed query must NEVER be interpreted
  //    as "every room is expired": that would mark every storage folder as
  //    expired and delete the encrypted blobs of LIVE rooms. Abort instead.
  const roomIds = [...pathsByRoom.keys()];
  const { data: rooms, error: roomsError } = await admin
    .from("rooms")
    .select("id, expires_at")
    .in("id", roomIds);
  if (roomsError) {
    throw new Error(`cleanup: failed to read rooms: ${roomsError.message}`);
  }
  const alive = new Set<string>();
  for (const room of rooms ?? []) {
    if (new Date(room.expires_at).getTime() > Date.now()) {
      alive.add(room.id);
    }
  }

  // 4) Remove expired blobs (in batches; paths were already room-scoped).
  const expired = selectExpiredPaths(pathsByRoom, alive);
  let removed = 0;
  for (let i = 0; i < expired.length; i += REMOVE_BATCH_SIZE) {
    const batch = expired.slice(i, i + REMOVE_BATCH_SIZE);
    const { error } = await admin.storage.from(bucket).remove(batch);
    if (!error) {
      removed += batch.length;
    }
  }
  return removed;
}
