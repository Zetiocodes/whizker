/**
 * Image message encryption (Part 6).
 *
 * Reuses the Part 4 primitives (AES-256-GCM under the room DEK) with AAD that
 * binds each payload to its room AND its message/attachment, so ciphertext can
 * never be replayed against a different row, room or message kind:
 *
 *   image payload (messages.ciphertext): AAD "whisper/image/v1|<roomId>"
 *       plaintext: {"attachmentId":"<uuid>"} — an encrypted pointer to the
 *       attachment row. The recipient must decrypt it to learn which storage
 *       object belongs to the message, so a compromised server cannot swap in
 *       a different attachment.
 *
 *   image blob (storage object): AAD "whisper/image-blob/v1|<roomId>|<msgId>|<attId>"
 *       plaintext: the image bytes (post metadata-stripping). IV stored in
 *       attachments.iv. The blob is uploaded as opaque `application/octet-stream`
 *       ciphertext; the server never sees image bytes or an image content type.
 *
 * No plaintext image data ever leaves the browser, and no base64 conversion
 * happens for the blob itself — binary in, binary out.
 */

import { base64UrlToBytes, bytesToBase64Url, type Bytes } from "./encode";
import {
  AES_GCM_IV_BYTES,
  ENCRYPTION_VERSION,
  decryptBinary,
  encryptBinary,
  randomBytes,
} from "./primitives";

const IMAGE_META_INFO = "whisper/image/v1";
const IMAGE_BLOB_INFO = "whisper/image-blob/v1";

/** Plaintext of an image message's payload row. */
export interface ImageMessagePayload {
  /** Attachment row id (uuid); the encrypted pointer to the storage object. */
  attachmentId: string;
}

/** The message-row envelope for an image message (base64url ciphertext). */
export interface ImageEnvelope {
  ciphertext: string;
  iv: string;
  version: number;
}

function utf8(input: string): Bytes {
  return new TextEncoder().encode(input);
}

function imageMetaAad(roomId: string): Bytes {
  return utf8(`${IMAGE_META_INFO}|${roomId}`);
}

function imageBlobAad(roomId: string, messageId: string, attachmentId: string): Bytes {
  return utf8(`${IMAGE_BLOB_INFO}|${roomId}|${messageId}|${attachmentId}`);
}

/**
 * Seal an image message's payload (the encrypted attachment pointer) for the
 * messages row. Always uses a fresh random 96-bit nonce.
 */
export async function encryptImagePayload(
  dek: Bytes,
  roomId: string,
  payload: ImageMessagePayload,
): Promise<ImageEnvelope> {
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const ciphertext = await encryptBinary(
    dek,
    utf8(JSON.stringify(payload)),
    iv,
    imageMetaAad(roomId),
  );
  return {
    ciphertext: bytesToBase64Url(ciphertext),
    iv: bytesToBase64Url(iv),
    version: ENCRYPTION_VERSION,
  };
}

/**
 * Open an image message payload. Throws on a wrong key, tampering, or a wrong
 * room; callers surface the failure as "couldn't decrypt" — never internals.
 */
export async function decryptImagePayload(
  dek: Bytes,
  roomId: string,
  envelope: Pick<ImageEnvelope, "ciphertext" | "iv">,
): Promise<ImageMessagePayload> {
  const plaintext = await decryptBinary(
    dek,
    base64UrlToBytes(envelope.ciphertext),
    base64UrlToBytes(envelope.iv),
    imageMetaAad(roomId),
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as ImageMessagePayload).attachmentId !== "string") {
    throw new Error("invalid image payload");
  }
  return { attachmentId: (parsed as ImageMessagePayload).attachmentId };
}

/**
 * Encrypt the actual image bytes for the storage blob. Binary in, binary out;
 * the returned ciphertext is what gets uploaded. Binds to room + message +
 * attachment so a blob can never be replayed against a different message.
 */
export async function encryptImageBlob(
  dek: Bytes,
  roomId: string,
  messageId: string,
  attachmentId: string,
  plaintext: Bytes,
): Promise<{ ciphertext: Bytes; iv: Bytes }> {
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const ciphertext = await encryptBinary(dek, plaintext, iv, imageBlobAad(roomId, messageId, attachmentId));
  return { ciphertext, iv };
}

/** Inverse of {@link encryptImageBlob}. Throws on any tampering / wrong key. */
export async function decryptImageBlob(
  dek: Bytes,
  roomId: string,
  messageId: string,
  attachmentId: string,
  ciphertext: Bytes,
  iv: Bytes,
): Promise<Bytes> {
  return decryptBinary(dek, ciphertext, iv, imageBlobAad(roomId, messageId, attachmentId));
}
