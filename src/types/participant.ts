/** A room is created by an owner and joined by exactly one guest. */
export type ParticipantRole = "owner" | "guest";

/**
 * A participant of a room. `displayName` is a denormalized snapshot captured
 * at join time so that later account changes never affect an active room.
 */
export interface Participant {
  /** Participant record id (uuid). */
  id: string;
  roomId: string;
  /** Account id of the user. */
  userId: string;
  role: ParticipantRole;
  /** Peer-visible name as of the moment they joined. */
  displayName: string;
  /** ISO-8601 join time. */
  joinedAt: string;
  /** ISO-8601 last presence heartbeat, null when never observed online. */
  lastSeenAt: string | null;
}

/**
 * Online/offline presence derived from realtime presence + heartbeat state.
 * `isOnline` is derived, not stored in the database.
 */
export interface ParticipantPresence {
  roomId: string;
  userId: string;
  isOnline: boolean;
  lastSeenAt: string | null;
}
