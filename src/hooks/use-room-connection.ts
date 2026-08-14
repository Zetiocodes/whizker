"use client";

import { useEffect, useReducer, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { appConfig } from "@/config";
import {
  INITIAL_CONNECTION_STATE,
  INITIAL_PEER_STATE,
  createConnectionReducer,
  createPeerReducer,
  type ConnectionStatus,
  type PeerPresence,
} from "@/lib/realtime/presence";

export interface RoomConnection {
  /** This device's realtime connection status. */
  connection: ConnectionStatus;
  /** The other participant's presence over the realtime channel. */
  peerPresence: PeerPresence;
  /** User ids currently tracked as present on the channel. */
  onlineUserIds: ReadonlySet<string>;
}

/**
 * Owns the realtime presence channel for a room: tracks this device, observes
 * the other participant, and feeds the pure connection/peer state machines in
 * `src/lib/realtime/presence.ts`.
 *
 * Disconnect handling is driven entirely by realtime (channel close/error and
 * the presence sync), never by `beforeunload`/`pagehide` — browsers do not
 * guarantee those fire, and the room must survive a closed tab untouched. A
 * dropped socket flips the connection to `reconnecting`; the peer that stops
 * being present flips through `away` → `offline` after the grace period. Both
 * recover automatically when the connection returns, and the room itself is
 * never destroyed by any of this.
 *
 * Presence entries auto-expire server-side when a connection drops, so a
 * closed browser clears this device's entry without any explicit "leave"
 * event. The periodic re-track keeps the entry (and the DB `last_seen_at`
 * heartbeat) alive while the tab is open.
 */
export function useRoomConnection(params: {
  client: SupabaseClient<Database>;
  roomId: string;
  userId: string;
  /** Other participant's user id; null while the room has only one member. */
  peerUserId: string | null;
  enabled: boolean;
}): RoomConnection {
  const { client, roomId, userId, peerUserId, enabled } = params;
  const graceMs = appConfig.realtime.offlineGraceMs;

  const [connection, dispatchConnection] = useReducer(
    createConnectionReducer(graceMs),
    INITIAL_CONNECTION_STATE,
  );
  const [peer, dispatchPeer] = useReducer(createPeerReducer(graceMs), INITIAL_PEER_STATE);
  const [onlineUserIds, setOnlineUserIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const channel = client
      .channel(`${appConfig.supabase.realtimePresenceChannelPrefix}${roomId}`, {
        config: { presence: { key: userId } },
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<{ user_id: string }>();
        const ids = new Set<string>();
        for (const entries of Object.values(state)) {
          for (const entry of entries) {
            ids.add(entry.user_id);
          }
        }
        setOnlineUserIds(ids);
        dispatchPeer({
          type: "sync",
          present: peerUserId !== null && ids.has(peerUserId),
          at: Date.now(),
        });
      })
      .on("system", {}, (payload: { extension?: string; status?: string }) => {
        if (payload.extension !== "system") {
          return;
        }
        const at = Date.now();
        if (payload.status === "ok") {
          dispatchConnection({ type: "subscribed", at });
        } else if (payload.status === "error") {
          dispatchConnection({ type: "socket-down", at });
        }
      })
      .subscribe((status) => {
        const at = Date.now();
        if (status === "SUBSCRIBED") {
          dispatchConnection({ type: "subscribed", at });
          void channel.track({ user_id: userId });
        } else {
          dispatchConnection({ type: "socket-down", at });
        }
      });

    const tick = window.setInterval(() => {
      const at = Date.now();
      dispatchConnection({ type: "grace-check", at });
      dispatchPeer({ type: "grace-check", at });
    }, 1_000);

    const retrack = window.setInterval(() => {
      void channel.track({ user_id: userId });
      void (async () => {
        try {
          await client.rpc("touch_presence", { p_room: roomId });
        } catch {
          // Heartbeat failures are non-fatal; the next tick retries.
        }
      })();
    }, appConfig.realtime.presenceRetrackMs);

    return () => {
      window.clearInterval(tick);
      window.clearInterval(retrack);
      void client.removeChannel(channel);
    };
  }, [client, enabled, graceMs, peerUserId, roomId, userId]);

  return { connection: connection.status, peerPresence: peer.presence, onlineUserIds };
}
