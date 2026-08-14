import "server-only";

/**
 * Supabase admin client with the service-role key.
 *
 * Bypasses Row-Level Security. Use ONLY for operations that must run with
 * elevated privileges on the server:
 * - hard-deleting rooms/messages/attachments on expiration (24-hour purge)
 * - server-enforced authorization checks that must not trust the client
 *
 * NEVER import this module from client code, and never expose the service
 * role key to the browser.
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function createAdminClient(): SupabaseClient<Database> {
  return createSupabaseClient<Database>(
    getEnv("NEXT_PUBLIC_SUPABASE_URL"),
    getEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
