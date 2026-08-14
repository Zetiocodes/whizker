"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { appConfig } from "@/config";
import { TypingChannel } from "@/lib/realtime/typing-channel";
import type { TypingPresenceEntry } from "@/lib/realtime/typing-channel";
import { TypingTracker } from "@/lib/realtime/typing";

/**
 * Ephemeral typing indicators over a realtime presence channel
 * (`room-typing:<roomId>`).
 *
 * Nothing about typing is ever persisted: the payload is a transient presence
 * entry that auto-expires when a participant disconnects, which is exactly the
 * "auto-clear on disconnect" behavior the feature needs. The local side is a
 * debounced `TypingTracker`: it publishes "started typing" once per burst and
 * "stopped typing" after the idle timeout or on blur/unmount.
 *
 * The realtime subscription is asynchronous. This hook owns exactly ONE typing
 * channel per (roomId, userId) and routes every presence update through a
 * `TypingChannel` lifecycle guard, which only calls `track()` once the channel
 * is actually SUBSCRIBED. Keystrokes that land while the channel is joining or
 * reconnecting are deferred and flushed on (re)subscribe instead of throwing
 * "tried to push ... before joining".
 *
 * The viewer adds a safety timeout: a peer's entry older than the idle
 * timeout (plus leeway) is treated as not typing, so a stuck entry can never
 * leave the indicator on forever.
 */
export function useRoomTyping(params: {
  client: SupabaseClient<Database>;
  roomId: string;
  userId: string;
  /** Other participant's user id; null while the room has only one member. */
  peerUserId: string | null;
  enabled: boolean;
}): { peerTyping: boolean; notifyActivity: () => void; stopTyping: () => void } {
  const { client, roomId, userId, peerUserId, enabled } = params;

  const [peerTyping, setPeerTyping] = useState(false);
  const peerTypingRef = useRef(false);
  useEffect(() => {
    peerTypingRef.current = peerTyping;
  }, [peerTyping]);

  // Created lazily (on first use, from an event handler) so no impure call
  // happens during render; the tracker only calls the clock when asked.
  const trackerRef = useRef<TypingTracker | null>(null);
  const getTracker = useCallback(() => {
    if (trackerRef.current === null) {
      trackerRef.current = new TypingTracker({
        idleMs: appConfig.realtime.typingIdleMs,
        clock: Date.now,
      });
    }
    return trackerRef.current;
  }, []);

  // The single typing channel for this (roomId, userId). Created inside the
  // effect below and reached by event handlers through this ref, so
  // notifyActivity/stopTyping never spin up duplicate channels and never
  // track() before the channel is subscribed.
  const channelRef = useRef<TypingChannel | null>(null);

  const notifyActivity = useCallback(() => {
    if (getTracker().onActivity()) {
      channelRef.current?.publish(true);
    }
  }, [getTracker]);

  const stopTyping = useCallback(() => {
    if (getTracker().stop()) {
      channelRef.current?.publish(false);
    }
  }, [getTracker]);

  useEffect(() => {
    if (!enabled) {
      channelRef.current = null;
      return;
    }

    const raw = client.channel(
      `${appConfig.supabase.realtimeTypingChannelPrefix}${roomId}`,
      { config: { presence: { key: userId } } },
    );
    const typingChannel = new TypingChannel(raw, userId);
    channelRef.current = typingChannel;

    const readPeer = () => {
      const state = raw.presenceState<TypingPresenceEntry>();
      let entry: TypingPresenceEntry | null = null;
      for (const entries of Object.values(state)) {
        for (const candidate of entries) {
          if (peerUserId !== null && candidate.user_id === peerUserId) {
            entry = candidate;
          }
        }
      }
      const staleLimit = appConfig.realtime.typingIdleMs + appConfig.realtime.typingLeewayMs;
      const typing = entry?.typing === true && Date.now() - entry.at <= staleLimit;
      if (typing !== peerTypingRef.current) {
        peerTypingRef.current = typing;
        setPeerTyping(typing);
      }
    };

    raw.on("presence", { event: "sync" }, readPeer);

    // Prime the desired state before subscribing so an already-typing user is
    // published the moment the join completes (and on every rejoin).
    typingChannel.publish(getTracker().active);
    typingChannel.subscribe();

    const tick = window.setInterval(() => {
      readPeer();
      if (getTracker().tick()) {
        typingChannel.publish(false);
      }
    }, 1_000);

    return () => {
      window.clearInterval(tick);
      typingChannel.dispose();
      channelRef.current = null;
      void client.removeChannel(raw);
    };
  }, [client, enabled, getTracker, peerUserId, roomId, userId]);

  return { peerTyping, notifyActivity, stopTyping };
}
