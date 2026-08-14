/**
 * Room lifecycle status, persisted in the database.
 * - `waiting`: created by the owner, not yet joined by the second participant.
 * - `active`: both participants present.
 * - `closed`: a participant permanently left the chat; content was destroyed
 *   and the room cannot be reopened (the shell lingers until the 24h purge so
 *   the remaining participant's dashboard can show it as ended).
 * - `expired`: past `expiresAt`; permanently inaccessible, all data deleted.
 */
export type RoomStatus = "waiting" | "active" | "expired" | "closed";

/**
 * The room state surfaced in the UI. `temporarily_offline` is derived from
 * realtime presence (a participant's browser closed or disconnected) and is
 * never persisted.
 */
export type RoomPresenceState =
  | "waiting"
  | "active"
  | "temporarily_offline"
  | "closed"
  | "expired";

/**
 * A temporary 1-to-1 chat room.
 *
 * `code` is a human-readable join code (e.g. `K7XM-4QTP-9NVR`) generated from
 * cryptographically secure randomness. It is never used as an encryption key.
 */
export interface Room {
  /** Internal room id (uuid). */
  id: string;
  /** Human-readable join code. */
  code: string;
  /** Account id of the participant who created the room. */
  ownerId: string;
  /** ISO-8601 creation time. */
  createdAt: string;
  /** ISO-8601 expiry time, exactly 24 hours after `createdAt`. */
  expiresAt: string;
  status: RoomStatus;
}

/** Lightweight room descriptor used in navigation / room lists. */
export interface RoomSummary {
  id: string;
  code: string;
  expiresAt: string;
  participantCount: number;
}
