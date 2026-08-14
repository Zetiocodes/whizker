"use client";

import { useActionState } from "react";
import Link from "next/link";
import { joinRoomAction, type RoomActionState } from "@/actions/rooms";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/** Shown when a visitor opens a room link for a room they have not joined. */
export function InlineJoin({ code }: { code: string }) {
  const [state, formAction, isPending] = useActionState<
    RoomActionState,
    FormData
  >(joinRoomAction, {});

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
        <div className="flex justify-center">
          <Brand size="sm" />
        </div>
        <h1 className="mt-5 text-lg font-semibold">Join this room?</h1>
        <p className="mt-1.5 text-sm text-muted">
          Someone shared this room code with you. Rooms are temporary,
          end-to-end encrypted, and gone within 24 hours.
        </p>
        <code className="mt-4 block rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-lg tracking-[0.15em] text-foreground">
          {code}
        </code>

        <form action={formAction} className="mt-5">
          <input type="hidden" name="code" value={code} />
          <Button type="submit" className="w-full" loading={isPending}>
            {isPending ? "Joining…" : "Join this room"}
          </Button>
        </form>

        {state.error ? (
          <p role="alert" className="mt-3 flex items-center justify-center gap-1.5 text-xs text-danger">
            <Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
            {state.error}
          </p>
        ) : null}

        <Link
          href="/dashboard"
          className="mt-4 inline-block text-sm text-muted hover:text-foreground"
        >
          Back to rooms
        </Link>
      </div>
    </main>
  );
}
