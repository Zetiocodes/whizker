import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { appConfig } from "@/config";

const PROTECTED_PATHS: RegExp[] = [
  /^\/dashboard(\/.*)?$/,
  /^\/c\/[A-Za-z0-9-]+$/,
];
const GUEST_ONLY_PATHS: RegExp[] = [/^\/login$/, /^\/signup$/];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        "Copy .env.example to .env.local and fill in your Supabase project values.",
    );
  }
  return value;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookieOptions: {
        name: appConfig.auth.sessionCookieName,
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Verifies the access token with the auth server and refreshes it when
  // expired, writing the refreshed session back to the response cookies.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  /*
   * Product session semantics (spec: "closing the browser must end the
   * active session", "reopening the website requires authentication again",
   * "refreshing the page must NOT destroy the active session").
   *
   * @supabase/ssr writes auth cookies with a ~400-day Max-Age by default.
   * Re-stamping them here as session cookies (no Max-Age) on every request
   * makes the session last exactly as long as the browser is open.
   *
   * The value is taken from the response cookies when the token was refreshed
   * above (fresh values), otherwise from the request cookies.
   */
  const cookiePrefix = appConfig.auth.sessionCookiePrefix;
  const names = new Set<string>([
    ...request.cookies.getAll().map((c) => c.name),
    ...response.cookies.getAll().map((c) => c.name),
  ]);

  for (const name of names) {
    if (!name.startsWith(cookiePrefix)) continue;
    const value =
      response.cookies.get(name)?.value ?? request.cookies.get(name)?.value;
    // Empty values mark a deletion (e.g. sign-out) — leave those untouched.
    if (!value) continue;
    response.cookies.set(name, value, {
      path: "/",
      sameSite: "lax",
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
    });
  }

  const isProtected = PROTECTED_PATHS.some((pattern) => pattern.test(pathname));
  const isGuestOnly = GUEST_ONLY_PATHS.some((pattern) =>
    pattern.test(pathname),
  );

  if (!user && isProtected) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (user && isGuestOnly) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
