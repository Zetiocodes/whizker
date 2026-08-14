import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import {
  deleteRoomAttachmentBlobs,
  purgeExpiredAttachmentBlobs,
  selectExpiredPaths,
} from "@/lib/storage/cleanup";

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
  rooms: { id: string; expires_at: string; status?: "active" | "closed" | "expired" }[],
  opts: { roomsError?: { message: string }; listError?: { message: string } } = {},
) {
  const removed: string[] = [];
  const admin = {
    storage: {
      from: () => ({
        list: async (prefix: string, opts2: { limit: number; offset: number }) => {
          if (opts.listError) {
            return { data: null, error: opts.listError };
          }
          const scoped = prefix
            ? files.filter((f) => f.name.startsWith(`${prefix}/`))
            : files;
          return { data: scoped.slice(opts2.offset, opts2.offset + opts2.limit), error: null };
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

function room(id: string, status: "active" | "closed" | "expired" = "active") {
  return {
    id,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    status,
  };
}

describe("purgeExpiredAttachmentBlobs", () => {
  it("removes blobs of expired rooms and keeps those of alive rooms", async () => {
    const { admin, removed } = fakeAdmin(
      [
        { name: `${ALIVE}/x.bin` },
        { name: `${EXPIRED}/y.bin` },
        { name: `${GONE}/z.bin` },
      ],
      [room(ALIVE), { ...room(EXPIRED), expires_at: new Date(Date.now() - 1_000).toISOString() }],
    );

    const count = await purgeExpiredAttachmentBlobs(admin);
    expect(count).toBe(2);
    expect(removed).toEqual([`${EXPIRED}/y.bin`, `${GONE}/z.bin`]);
  });

  it("removes blobs of closed rooms even when they have not expired (leave backstop)", async () => {
    const { admin, removed } = fakeAdmin(
      [
        { name: `${ALIVE}/x.bin` },
        { name: `${GONE}/z.bin` },
      ],
      [room(ALIVE), room(GONE, "closed")],
    );

    const count = await purgeExpiredAttachmentBlobs(admin);
    expect(count).toBe(1);
    expect(removed).toEqual([`${GONE}/z.bin`]);
  });

  it("ignores paths that are not attachment-shaped and removes nothing", async () => {
    const { admin, removed } = fakeAdmin(
      [{ name: "random.png" }, { name: "a/" }],
      [room(ALIVE)],
    );
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

describe("deleteRoomAttachmentBlobs", () => {
  it("removes every blob in the room folder and returns the count", async () => {
    const { admin, removed } = fakeAdmin(
      [
        { name: `${ALIVE}/a.bin` },
        { name: `${ALIVE}/b.bin` },
        { name: `${EXPIRED}/other.bin` },
      ],
      [],
    );

    const count = await deleteRoomAttachmentBlobs(admin, ALIVE);
    expect(count).toBe(2);
    expect(removed).toEqual([`${ALIVE}/a.bin`, `${ALIVE}/b.bin`]);
  });

  it("removes nothing when the folder is empty", async () => {
    const { admin, removed } = fakeAdmin([{ name: `${EXPIRED}/other.bin` }], []);
    expect(await deleteRoomAttachmentBlobs(admin, ALIVE)).toBe(0);
    expect(removed).toEqual([]);
  });

  it("paginates through more than one list page", async () => {
    const files = Array.from({ length: 1001 }, (_, i) => ({
      name: `${ALIVE}/${i}.bin`,
    }));
    const { admin, removed } = fakeAdmin(files, []);
    expect(await deleteRoomAttachmentBlobs(admin, ALIVE)).toBe(1001);
    expect(removed).toHaveLength(1001);
  });

  it("never throws: a failed enumeration or remove is best-effort", async () => {
    const { admin } = fakeAdmin([], [], { listError: { message: "boom" } });
    expect(await deleteRoomAttachmentBlobs(admin, ALIVE)).toBe(0);
  });
});
