import "server-only";

/**
 * Supabase client for server components, route handlers and server actions.
 *
 * Sessions are read from and written to the request cookies, so authenticated
 * requests work seamlessly across the server/client boundary.
 */
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appConfig } from "@/config";
import type { Database } from "@/types/supabase";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        "Copy .env.example to .env.local and fill in your Supabase project values.",
    );
  }
  return value;
}

export async function createClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    getEnv("NEXT_PUBLIC_SUPABASE_URL"),
    getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookieOptions: {
        name: appConfig.auth.sessionCookieName,
      },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components cannot set cookies; safe to ignore.
            // Mutations that need cookies must run in route handlers/actions.
          }
        },
      },
    },
  );
}
