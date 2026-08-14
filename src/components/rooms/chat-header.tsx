"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatRemainingShort } from "@/lib/ui/format";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { useSidebar } from "@/components/app-shell";
import { LeaveChatButton } from "@/components/rooms/leave-chat-button";
import type { AvailabilityView } from "@/lib/realtime/status";

interface ChatHeaderProps {
  /** The other participant's display name, or null while the room is not full. */
  peerName: string | null;
  avail: AvailabilityView;
  /** True when the room DEK is ready (E2EE established). */
  encrypted: boolean;
  /** Room expiry timestamp (ISO), shown as a shrinking countdown. */
  expiresAt: string;
  /** Room id for the destructive "Leave chat" action. */
  roomId: string;
}

/**
 * Room header: the other participant's display name only (never their
 * username/email), a live availability line, the room expiry countdown, the
 * end-to-end encryption indicator and the destructive "Leave chat" action. On
 * mobile it also hosts the sidebar toggle so the drawer stays reachable from
 * within the conversation.
 */
export function ChatHeader({ peerName, avail, encrypted, expiresAt, roomId }: ChatHeaderProps) {
  const { setOpen } = useSidebar();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingMs = new Date(expiresAt).getTime() - now;

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-3 lg:px-5">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-raised hover:text-foreground lg:hidden"
      >
        <Icon name="menu" className="h-4 w-4" />
      </button>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold">
          {peerName ?? "Waiting for the other person"}
        </h1>
        <p className="flex items-center gap-1.5 truncate text-xs">
          <span
            aria-hidden="true"
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              avail.tone === "success"
                ? "bg-success"
                : avail.tone === "danger"
                  ? "bg-danger"
                  : avail.tone === "warning"
                    ? "bg-warning"
                    : "bg-muted",
            )}
          />
          <span
            className={cn(
              avail.tone === "success"
                ? "text-success"
                : avail.tone === "danger"
                  ? "text-danger"
                  : avail.tone === "warning"
                    ? "text-warning"
                    : "text-muted",
            )}
          >
            {avail.label}
          </span>
        </p>
      </div>

      {remainingMs > 0 && (
        <Badge tone="warning" icon={<Icon name="clock" className="h-3 w-3" />}>
          {formatRemainingShort(remainingMs)}
        </Badge>
      )}

      <Badge
        tone={encrypted ? "success" : "muted"}
        icon={<Icon name="lock" className="h-3 w-3" />}
        className="hidden sm:inline-flex"
      >
        {encrypted ? "End-to-end encrypted" : "Setting up encryption"}
      </Badge>

      <LeaveChatButton roomId={roomId} />
    </header>
  );
}
