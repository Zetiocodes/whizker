"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginAction, type AuthFormState } from "@/actions/auth";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PasswordField } from "@/components/ui/password-field";

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    loginAction,
    {},
  );

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to continue to your rooms."
    >
      <form action={formAction} className="space-y-4" noValidate>
        <Field
          name="username"
          label="Username"
          placeholder="your_username"
          autoComplete="username"
          autoFocus
          error={state.fieldErrors?.username?.[0]}
        />
        <PasswordField
          name="password"
          label="Password"
          placeholder="••••••••••"
          autoComplete="current-password"
          error={state.fieldErrors?.password?.[0]}
        />

        {state.error ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {state.error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" loading={isPending}>
          {isPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        New here?{" "}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
