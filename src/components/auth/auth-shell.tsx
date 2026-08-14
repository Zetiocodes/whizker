import type { ReactNode } from "react";
import { Brand } from "@/components/brand";
import { Icon } from "@/components/ui/icon";

interface AuthShellProps {
  title: string;
  subtitle: string;
  children: ReactNode;
}

/** Centered card layout shared by the login and signup pages. */
export function AuthShell({ title, subtitle, children }: AuthShellProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 py-12">
      <div className="mb-8 flex flex-col items-center gap-3">
        <Brand />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
          <Icon name="lock" className="h-3.5 w-3.5" />
          End-to-end encrypted
        </span>
        <div className="text-center">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
        </div>
      </div>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-card">
        {children}
      </div>
    </main>
  );
}
