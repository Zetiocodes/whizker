"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { deriveRoomAvailability } from "@/lib/realtime/presence";
import { useRoomConnection } from "@/hooks/use-room-connection";
import { appConfig } from "@/config";
import { deleteRoomKeys } from "@/lib/crypto/key-store";
import { AppShell, type AppShellUser } from "@/components/app-shell";
import {
  RoomSidebar,
  type RoomSidebarParticipant,
} from "@/components/rooms/room-sidebar";
import { ChatPanel } from "@/components/rooms/chat-panel";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { MyRoomSummary } from "@/lib/rooms/summaries";
import type { RoomPresenceState } from "@/types/room";

export interface RoomShellProps {
  user: AppShellUser;
  room: { id: string; code: string; expiresAt: string; status: "waiting" | "active" | "expired" };
  participants: RoomSidebarParticipant[];
  /** Sidebar room list (same query as the dashboard). */
  rooms: MyRoomSummary[];
  /** True when the room is known to be expired (server-side admin check). */
  expired?: boolean;
}

/**
 * Full-page client wrapper for the room. Owns the single Supabase client and
 * the realtime presence channel (via `useRoomConnection`), derives room
 * availability from the pure connection/peer state machines, and lays the room
 * out in the global `AppShell` — a sidebar holding the room card and a
 * full-height chat panel.
 *
 * This is also the layer that guarantees a refresh does not destroy the room:
 * on reload the session, the room fetch, presence, the E2EE handshake (which
 * restores the DEK from IndexedDB / `wrapped_key`) and history are all rebuilt
 * against the SAME room id — nothing here creates a new room.
 */
export function RoomShell({ user, room, participants, rooms, expired = false }: RoomShellProps) {
  const client = useMemo(() => createClient(), []);

  // The server-rendered `participants` prop is a snapshot of the initial
  // render. The room creator's page renders before the second participant
  // exists, so their copy stays one participant short forever. Presence
  // (`onlineUserIds`) is live, so once it reports the room is full we
  // reconcile the participant list from the room itself — visible to
  // authenticated participants under RLS — which unblocks peer detection,
  // presence and the composer for the creator too.
  const [knownParticipants, setKnownParticipants] =
    useState<RoomSidebarParticipant[]>(participants);

  const peer =
    knownParticipants.length === 2
      ? (knownParticipants.find((p) => p.userId !== user.id) ?? null)
      : null;

  const { connection, peerPresence, onlineUserIds } = useRoomConnection({
    client,
    roomId: room.id,
    userId: user.id,
    peerUserId: peer?.userId ?? null,
    enabled: !expired,
  });

  // Reconcile the participant list once presence proves the room is full
  // (onlineUserIds.size is live; `participants` is the server snapshot).
  useEffect(() => {
    if (
      expired ||
      knownParticipants.length >= appConfig.room.maxParticipants ||
      onlineUserIds.size < appConfig.room.maxParticipants
    ) {
      return;
    }
    void (async () => {
      const { data } = await client
        .from("room_participants")
        .select("id, user_id, display_name")
        .eq("room_id", room.id)
        .order("joined_at", { ascending: true });
      if (data && data.length > knownParticipants.length) {
        setKnownParticipants(
          data.map((p) => ({ id: p.id, userId: p.user_id, displayName: p.display_name })),
        );
      }
    })();
  }, [client, expired, knownParticipants.length, onlineUserIds.size, room.id]);

  const availability = deriveRoomAvailability({
    connection,
    peer: peerPresence,
    expired,
  });

  // Room-scoped keys (ephemeral keypair + DEK) live exactly as long as the
  // room: once it expires they are wiped from this device. The long-lived
  // identity key is deliberately kept for future rooms.
  const keysCleaned = useRef(false);
  useEffect(() => {
    if (expired && !keysCleaned.current) {
      keysCleaned.current = true;
      void deleteRoomKeys(room.id);
    }
  }, [expired, room.id]);

  // Presence state is derived: `temporarily_offline` is never persisted.
  // `Math.max` tolerates a page rendered before the other participant joined:
  // live presence can report two users even when this page's participant list
  // only knows about one.
  const presenceState: RoomPresenceState = useMemo(() => {
    if (expired) {
      return "expired";
    }
    const knownCount = Math.max(knownParticipants.length, onlineUserIds.size);
    if (knownCount < appConfig.room.maxParticipants) {
      return "waiting";
    }
    if (onlineUserIds.size >= knownCount) {
      return "active";
    }
    return "temporarily_offline";
  }, [expired, knownParticipants.length, onlineUserIds]);

  return (
    <AppShell
      user={user}
      rooms={rooms}
      activeRoomCode={room.code}
      sidebarContent={
        <RoomSidebar
          room={{ code: room.code, expiresAt: room.expiresAt }}
          participants={knownParticipants}
          onlineUserIds={onlineUserIds}
          presenceState={presenceState}
          expired={expired}
          userId={user.id}
        />
      }
    >
      {expired ? (
        <ExpiredRoom room={room} />
      ) : (
        <ChatPanel
          client={client}
          roomId={room.id}
          userId={user.id}
          participants={knownParticipants.map((p) => ({
            userId: p.userId,
            displayName: p.displayName,
          }))}
          availability={availability}
          peerName={peer?.displayName ?? null}
          expiresAt={room.expiresAt}
        />
      )}
    </AppShell>
  );
}

function ExpiredRoom({ room }: { room: RoomShellProps["room"] }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
          <Icon name="clock" className="h-5 w-5" />
        </span>
        <h1 className="mt-4 text-lg font-semibold">This room has expired</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Rooms last 24 hours and are then permanently destroyed. The
          conversation and every key used to protect it are gone.
        </p>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-3 py-1.5 font-mono text-sm text-muted">
          {room.code}
        </div>
        <Link href="/dashboard">
          <Button className="mt-6 w-full">Back to rooms</Button>
        </Link>
      </div>
    </div>
  );
}
