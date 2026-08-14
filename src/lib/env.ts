/**
 * Central environment-variable handling.
 *
 * Naming convention:
 * - `NEXT_PUBLIC_*` values are safe to ship to the browser.
 * - Anything else (e.g. `SUPABASE_SERVICE_ROLE_KEY`) is server-only and must
 *   never be imported from client components.
 */

/** Throws unless the variable is set. Use for variables required at runtime. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  /** Public origin of the app. */
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
} as const;
