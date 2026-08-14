"use server";

import { redirect } from "next/navigation";
import { appConfig } from "@/config";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loginSchema, signupSchema } from "@/lib/auth/validation";

/** Shared state shape for the login/signup forms. */
export type AuthFormState = {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
};

function fieldErrorsFor(schemaErrors: {
  fieldErrors: Record<string, string[] | undefined>;
}): AuthFormState {
  return { fieldErrors: schemaErrors.fieldErrors };
}

function emailFor(username: string): string {
  return `${username}@${appConfig.auth.syntheticEmailDomain}`;
}

function mapSignupError(message: string): string {
  return isUsernameTaken(message)
    ? "That username is already taken."
    : "Signup failed. Please try again.";
}

/**
 * True when a Supabase Auth / database error message means the username is
 * already in use. Covers the client signUp obfuscated-user case, the admin
 * createUser cases ("Database error saving new user" from the profiles UNIQUE
 * trigger, and "already been registered" from the auth.users email key), and
 * direct mentions of duplicate/username_taken.
 */
function isUsernameTaken(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("username_taken") ||
    m.includes("already") ||
    m.includes("duplicate") ||
    m.includes("registered") ||
    m.includes("database error saving new user")
  );
}

/**
 * Development/operational diagnostics for signup failures. Logs only the
 * failing operation and Supabase's own error code/status/message — never
 * passwords, tokens, keys or user data. These values are printed by Supabase
 * itself and cannot contain credentials.
 */
function logSignupFailure(operation: string, error: { code?: string; message?: string; status?: number } | null) {
  console.error(`[auth] signup failed at "${operation}"`, {
    code: error?.code ?? null,
    status: error?.status ?? null,
    message: error?.message ?? null,
  });
}

export async function signupAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signupSchema.safeParse({
    username: formData.get("username"),
    displayName: formData.get("displayName"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return fieldErrorsFor(parsed.error.flatten());
  }

  const { username, password, displayName } = parsed.data;
  const email = emailFor(username);

  // Best-effort pre-check for a clean message. The UNIQUE index on
  // profiles.username is the authoritative protection against concurrent
  // duplicate signups (a race rolls back the auth user).
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();

  if (existing) {
    return { fieldErrors: { username: ["That username is already taken."] } };
  }

  /*
   * Account creation happens SERVER-SIDE with the admin client, not with the
   * browser client's signUp. Why: the synthetic address
   * `<username>@whisper.invalid` can never receive mail, and when the Supabase
   * project has "Confirm email" enabled (the default) the client signUp call
   * tries to deliver a confirmation email on every signup. Those sends get
   * rate-limited by GoTrue, so signup itself fails with HTTP 429
   * `over_email_send_rate_limit` before the action ever reaches its
   * server-side auto-confirm step. `admin.createUser({ email_confirm: true })`
   * never sends mail and works regardless of the project's "Confirm email"
   * setting. The profile row is created by the on_auth_user_created trigger,
   * and the UNIQUE index on profiles.username remains the race-safe duplicate
   * guard (a concurrent duplicate rolls back the whole auth user).
   *
   * The service-role key is used only here, server-side, and never exposed to
   * the browser.
   */
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, display_name: displayName },
  });

  if (createError || !created.user) {
    logSignupFailure("admin.createUser", createError);
    if (createError && isUsernameTaken(createError.message)) {
      return { fieldErrors: { username: ["That username is already taken."] } };
    }
    return { error: mapSignupError(createError?.message ?? "") };
  }

  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    logSignupFailure("signInWithPassword", signInError);
    return { error: "Account created, but sign-in failed. Please log in." };
  }

  redirect("/dashboard");
}

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = loginSchema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return fieldErrorsFor(parsed.error.flatten());
  }

  const { username, password } = parsed.data;
  const email = emailFor(username);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Deliberately generic: do not reveal whether the username exists.
    return { error: "Invalid username or password." };
  }

  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
