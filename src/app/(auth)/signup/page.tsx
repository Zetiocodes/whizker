"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signupAction, type AuthFormState } from "@/actions/auth";
import { appConfig } from "@/config";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PasswordField } from "@/components/ui/password-field";
import { Icon } from "@/components/ui/icon";

export default function SignupPage() {
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    signupAction,
    {},
  );

  return (
    <AuthShell
      title="Create an account"
      subtitle="Anonymous by default. Only your display name is ever visible to others."
    >
      <form action={formAction} className="space-y-4" noValidate>
        <Field
          name="username"
          label="Username"
          placeholder="your_username"
          autoComplete="username"
          autoFocus
          hint="Used to sign in. Lowercase letters, numbers and underscores."
          error={state.fieldErrors?.username?.[0]}
        />
        <Field
          name="displayName"
          label="Display name"
          placeholder="How others see you"
          autoComplete="nickname"
          hint="The only name the other participant sees."
          error={state.fieldErrors?.displayName?.[0]}
        />
        <PasswordField
          name="password"
          label="Password"
          placeholder="••••••••••"
          autoComplete="new-password"
          hint={`At least ${appConfig.limits.passwordMinLength} characters.`}
          error={state.fieldErrors?.password?.[0]}
        />
        <PasswordField
          name="confirmPassword"
          label="Confirm password"
          placeholder="••••••••••"
          autoComplete="new-password"
          error={state.fieldErrors?.confirmPassword?.[0]}
        />

        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs text-muted">
          <Icon name="info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            No email, no phone, no password recovery. If you lose your password,
            your account and its rooms cannot be recovered.
          </span>
        </div>

        {state.error ? (
          <p
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {state.error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" loading={isPending}>
          {isPending ? "Creating account…" : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
