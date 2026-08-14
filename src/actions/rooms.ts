"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateRoomCode, normalizeRoomCode } from "@/lib/rooms/code";

/** Shared state shape for the create/join room forms. */
export type RoomActionState = {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
};

/** Collision retries before giving up (room codes are 60-bit random). */
const CREATE_RETRY_LIMIT = 5;

function isUniqueViolation(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("duplicate") ||
    m.includes("rooms_code_unique") ||
    m.includes("23505")
  );
}

/** Best-effort cleanup of the expired room; the hourly cron is authoritative. */
async function purgeExpiredRoomsBestEffort(): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.rpc("purge_expired_rooms");
  } catch {
    // Ignore: cleanup must never block the user-facing flow.
  }
}

export async function createRoomAction(
  _prev: RoomActionState,
  _formData: FormData,
): Promise<RoomActionState> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: "Please sign in to create a room." };
  }

  const supabase = await createClient();

  for (let attempt = 0; attempt < CREATE_RETRY_LIMIT; attempt++) {
    const code = generateRoomCode();

    const { data, error } = await supabase.rpc("create_room", { p_code: code });

    if (error) {
      if (isUniqueViolation(error.message) && attempt < CREATE_RETRY_LIMIT - 1) {
        continue;
      }
      return { error: "Could not create the room. Please try again." };
    }

    if (!data) {
      return { error: "Could not create the room. Please try again." };
    }

    revalidatePath("/dashboard");
    redirect(`/c/${data.code}`);
  }

  return { error: "Could not create the room. Please try again." };
}

export async function joinRoomAction(
  _prev: RoomActionState,
  formData: FormData,
): Promise<RoomActionState> {
  const user = await getCurrentUser();
  if (!user) {
    return { error: "Please sign in to join a room." };
  }

  const raw = String(formData.get("code") ?? "");
  const code = normalizeRoomCode(raw);

  if (!code) {
    return { fieldErrors: { code: ["Enter a valid room code."] } };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("join_room", { p_code: code });

  if (error) {
    const message = error.message.toLowerCase();

    if (message.includes("room_expired")) {
      await purgeExpiredRoomsBestEffort();
      return { error: "This room has expired. Ask for a fresh code." };
    }
    if (message.includes("room_full")) {
      return { error: "This room already has two participants." };
    }
    if (message.includes("room_not_found") || message.includes("invalid_code")) {
      return { fieldErrors: { code: ["No room matches that code."] } };
    }
    if (message.includes("not_authenticated")) {
      return { error: "Please sign in to join a room." };
    }
    return {
      fieldErrors: {
        code: ["Could not join that room. Check the code and try again."],
      },
    };
  }

  if (!data) {
    return {
      fieldErrors: {
        code: ["Could not join that room. Check the code and try again."],
      },
    };
  }

  revalidatePath("/dashboard");
  redirect(`/c/${data.code}`);
}
