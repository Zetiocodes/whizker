"use client";

/**
 * Supabase browser client for client components.
 *
 * Uses the anon key (safe for the browser). Auth state is persisted in
 * cookies via @supabase/ssr, so refresh navigation keeps the session.
 *
 * Environment handling: the NEXT_PUBLIC_* values MUST be read with STATIC
 * member access (`process.env.NEXT_PUBLIC_*`). Next.js/Turbopack only inlines
 * environment variables that appear as static property access in client
 * bundles; dynamic access such as `process.env[name]` is NOT replaced and is
 * therefore `undefined` in the browser. Reading them once at module scope also
 * makes any missing-variable failure fail fast at import time.
 */
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appConfig } from "@/config";
import type { Database } from "@/types/supabase";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function requireValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        "Copy .env.example to .env.local and fill in your Supabase project values.",
    );
  }
  return value;
}

export function createClient(): SupabaseClient<Database> {
  return createBrowserClient<Database>(
    requireValue(supabaseUrl, "NEXT_PUBLIC_SUPABASE_URL"),
    requireValue(supabaseAnonKey, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookieOptions: {
        name: appConfig.auth.sessionCookieName,
      },
      auth: {
        /**
         * The browser refreshes its own token so long-lived realtime
         * connections (presence, live messages) never go stale mid-session.
         * This writes 400-day cookies, but the proxy re-stamps every
         * `whisper-session*` cookie as a session cookie (no Max-Age) on the
         * next request, preserving "browser close = logout".
         */
        autoRefreshToken: true,
      },
    },
  );
}
