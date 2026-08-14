/**
 * Encryption scheme (V1) — the actual implementation, see
 * `src/lib/crypto/primitives.ts` and `docs/ENCRYPTION.md`.
 *
 * Only standard, established Web Crypto API primitives are used:
 * - AEAD: AES-256-GCM (authenticated encryption)
 * - KDF: HKDF-SHA256 (DEK + wrap-key derivation)
 * - Key agreement: ECDH over P-256
 * - MAC: HMAC-SHA256 (room-key agreement check)
 *
 * Room codes are NEVER used as keys, and no password exists in this app.
 * Message plaintext never leaves the browser: the server only ever stores or
 * transports the AEAD payload plus its non-secret IV/version.
 */

/** Envelope format version stamped on every message and key record. */
export const ENCRYPTION_VERSION = 1 as const;

/** AEAD cipher used for all payloads. */
export type AeadCipher = "AES-256-GCM";

/** KDF family used (never with a password; always with ECDH output). */
export type KdfAlgorithm = "HKDF-SHA256";

/** Supported key-agreement algorithms. */
export type KeyExchangeAlgorithm = "ECDH-P256" | "X25519";

/**
 * Non-secret metadata stored on every message row. Everything a recipient
 * needs to decrypt (IV + version) while revealing nothing about the plaintext.
 */
export interface EncryptionMetadata {
  /** Format version; must equal {@link ENCRYPTION_VERSION}. */
  version: typeof ENCRYPTION_VERSION;
  cipher: AeadCipher;
  /** base64url AES-GCM 96-bit nonce. */
  iv: string;
}

/**
 * Room key agreement (V1):
 *
 *   shared = ECDH(own_ephemeral_priv, peer_ephemeral_pub)
 *   DEK    = HKDF-SHA256(shared, salt = room_id, info = "whisper/room-dek/v1")
 *
 * Both participants derive the SAME DEK from each other's ephemeral public
 * key. The server never sees an ephemeral private key and so cannot recover
 * the DEK. Agreement is verified with key_check = HMAC-SHA256(DEK,
 * "whisper/key-check/v1") without revealing the DEK.
 */
export type RoomKeyAgreement = "ephemeral-ecdh-hkdf";
