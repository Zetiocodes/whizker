import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * The application-level authenticated account, as read from the database.
 * Username is included here because it is the user's own credential — it is
 * never exposed to other participants.
 */
export interface CurrentUser {
  /** Permanent internal account id (uuid). */
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}

/**
 * Returns the authenticated user (validated against Supabase) or null.
 *
 * Uses `getUser()` rather than `getSession()`: the session cookie is not
 * trusted until the access token is verified with the auth server.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, username, display_name, created_at")
    .eq("id", user.id)
    .single();

  if (!profile) {
    return null;
  }

  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name,
    createdAt: profile.created_at,
  };
}
