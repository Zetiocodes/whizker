/**
 * Web Crypto primitives used by the app (V1).
 *
 * Only standard, established primitives are used:
 * - AEAD: AES-256-GCM (authenticated encryption)
 * - KDF: HKDF-SHA256
 * - Key agreement: ECDH over P-256 (NIST curve, supported everywhere)
 * - MAC: HMAC-SHA256 (room-key agreement check)
 *
 * Room codes and passwords are NEVER used as keys. The room DEK is derived
 * with HKDF from an ephemeral-ephemeral ECDH shared secret, so the server —
 * which never sees either ephemeral private key — cannot recover it.
 *
 * Every function here is a pure function of its inputs: no storage, no
 * network, no global state. This keeps the module testable in Node and the
 * browser with identical behaviour.
 */

import { base64UrlToBytes, bytesToBase64Url, type Bytes } from "./encode";

/** Format version stamped on every message envelope. */
export const ENCRYPTION_VERSION = 1 as const;

/** Room DEK length. */
export const ROOM_DEK_BYTES = 32;
/** AES-GCM 96-bit nonce (12 bytes) as required by the schema. */
export const AES_GCM_IV_BYTES = 12;
/** Key-agreement algorithm identifier stored in room_keys.key_exchange. */
export const KEY_EXCHANGE_ALGORITHM = "ECDH-P256" as const;

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const AES_GCM: Algorithm = { name: "AES-GCM" };
const HMAC: HmacImportParams = { name: "HMAC", hash: "SHA-256" };

const ROOM_DEK_INFO = "whisper/room-dek/v1";
const KEY_CHECK_INFO = "whisper/key-check/v1";
const WRAP_INFO = "whisper/wrap/v1";

function subtle(): SubtleCrypto {
  const api = globalThis.crypto;
  if (!api || typeof api.subtle === "undefined") {
    throw new Error("Web Crypto API is not available in this context");
  }
  return api.subtle;
}

function utf8(input: string): Bytes {
  return new TextEncoder().encode(input);
}

/** Cryptographically secure random bytes. */
export function randomBytes(length: number): Bytes {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** An ECDH P-256 keypair serialized for client-side storage. */
export interface EcdhKeyPair {
  /** Raw uncompressed P-256 point (65 bytes). Safe to publish. */
  publicKey: Bytes;
  /** PKCS#8 DER (121 bytes). Client-side only. Never stored server-side. */
  privateKey: Bytes;
}

export async function generateEcdhKeyPair(): Promise<EcdhKeyPair> {
  const pair = await subtle().generateKey(ECDH_PARAMS, true, ["deriveBits"]);
  const [publicKey, privateKey] = await Promise.all([
    subtle().exportKey("raw", pair.publicKey),
    subtle().exportKey("pkcs8", pair.privateKey),
  ]);
  return { publicKey: new Uint8Array(publicKey), privateKey: new Uint8Array(privateKey) };
}

async function importPrivateKey(privateKey: Bytes): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", privateKey, ECDH_PARAMS, false, ["deriveBits"]);
}

async function importPublicKey(publicKey: Bytes): Promise<CryptoKey> {
  return subtle().importKey("raw", publicKey, ECDH_PARAMS, false, []);
}

/** ECDH shared secret (X25519-style agreement) between own private and peer public keys. */
export async function ecdhSharedSecret(ownPrivateKey: Bytes, peerPublicKey: Bytes): Promise<Bytes> {
  const [privateKey, publicKey] = await Promise.all([
    importPrivateKey(ownPrivateKey),
    importPublicKey(peerPublicKey),
  ]);
  const bits = await subtle().deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  return new Uint8Array(bits);
}

/** HKDF-SHA256 expand: derive `lengthBytes` of key material. */
export async function hkdfSha256(ikm: Bytes, salt: Bytes, info: string, lengthBytes: number): Promise<Bytes> {
  const key = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) }, key, lengthBytes * 8);
  return new Uint8Array(bits);
}

/** HMAC-SHA256 over a UTF-8 string, returning raw bytes. */
export async function hmacSha256(key: Bytes, data: string): Promise<Bytes> {
  const cryptoKey = await subtle().importKey("raw", key, HMAC, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", cryptoKey, utf8(data)));
}

/** AES-256-GCM seal. `additionalData` is authenticated but not encrypted. */
export async function aesGcmEncrypt(
  key: Bytes,
  plaintext: Bytes,
  iv: Bytes,
  additionalData?: Bytes,
): Promise<Bytes> {
  const cryptoKey = await subtle().importKey("raw", key, AES_GCM, false, ["encrypt"]);
  return new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv, additionalData: additionalData ?? new Uint8Array() }, cryptoKey, plaintext),
  );
}

/**
 * AES-256-GCM open. Throws on any tampering of the ciphertext, IV or AAD,
 * and on a wrong key. Callers must treat a throw as "cannot decrypt".
 */
export async function aesGcmDecrypt(
  key: Bytes,
  ciphertext: Bytes,
  iv: Bytes,
  additionalData?: Bytes,
): Promise<Bytes> {
  const cryptoKey = await subtle().importKey("raw", key, AES_GCM, false, ["decrypt"]);
  return new Uint8Array(
    await subtle().decrypt({ name: "AES-GCM", iv, additionalData: additionalData ?? new Uint8Array() }, cryptoKey, ciphertext),
  );
}

/** Room DEK agreement check: base64url HMAC of a constant under the DEK. */
export async function computeKeyCheck(dek: Bytes): Promise<string> {
  const mac = await hmacSha256(dek, KEY_CHECK_INFO);
  return bytesToBase64Url(mac);
}

