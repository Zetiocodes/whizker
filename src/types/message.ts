import type { MessageEnvelope } from "@/lib/crypto/primitives";

export type MessageType = "text" | "image";

/** Delivery lifecycle of a message. `delivered`/`read` are device-level acks. */
export type MessageStatus = "sent" | "delivered" | "read";

/**
 * A stored message.
 *
 * The server persists ONLY the AEAD payload and its non-secret decryption
 * metadata: `ciphertext`, `iv`, `version`. There is no plaintext column and
 * the plaintext never leaves the browser. The server therefore cannot read
 * any message content.
 */
export interface Message {
  /** Message id (uuid). */
  id: string;
  roomId: string;
  /** Account id of the sender. */
  senderId: string;
  type: MessageType;
  /**
   * base64url AES-256-GCM sealed payload. Includes the authentication tag, so
   * tampering and wrong-key decryption attempts are detected and rejected.
   */
  ciphertext: string;
  /** base64url AES-GCM 96-bit nonce, unique per (key, message). */
  iv: string;
  /** Envelope format version (see src/types/encryption.ts). */
  version: number;
  status: MessageStatus;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

/** A message after successful local decryption, ready for rendering. */
export interface DecryptedMessage {
  id: string;
  senderId: string;
  createdAt: string;
  /** Decrypted plaintext content. */
  content: string;
}

export type { MessageEnvelope };
