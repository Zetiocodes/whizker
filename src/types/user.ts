/**
 * Application-level User (Account).
 *
 * These identities are deliberately distinct:
 * - `id`: permanent internal account id (uuid), never shown to peers.
 * - `username`: credential used for authentication, never shown to peers.
 * - `displayName`: the only peer-visible identity attribute.
 *
 * Usernames, display names, and passwords are NEVER used as encryption keys.
 */
export interface User {
  /** Permanent internal account id (uuid). */
  id: string;
  /** Auth credential, unique, lowercase. Never exposed to peers. */
  username: string;
  /** Peer-visible name. The only identity attribute another participant sees. */
  displayName: string;
  /** ISO-8601 timestamp of account creation. */
  createdAt: string;
}

/**
 * The minimal peer-visible projection of a user.
 * Deliberately contains nothing but an opaque id and a display name.
 */
export interface PublicUser {
  /** Opaque account id. Safe to share between the two room participants. */
  id: string;
  displayName: string;
}
