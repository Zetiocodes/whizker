"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatRelativeRemaining } from "@/lib/ui/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MyRoomSummary } from "@/lib/rooms/summaries";

/**
 * One dashboard room row with a live remaining-time label. Kept client-side so
 * the countdown reflects the actual clock without ever being rendered stale by
 * the server component (which cannot call `Date.now` during render).
 */
export function RoomListRow({ room }: { room: MyRoomSummary }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingMs = new Date(room.expiresAt).getTime() - now;
  const ended = room.status === "expired" || room.status === "closed" || remainingMs <= 0;
  const endedLabel = room.status === "closed" ? "Ended" : "Expired";

  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <span
        aria-hidden="true"
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          ended ? "bg-muted" : room.status === "waiting" ? "bg-warning" : "bg-success",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-sm text-foreground">{room.code}</p>
        <p className="text-xs text-muted">
          {ended ? endedLabel : formatRelativeRemaining(remainingMs)}
        </p>
      </div>
      {ended ? (
        <Badge tone="muted">{endedLabel}</Badge>
      ) : (
        <Link href={`/c/${room.code}`}>
          <Button variant="secondary" size="sm">
            Open
          </Button>
        </Link>
      )}
    </li>
  );
}
