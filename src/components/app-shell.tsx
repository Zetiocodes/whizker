"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { AccountMenu } from "@/components/account-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatDayLabel } from "@/lib/ui/format";
import type { MyRoomSummary } from "@/lib/rooms/summaries";

interface SidebarContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  open: false,
  setOpen: () => {},
});

/** Lets any descendant (e.g. the chat header) open the mobile drawer. */
export function useSidebar(): SidebarContextValue {
  return useContext(SidebarContext);
}

export interface AppShellUser {
  id: string;
  displayName: string;
  username: string;
}

interface AppShellProps {
  user: AppShellUser;
  rooms: MyRoomSummary[];
  /** Room code of the room currently being viewed, highlighted in the list. */
  activeRoomCode?: string;
  /** Room-specific content rendered in the sidebar footer (e.g. room card). */
  sidebarContent?: ReactNode;
  children: ReactNode;
}

/**
 * Global application shell: a collapsible navigation sidebar (fixed drawer on
 * mobile, static rail on desktop) plus the main content area. The main area
 * always starts below a slim mobile top bar so the chat pane is full-bleed on
 * small screens, and the whole layout uses `h-dvh` so mobile keyboard
 * resizing never clips the composer.
 */
export function AppShell({
  user,
  rooms,
  activeRoomCode,
  sidebarContent,
  children,
}: AppShellProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <SidebarContext.Provider value={{ open, setOpen }}>
      <div className="flex h-dvh overflow-hidden bg-background">
        <aside
          aria-label="Navigation"
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-border bg-surface transition-transform",
            "lg:static lg:z-auto lg:shrink-0 lg:translate-x-0",
            open ? "translate-x-0 shadow-overlay" : "-translate-x-full",
          )}
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <Brand size="sm" />
            <button
              type="button"
              onClick={close}
              aria-label="Close navigation"
              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-raised hover:text-foreground lg:hidden"
            >
              <Icon name="x" className="h-4 w-4" />
            </button>
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto p-3">
            <p className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Rooms
            </p>
            {rooms.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted">
                No rooms yet. Create one or join with a code.
              </p>
            ) : (
              rooms.map((room) => (
                <SidebarRoomItem
                  key={room.id}
                  room={room}
                  active={room.code === activeRoomCode}
                />
              ))
            )}
          </nav>

          {sidebarContent}

          <div className="border-t border-border p-3">
            <AccountMenu user={user} />
          </div>
        </aside>

        {open ? (
          <div
            className="fixed inset-0 z-30 bg-black/60 animate-fade-in lg:hidden"
            aria-hidden="true"
            onClick={close}
          />
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4 lg:hidden">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Open navigation"
              className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-raised hover:text-foreground"
            >
              <Icon name="menu" className="h-4 w-4" />
            </button>
            <Brand size="sm" />
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      </div>
    </SidebarContext.Provider>
  );
}

function SidebarRoomItem({
  room,
  active,
}: {
  room: MyRoomSummary;
  active: boolean;
}) {
  const expired = room.status === "expired";

  const inner = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          expired ? "bg-muted" : active ? "bg-accent" : "bg-success",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-sm text-foreground">
          {room.code}
        </span>
        <span className="block truncate text-xs text-muted">
          {expired
            ? "Expired"
            : `${formatDayLabel(room.expiresAt)} · ${room.status === "waiting" ? "waiting" : "active"}`}
        </span>
      </span>
    </>
  );

  const className = cn(
    "flex items-center gap-2.5 rounded-lg px-3 py-2 transition-colors",
    active
      ? "bg-accent/15 text-foreground"
      : "text-muted hover:bg-surface-raised hover:text-foreground",
    expired && "opacity-60",
  );

  if (expired) {
    return <div className={className}>{inner}</div>;
  }

  return (
    <Link
      href={`/c/${room.code}`}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {inner}
    </Link>
  );
}
