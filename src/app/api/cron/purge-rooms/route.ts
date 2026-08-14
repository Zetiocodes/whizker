import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { purgeExpiredAttachmentBlobs } from "@/lib/storage/cleanup";

export const dynamic = "force-dynamic";

/**
 * Hourly cron job (see vercel.json) that hard-deletes expired rooms.
 *
 * Vercel cron jobs invoke the route with a GET request carrying
 * `Authorization: Bearer <CRON_SECRET>`; POST is supported too so the job can
 * be triggered manually (e.g. `curl -X POST ...`). Only the service role can
 * execute purge_expired_rooms (migration 005), so the admin client is required
 * here.
 *
 * Order matters (Part 6): the encrypted attachment blobs are removed FIRST,
 * while the expired rooms' paths can still be enumerated from the bucket, then
 * purge_expired_rooms deletes the room rows whose cascade removes the
 * attachment metadata + messages. Any orphaned blobs (interrupted uploads)
 * inside an expired room are swept up too.
 */
export async function POST(request: NextRequest) {
  return purge(request);
}

export async function GET(request: NextRequest) {
  return purge(request);
}

async function purge(request: NextRequest) {
  const secret = process.env.CRON_SECRET;

  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const blobsRemoved = await purgeExpiredAttachmentBlobs(admin);
    const { data, error } = await admin.rpc("purge_expired_rooms");

    if (error) {
      console.error("[purge] purge_expired_rooms failed:", error);
      return NextResponse.json({ error: "Purge failed", detail: error.message }, { status: 500 });
    }

    return NextResponse.json({ purged: data ?? 0, blobsRemoved });
  } catch (err) {
    console.error("[purge] purge failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Purge failed", detail }, { status: 500 });
  }
}
