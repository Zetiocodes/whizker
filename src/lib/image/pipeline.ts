/**
 * Image send pipeline (Part 6).
 *
 * The order of operations matters and is all client-side:
 *
 *   validate -> strip metadata -> encrypt blob (AES-256-GCM, room DEK) -> upload
 *
 * Nothing here ever uploads plaintext: `prepareImageToSend` returns ONLY the
 * encrypted blob (plus the encrypted message payload pointing at the
 * attachment). The plaintext image exists solely in memory on the sender's
 * device and is discarded after encryption.
 *
 * Storage paths are non-predictable: `<roomId>/<attachmentId>.bin` where both
 * ids are random uuids generated in the browser. No usernames, display names,
 * room codes or sequential ids appear in a path, and no device/EXIF metadata
 * is used to derive one.
 */

import { bytesToBase64Url, type Bytes } from "@/lib/crypto/encode";
import { encryptImageBlob, encryptImagePayload, type ImageEnvelope } from "@/lib/crypto/image";

export const ATTACHMENT_EXTENSION = "bin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build the opaque storage path for an encrypted image blob. */
export function buildAttachmentPath(roomId: string, attachmentId: string): string {
  return `${roomId}/${attachmentId}.${ATTACHMENT_EXTENSION}`;
}

/**
 * Extract the room id from a storage path. Returns null for any path that is
 * not exactly `<uuid>/<name>.bin`, so garbage or foreign paths are ignored.
 */
export function roomIdFromPath(path: string): string | null {
  const slash = path.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const roomId = path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (!UUID_RE.test(roomId) || !name.endsWith(`.${ATTACHMENT_EXTENSION}`) || name.length < 5) {
    return null;
  }
  return roomId;
}

/** Everything the sender needs to upload + persist an encrypted image. */
export interface PreparedImage {
  /** The encrypted blob to upload (content type `application/octet-stream`). */
  blob: Blob;
  /** Ciphertext bytes of the image (binary form of `blob`). */
  ciphertext: Bytes;
  /** Encrypted message payload for the messages row (links the attachment). */
  payload: ImageEnvelope;
  /** base64url IV for the image blob (stored in attachments.iv). */
  ivB64: string;
  /** Stored ciphertext size in bytes. */
  sizeBytes: number;
  /** Canonical (sniffed) MIME type of the original image. */
  mime: string;
  attachmentId: string;
  messageId: string;
}

/**
 * Encrypt image bytes into an upload-ready payload. `plainBytes` must already
 * be validated and metadata-stripped (see validation.ts / metadata.ts); this
 * function only encrypts — it never inspects or stores plaintext.
 */
export async function prepareImageToSend(params: {
  dek: Bytes;
  roomId: string;
  messageId: string;
  attachmentId: string;
  plainBytes: Bytes;
  mime: string;
}): Promise<PreparedImage> {
  const { dek, roomId, messageId, attachmentId, plainBytes, mime } = params;
  const { ciphertext, iv } = await encryptImageBlob(dek, roomId, messageId, attachmentId, plainBytes);
  const payload = await encryptImagePayload(dek, roomId, { attachmentId });
  return {
    blob: new Blob([ciphertext], { type: "application/octet-stream" }),
    ciphertext,
    payload,
    ivB64: bytesToBase64Url(iv),
    sizeBytes: ciphertext.length,
    mime,
    attachmentId,
    messageId,
  };
}

/** Human-readable byte size (e.g. "1.4 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
