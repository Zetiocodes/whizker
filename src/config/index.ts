/**
 * Central application configuration.
 *
 * Single source of truth for room lifetime, room-code generation, size limits
 * and V1 feature flags. Sensitive values (secrets) belong in environment
 * variables, never here.
 */

const HOUR_MS = 60 * 60 * 1000;
const MB = 1024 * 1024;

/**
 * Alphabet used for room codes. Deliberately excludes ambiguous characters
 * (I/O, and the digits 0/1) while keeping exactly 32 symbols so each code
 * character carries exactly 5 bits of entropy.
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const appConfig = {
  /** Working title. Branding is a placeholder to be finalized later. */
  name: "Whisper",
  description:
    "Temporary anonymous 1-to-1 end-to-end encrypted chat. Rooms last 24 hours and are gone forever.",

  /** Public origin of the app (falls back to localhost for local dev). */
  url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",

  room: {
    /** Hard maximum of participants per room (1-to-1 only in V1). */
    maxParticipants: 2,
    /** A room is permanently destroyed 24 hours after creation. */
    lifetimeMs: 24 * HOUR_MS,
    code: {
      alphabet: ROOM_CODE_ALPHABET,
      /** Format: XXXX-XXXX-XXXX. */
      groups: 3,
      groupSize: 4,
      separator: "-",
      /**
       * Total entropy = groupCount * groupSize * log2(alphabet.length).
       * With a 32-symbol alphabet and 12 characters this is 60 bits of
       * cryptographically secure randomness — practically impossible to
       * brute-force.
       */
      entropyBits: 3 * 4 * 5,
    },
  },

  retention: {
    /** Mirrors `room.lifetimeMs`; messages never outlive their room. */
    messageRetentionMs: 24 * HOUR_MS,
  },

  limits: {
    usernameMinLength: 3,
    usernameMaxLength: 20,
    /** Lowercase letters, digits and underscores only. */
    usernamePattern: /^[a-z0-9_]+$/,
    displayNameMinLength: 1,
    displayNameMaxLength: 32,
    passwordMinLength: 10,
    passwordMaxLength: 128,
    messageMaxLength: 2000,
  },

  /**
   * Image sharing (Part 6). Single source of truth for every image limit so a
   * check can never be scattered or drift out of sync.
   */
  image: {
    /** Hard V1 limit on the PLAINTEXT image size. Conservative for a realtime
     * anonymous chat; oversized files are rejected before any encryption or
     * upload work. The stored ciphertext is ~16 bytes larger. */
    maxBytes: 8 * MB,
    /** Formats accepted through the image path (validated by magic bytes, not
     * by the browser-provided MIME type). */
    allowedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
    /** The `accept` value for the file picker. */
    accept: "image/jpeg,image/png,image/gif,image/webp",
    /**
     * Metadata handling: EXIF/GPS-bearing containers are stripped in the
     * browser BEFORE encryption. GIF is passed through byte-for-byte (it has
     * no standard EXIF/GPS container). See docs/ENCRYPTION.md.
     */
    metadataStripping: {
      jpeg: "drops APP1 (EXIF + XMP) segments; keeps APP2 (ICC) for color fidelity",
      png: "drops tEXt / iTXt / zTXt / tIME / eXIf chunks",
      webp: "drops EXIF / ICCP chunks and re-stamps the RIFF size",
      gif: "none (no standard EXIF/GPS container)",
    },
  },

  auth: {
    /**
     * Supabase's auth provider requires an email/phone identifier. Because
     * this app has no email, a deterministic synthetic identifier is derived
     * from the normalized username: `<username>@whisper.invalid`.
     *
     * `.invalid` is a reserved TLD that can never be a real address, and the
     * email is stored in `auth.users` where it is unreachable by RLS. It is
     * never shown in the UI.
     */
    syntheticEmailDomain: "whisper.invalid",
    /** Shared by @supabase/ssr browser + server clients. */
    sessionCookieName: "whisper-session",
    /**
     * Session cookies must not outlive the browser tab lifetime: refreshing
     * keeps the session, closing the browser ends it. Supabase's ssr helpers
     * write long-lived cookies by default, so middleware re-stamps every
     * cookie with this prefix as a session cookie on each request.
     */
    sessionCookiePrefix: "whisper-session",
  },

  crypto: {
    aeadCipher: "AES-256-GCM",
    keyLengthBits: 256,
    ivBytes: 12,
    /** Room DEK and wrap-key derivation (see docs/ENCRYPTION.md). */
    kdf: {
      algorithm: "HKDF-SHA256",
      // `info` labels used for domain separation.
      roomDekInfo: "whisper/room-dek/v1",
      wrapInfo: "whisper/wrap/v1",
      keyCheckInfo: "whisper/key-check/v1",
    },
    keyExchange: "ECDH-P256",
  },

  supabase: {
    /** Public Supabase origin. Used to build storage upload URLs. */
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    /** Storage bucket that holds encrypted attachment blobs. */
    storageBucket: "encrypted-attachments",
    /** Real-time presence channel (online/offline, room availability). */
    realtimePresenceChannelPrefix: "room-presence:",
    /** Real-time presence channel for ephemeral typing indicators. */
    realtimeTypingChannelPrefix: "room-typing:",
  },

  realtime: {
    /**
     * How long a participant may be unobserved (lost socket / browser closed)
     * before they are considered offline. Shorter than this the peer is in a
     * grace period ("temporarily away") and the chat stays available so a
     * brief reconnect does not flap the UI.
     */
    offlineGraceMs: 8_000,
    /** A peer keeps seeing "typing…" for this long after the last keystroke. */
    typingIdleMs: 4_000,
    /** Extra leeway before declaring a peer's typing indicator stale. */
    typingLeewayMs: 2_000,
    /** Debounce before a batch of "delivered" receipts hits the database. */
    deliveredBatchMs: 300,
    /** Debounce before a batch of "read" receipts hits the database. */
    readBatchMs: 1_200,
    /** How often presence is re-tracked to keep it alive on the channel. */
    presenceRetrackMs: 20_000,
  },

  featureFlags: {
    authEnabled: true,
    chatEnabled: true,
    imageSharingEnabled: true,
  },
} as const;
