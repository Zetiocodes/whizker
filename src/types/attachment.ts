import type { EncryptionMetadata } from "./encryption";

/**
 * An encrypted image attachment.
 *
 * Image bytes are encrypted client-side before upload; only the ciphertext
 * blob is stored in Supabase Storage. `storagePath` references that blob and
 * `metadata` carries the parameters needed to decrypt it on the client.
 */
export interface Attachment {
  /** Attachment id (uuid). */
  id: string;
  roomId: string;
  messageId: string;
  /** Reference to the encrypted blob within the Supabase Storage bucket. */
  storagePath: string;
  /** MIME type of the ORIGINAL plaintext image (e.g. `image/png`). */
  mimeType: string;
  /** Size of the stored ciphertext blob in bytes. */
  sizeBytes: number;
  /** Non-secret parameters required to decrypt the blob. */
  metadata: EncryptionMetadata;
  createdAt: string;
}