export interface DerivedRoomKey {
  /** 32-byte AES-256 key for message payloads. */
  dek: Bytes;
  /** base64url HMAC used to verify both participants derived the same DEK. */
  keyCheck: string;
}

/**
 * Derive the room DEK from the ECDH shared secret between own ephemeral
 * private key and the peer's ephemeral public key. Both participants run this
 * with their own private key and the other's public key and arrive at the
 * SAME DEK; the server, which sees neither private key, cannot.
 */
export async function deriveRoomDek(params: {
  roomId: string;
  ownEphemeralPrivateKey: Bytes;
  peerEphemeralPublicKey: Bytes;
}): Promise<DerivedRoomKey> {
  const shared = await ecdhSharedSecret(params.ownEphemeralPrivateKey, params.peerEphemeralPublicKey);
  const dek = await hkdfSha256(shared, utf8(params.roomId), ROOM_DEK_INFO, ROOM_DEK_BYTES);
  const keyCheck = await computeKeyCheck(dek);
  return { dek, keyCheck };
}

/** Message AAD binds every payload to its room. */
function messageAad(roomId: string): Bytes {
  return utf8(`whisper/message/v1|${roomId}`);
}

export interface MessageEnvelope {
  ciphertext: string;
  iv: string;
  version: number;
}

/** Encrypt a text message. Always uses a fresh random 96-bit nonce. */
export async function encryptMessage(dek: Bytes, roomId: string, plaintext: string): Promise<MessageEnvelope> {
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const ciphertext = await aesGcmEncrypt(dek, utf8(plaintext), iv, messageAad(roomId));
  return {
    ciphertext: bytesToBase64Url(ciphertext),
    iv: bytesToBase64Url(iv),
    version: ENCRYPTION_VERSION,
  };
}

/**
 * Decrypt a text message. Throws on wrong key / tampering / wrong room.
 * The caller decides how to surface the failure (never the plaintext).
 */
export async function decryptMessage(
  dek: Bytes,
  roomId: string,
  envelope: Pick<MessageEnvelope, "ciphertext" | "iv">,
): Promise<string> {
  const plaintext = await aesGcmDecrypt(dek, base64UrlToBytes(envelope.ciphertext), base64UrlToBytes(envelope.iv), messageAad(roomId));
  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt arbitrary BINARY data (e.g. an image) under the room DEK with the
 * same AES-256-GCM primitive used for text messages. The IV must be a fresh
 * 96-bit nonce (see {@link randomBytes} / {@link AES_GCM_IV_BYTES}); callers
 * provide explicit `additionalData` so the payload is bound to its room,
 * message and attachment (see `src/lib/crypto/image.ts`). No base64 conversion
 * is performed here — binary ciphertext stays binary, which is exactly what an
 * encrypted image blob in Storage should be.
 *
 * This is the careful Part 6 extension of the Part 4 API for non-UTF-8 data:
 * the same key, the same AEAD, the same AAD approach — never a new cipher.
 */
export async function encryptBinary(
  dek: Bytes,
  plaintext: Bytes,
  iv: Bytes,
  additionalData?: Bytes,
): Promise<Bytes> {
  return aesGcmEncrypt(dek, plaintext, iv, additionalData);
}

/**
 * Inverse of {@link encryptBinary}. Throws on a wrong key, tampered ciphertext
 * or a mismatched `additionalData`; callers surface the failure without
 * exposing crypto internals.
 */
export async function decryptBinary(
  dek: Bytes,
  ciphertext: Bytes,
  iv: Bytes,
  additionalData?: Bytes,
): Promise<Bytes> {
  return aesGcmDecrypt(dek, ciphertext, iv, additionalData);
}

/**
 * Wrap a DEK under the user's own identity key (self-wrap). Used for
 * recovery: if ephemeral material for a room is lost but the identity key
 * survives, the DEK can be unwrapped and verified against key_check.
 *
 * Output: base64url(iv || AES-GCM(wrapKey, DEK)) where wrapKey is derived
 * from the identity key pair with the room id as salt. Non-secret metadata
 * aside, the server only ever holds this sealed form.
 */
export async function wrapRoomDek(
  dek: Bytes,
  identityPrivateKey: Bytes,
  identityPublicKey: Bytes,
  roomId: string,
): Promise<string> {
  const shared = await ecdhSharedSecret(identityPrivateKey, identityPublicKey);
  const wrapKey = await hkdfSha256(shared, utf8(roomId), WRAP_INFO, ROOM_DEK_BYTES);
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const ciphertext = await aesGcmEncrypt(wrapKey, dek, iv, utf8(`${WRAP_INFO}|${roomId}`));
  const blob = new Uint8Array(iv.length + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, iv.length);
  return bytesToBase64Url(blob);
}

/** Inverse of {@link wrapRoomDek}. Throws on any tampering or wrong identity. */
export async function unwrapRoomDek(
  wrapped: string,
  identityPrivateKey: Bytes,
  identityPublicKey: Bytes,
  roomId: string,
): Promise<Bytes> {
  const blob = base64UrlToBytes(wrapped);
  if (blob.length <= AES_GCM_IV_BYTES) {
    throw new Error("invalid wrapped key");
  }
  const iv = blob.slice(0, AES_GCM_IV_BYTES);
  const ciphertext = blob.slice(AES_GCM_IV_BYTES);
  const shared = await ecdhSharedSecret(identityPrivateKey, identityPublicKey);
  const wrapKey = await hkdfSha256(shared, utf8(roomId), WRAP_INFO, ROOM_DEK_BYTES);
  return aesGcmDecrypt(wrapKey, ciphertext, iv, utf8(`${WRAP_INFO}|${roomId}`));
}
