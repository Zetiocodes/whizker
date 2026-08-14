import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { purgeExpiredAttachmentBlobs, selectExpiredPaths } from "@/lib/storage/cleanup";

const ALIVE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EXPIRED = "11111111-2222-4333-8444-555555555555";
const GONE = "22222222-3333-4444-8555-666666666666";

describe("selectExpiredPaths", () => {
  it("selects every path whose room is not in the alive set", () => {
    const pathsByRoom = new Map([
      [ALIVE, ["a/1.bin"]],
      [EXPIRED, ["b/1.bin", "b/2.bin"]],
      [GONE, ["c/1.bin"]],
    ]);
    const expired = selectExpiredPaths(pathsByRoom, new Set([ALIVE]));
    expect(expired).toEqual(["b/1.bin", "b/2.bin", "c/1.bin"]);
  });

  it("selects nothing when every room is alive", () => {
    const pathsByRoom = new Map([[ALIVE, ["a/1.bin"]]]);
    expect(selectExpiredPaths(pathsByRoom, new Set([ALIVE]))).toEqual([]);
  });

  it("handles an empty bucket", () => {
    expect(selectExpiredPaths(new Map(), new Set())).toEqual([]);
  });
});

function fakeAdmin(
  files: { name: string }[],
  rooms: { id: string; expires_at: string }[],
  opts: { roomsError?: { message: string }; listError?: { message: string } } = {},
) {
  const removed: string[] = [];
  const admin = {
    storage: {
      from: () => ({
        list: async (_prefix: string, opts2: { limit: number; offset: number }) => {
          if (opts.listError) {
            return { data: null, error: opts.listError };
          }
          return { data: files.slice(opts2.offset, opts2.offset + opts2.limit), error: null };
        },
        remove: async (paths: string[]) => {
          removed.push(...paths);
          return { error: null };
        },
      }),
    },
    from: () => ({
      select: () => ({
        in: async () => {
          if (opts.roomsError) {
            return { data: null, error: opts.roomsError };
          }
          return { data: rooms, error: null };
        },
      }),
    }),
  };
  return { admin: admin as unknown as SupabaseClient<Database>, removed };
}

describe("purgeExpiredAttachmentBlobs", () => {
  it("removes blobs of expired rooms and keeps those of alive rooms", async () => {
    const { admin, removed } = fakeAdmin(
      [
        { name: `${ALIVE}/x.bin` },
        { name: `${EXPIRED}/y.bin` },
        { name: `${GONE}/z.bin` },
      ],
      [
        { id: ALIVE, expires_at: new Date(Date.now() + 86_400_000).toISOString() },
        { id: EXPIRED, expires_at: new Date(Date.now() - 1_000).toISOString() },
      ],
    );

    const count = await purgeExpiredAttachmentBlobs(admin);
    expect(count).toBe(2);
    expect(removed).toEqual([`${EXPIRED}/y.bin`, `${GONE}/z.bin`]);
  });

  it("ignores paths that are not attachment-shaped and removes nothing", async () => {
    const { admin, removed } = fakeAdmin([{ name: "random.png" }, { name: "a/" }], [
      { id: ALIVE, expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    ]);
    expect(await purgeExpiredAttachmentBlobs(admin)).toBe(0);
    expect(removed).toEqual([]);
  });

  it("aborts and removes nothing when the rooms query fails", async () => {
    const { admin, removed } = fakeAdmin(
      [
        { name: `${ALIVE}/x.bin` },
        { name: `${EXPIRED}/y.bin` },
      ],
      [],
      { roomsError: { message: "permission denied for table rooms" } },
    );
    await expect(purgeExpiredAttachmentBlobs(admin)).rejects.toThrow(
      "permission denied for table rooms",
    );
    expect(removed).toEqual([]);
  });

  it("aborts and removes nothing when the bucket enumeration fails", async () => {
    const { admin, removed } = fakeAdmin([], [], {
      listError: { message: "storage list failed" },
    });
    await expect(purgeExpiredAttachmentBlobs(admin)).rejects.toThrow(
      "storage list failed",
    );
    expect(removed).toEqual([]);
  });
});
