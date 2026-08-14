"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import {
  ensureIdentityKeyPublished,
  synchronizeRoomKeys,
  type RoomCryptoState,
} from "@/lib/crypto/room-crypto";

/**
 * Slow poll used while waiting for the peer's ephemeral public key. Realtime
 * normally wakes the room instantly; the poll covers dropped subscriptions.
 */
const AWAITING_POLL_INTERVAL_MS = 15_000;

/**
 * Drives the client-side end-to-end encryption handshake for a room.
 *
 * Runs the room-key state machine (see room-crypto.ts) and re-runs it whenever
 * room_keys changes over realtime, so the moment the other participant's
 * ephemeral public key appears both sides converge on the same DEK.
 *
 * The identity key is ensured and published here too, so the server always
 * has the caller's public key before any message can be sent.
 */
export function useRoomCrypto(params: {
  client: SupabaseClient<Database>;
  roomId: string;
  userId: string;
  enabled: boolean;
}): { state: RoomCryptoState; refresh: () => Promise<void> } {
  const { client, roomId, userId, enabled } = params;

  const [state, setState] = useState<RoomCryptoState>({
    status: "awaiting-peer",
    dek: null,
    error: null,
  });

  const inFlight = useRef(false);
  const stateRef = useRef<RoomCryptoState | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refresh = useCallback(async () => {
    if (!enabled || inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      await ensureIdentityKeyPublished(client, userId);
      const next = await synchronizeRoomKeys(client, { roomId, userId });
      setState(next);
    } catch {
      setState((prev) =>
        prev.status === "ready"
          ? prev
          : {
              status: "error",
              dek: null,
              error: "Could not set up end-to-end encryption on this device.",
            },
      );
    } finally {
      inFlight.current = false;
    }
  }, [client, enabled, roomId, userId]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const channel = client
      .channel(`room-keys:${roomId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "room_keys", filter: `room_id=eq.${roomId}` },
        () => void refresh(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "room_keys", filter: `room_id=eq.${roomId}` },
        () => void refresh(),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void refresh();
        }
      });

    // Slow poll while waiting for the peer's key; realtime normally wakes the
    // room instantly, this covers dropped subscriptions.
    const poll = window.setInterval(() => {
      if (stateRef.current?.status === "awaiting-peer") {
        void refresh();
      }
    }, AWAITING_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(poll);
      void client.removeChannel(channel);
    };
  }, [client, enabled, refresh, roomId]);

  return { state, refresh };
}
