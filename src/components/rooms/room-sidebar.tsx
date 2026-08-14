"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatCountdown, formatRelativeRemaining } from "@/lib/ui/format";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import type { RoomPresenceState } from "@/types/room";

export interface RoomSidebarParticipant {
  id: string;
  userId: string;
  displayName: string;
}

interface RoomSidebarProps {
  room: { code: string; expiresAt: string };
  participants: RoomSidebarParticipant[];
  /** User ids currently online (realtime presence, owned by RoomShell). */
  onlineUserIds: ReadonlySet<string>;
  /** Derived room state (waiting / active / temporarily_offline / closed / expired). */
  presenceState: RoomPresenceState;
  /** True when the room is past its expiry. */
  expired: boolean;
  /** True when a participant permanently left the chat. */
  closed?: boolean;
  /** The current user's id, to mark "you" in the participant list. */
  userId: string;
}

const PRESENCE_LABEL: Record<RoomPresenceState, string> = {
  waiting: "Waiting for the other person",
  active: "Both online",
  temporarily_offline: "Temporarily offline",
  closed: "Chat ended",
  expired: "Expired",
};

const PRESENCE_TONE: Record<RoomPresenceState, string> = {
  waiting: "text-warning",
  active: "text-success",
  temporarily_offline: "text-muted",
  closed: "text-danger",
  expired: "text-danger",
};

/**
 * Room card rendered in the sidebar: the join code with copy action, the live
 * countdown to the 24-hour expiry, participants with online dots, and a
 * reminder of what is private. Everything here is derived from the same pure
 * state machines RoomShell already computes.
 */
export function RoomSidebar({
  room,
  participants,
  onlineUserIds,
  presenceState,
  expired,
  closed = false,
  userId,
}: RoomSidebarProps) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const ended = expired || closed;

  useEffect(() => {
    if (ended) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ended]);

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(room.code);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = room.code;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [room.code]);

  const remainingMs = new Date(room.expiresAt).getTime() - now;

  return (
    <div className="border-t border-border p-4">
      <div className="rounded-xl border border-border bg-background p-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted">
          {ended ? "Room code" : "Share this code"}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface px-2.5 py-2 text-center font-mono text-sm tracking-[0.15em] text-foreground">
            {room.code}
          </code>
          {!ended && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void copyCode()}
              className="shrink-0"
            >
              {copied ? (
                <>
                  <Icon name="check" className="h-3.5 w-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Icon name="copy" className="h-3.5 w-3.5" />
                  Copy
                </>
              )}
            </Button>
          )}
        </div>

        {!ended && (
          <div className="mt-3 flex items-center justify-between rounded-lg bg-surface px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Icon name="clock" className="h-3.5 w-3.5" />
              Expires in
            </span>
            <span className="font-mono text-sm tabular-nums text-foreground">
              {formatCountdown(remainingMs)}
            </span>
          </div>
        )}

        <div className="mt-3 space-y-2">
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Icon name="users" className="h-3.5 w-3.5" />
            <span className={cn("font-medium", PRESENCE_TONE[presenceState])}>
              {PRESENCE_LABEL[presenceState]}
            </span>
          </p>
          <ul className="space-y-1.5">
            {participants.length === 0 && ended ? (
              <li className="text-xs text-muted">No participants.</li>
            ) : (
              participants.map((participant) => {
                const online = onlineUserIds.has(participant.userId);
                const isYou = participant.userId === userId;
                return (
                  <li
                    key={participant.id}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        online ? "bg-success" : "bg-muted",
                      )}
                    />
                    <span className="truncate text-foreground">
                      {participant.displayName}
                      {isYou ? (
                        <span className="ml-1 text-muted">(you)</span>
                      ) : null}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        </div>

        <p className="mt-3 flex items-start gap-1.5 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted">
          <Icon name="lock" className="mt-0.5 h-3 w-3 shrink-0" />
          {expired ? (
            "This room has expired and is being destroyed."
          ) : closed ? (
            "This chat has ended. Its messages and keys are being destroyed."
          ) : (
            <>
              End-to-end encrypted. This room and its messages are deleted in{" "}
              {formatRelativeRemaining(remainingMs)}.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
