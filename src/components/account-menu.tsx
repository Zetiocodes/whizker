"use client";

import { useEffect, useRef, useState } from "react";
import { logoutAction } from "@/actions/auth";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";

interface AccountMenuProps {
  user: { id: string; displayName: string; username: string };
}

/**
 * Account popover: shows the user's display name and username and a logout
 * action. Display names are the only identity shown to other participants,
 * and nothing here ever exposes the synthetic email or id.
 */
export function AccountMenu({ user }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const initial = user.displayName.trim().charAt(0).toUpperCase() || "?";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg p-2.5 text-left transition-colors",
          "hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          open && "bg-surface-raised",
        )}
      >
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-white"
        >
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {user.displayName}
          </span>
          <span className="block truncate text-xs text-muted">@{user.username}</span>
        </span>
        <Icon
          name="chevron-down"
          className={cn("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account actions"
          className="absolute bottom-full left-0 mb-2 w-56 rounded-xl border border-border bg-surface-raised p-1.5 shadow-popover animate-fade-in"
        >
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-sm font-medium text-foreground">
              {user.displayName}
            </p>
            <p className="truncate text-xs text-muted">@{user.username}</p>
          </div>
          <form
            action={logoutAction}
            onSubmit={() => setPending(true)}
            className="mt-1.5"
          >
            <button
              type="submit"
              role="menuitem"
              disabled={pending}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10 disabled:opacity-60"
            >
              {pending ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <Icon name="log-out" className="h-4 w-4" />
              )}
              Log out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
