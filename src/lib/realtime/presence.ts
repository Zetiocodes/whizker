/**
 * Pure state machines for realtime presence and room availability (Part 5).
 *
 * Everything here is a pure function of its inputs — no Supabase, no timers,
 * no global state — so the exact rules can be unit-tested in Node and reused
 * by `useRoomConnection` in the browser.
 *
 * Design notes:
 * - The connection state machine describes THIS device's link to the realtime
 *   socket. `connecting` → `connected` on a successful subscribe;
 *   `connected` → `reconnecting` the moment the socket drops (channel error or
 *   a system disconnect); `reconnecting` → `offline` only after the grace
 *   period passes without a successful resubscribe. Any successful subscribe
 *   returns to `connected`.
 * - The peer state machine describes the OTHER participant, driven by the
 *   presence channel. A peer that disappears is not immediately offline: it
 *   first enters `away` (grace period) so a short reconnect does not flap the
 *   room, then `offline` once the grace period expires. A peer that has never
 *   been seen stays `unknown`.
 * - `deriveRoomAvailability` turns both machines plus the expiry flag into the
 *   single availability value the chat UI acts on. When the chat is
 *   unavailable we never drop local state: messages, keys and the room all
 *   survive until the 24h expiry, and the UI recovers automatically when the
 *   connection or the peer returns.
 *
 * The grace period is deliberately short (see appConfig.realtime.offlineGraceMs)
 * so a closed browser becomes "waiting for X to reconnect" quickly without
 * relying on `beforeunload`/`pagehide`, which browsers do not guarantee.
 */

/** This device's realtime connection status. */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";

/** The other participant's presence as seen over the realtime channel. */
export type PeerPresence = "unknown" | "online" | "away" | "offline";

/**
 * Room availability as surfaced in the chat header. `peer-away` keeps the
 * chat usable during the peer's grace period; every other non-`available`
 * state gates the composer (the message is still stored ciphertext-only when
 * the connection returns).
 */
export type RoomAvailability =
  | "connecting"
  | "reconnecting"
  | "waiting-for-peer"
  | "peer-away"
  | "peer-offline"
  | "available"
  | "expired";

export interface ConnectionState {
  status: ConnectionStatus;
  /** Timestamp of the most recent transition that started the current state. */
  since: number;
}

export const INITIAL_CONNECTION_STATE: ConnectionState = {
  status: "connecting",
  since: 0,
};

export type ConnectionEvent =
  /** A subscribe (re)attempt started. */
  | { type: "subscribe"; at: number }
  /** The channel reported SUBSCRIBED. */
  | { type: "subscribed"; at: number }
  /** The channel reported an error / close / timeout, or the socket dropped. */
  | { type: "socket-down"; at: number }
  /** Periodic grace check fired. */
  | { type: "grace-check"; at: number };

/**
 * Build a reducer for the connection machine with a fixed grace period.
 * A `grace-check` only advances `reconnecting` → `offline` when the device has
 * been unable to resubscribe for `offlineGraceMs`. Events with a timestamp
 * before the state's `since` are ignored (stale events cannot rewind state).
 */
export function createConnectionReducer(offlineGraceMs: number) {
  return function connectionReducer(
    state: ConnectionState,
    event: ConnectionEvent,
  ): ConnectionState {
    if (event.at < state.since) {
      return state;
    }
    switch (event.type) {
      case "subscribe":
      case "subscribed":
        return state.status === "connected" ? state : { status: "connected", since: event.at };
      case "socket-down":
        return state.status === "connecting" || state.status === "connected"
          ? { status: "reconnecting", since: event.at }
          : state;
      case "grace-check":
        if (state.status === "reconnecting" && event.at - state.since >= offlineGraceMs) {
          return { status: "offline", since: event.at };
        }
        return state;
    }
  };
}

export interface PeerState {
  presence: PeerPresence;
  since: number;
  /** Last time the peer was present on the channel (null if never seen). */
  lastSeen: number | null;
}

export const INITIAL_PEER_STATE: PeerState = {
  presence: "unknown",
  since: 0,
  lastSeen: null,
};

export type PeerEvent =
  /** A presence sync reported whether the peer is present right now. */
  | { type: "sync"; present: boolean; at: number }
  /** Periodic grace check fired. */
  | { type: "grace-check"; at: number };

/**
 * Build a reducer for the peer-presence machine with a fixed grace period.
 * `sync present` → `online` (recording lastSeen); `sync absent` on a known
 * peer → `away` (grace); a grace-check then promotes `away` → `offline` once
 * the grace period has elapsed since the peer was last seen. An unknown peer
 * is never promoted to `away`/`offline` by absence alone.
 */
export function createPeerReducer(offlineGraceMs: number) {
  return function peerReducer(state: PeerState, event: PeerEvent): PeerState {
    switch (event.type) {
      case "sync":
        if (event.present) {
          return { presence: "online", since: event.at, lastSeen: event.at };
        }
        if (state.presence === "unknown") {
          return state;
        }
        return state.presence === "online"
          ? { presence: "away", since: event.at, lastSeen: state.lastSeen }
          : state;
      case "grace-check": {
        if (state.presence === "away" && event.at - state.since >= offlineGraceMs) {
          return { ...state, presence: "offline", since: event.at };
        }
        return state;
      }
    }
  };
}

export function deriveRoomAvailability(params: {
  connection: ConnectionStatus;
  peer: PeerPresence;
  expired: boolean;
}): RoomAvailability {
  if (params.expired) {
    return "expired";
  }
  switch (params.connection) {
    case "connecting":
      return "connecting";
    case "reconnecting":
    case "offline":
      return "reconnecting";
    case "connected":
      break;
  }
  switch (params.peer) {
    case "unknown":
      return "waiting-for-peer";
    case "away":
      return "peer-away";
    case "offline":
      return "peer-offline";
    case "online":
      return "available";
  }
}
