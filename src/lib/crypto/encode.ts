/**
 * Pure base64url (RFC 4648 §5) with no padding, no Buffer, no atob/btoa.
 * Works identically in the browser and Node so crypto tests can run anywhere.
 *
 * The alphabet is URL-safe (`-` and `_` instead of `+` and `/`) and omits
 * padding so encoded values are safe to store in text columns and put in
 * realtime payloads without extra escaping.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DECODE_TABLE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  DECODE_TABLE[ALPHABET.charCodeAt(i)] = i;
}

/**
 * A Uint8Array guaranteed to be backed by a real ArrayBuffer (not a
 * SharedArrayBuffer), satisfying Web Crypto's `BufferSource` requirement.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Encode bytes as unpadded base64url. */
export function bytesToBase64Url(bytes: Bytes | Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) {
      out += ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    }
    if (i + 2 < bytes.length) {
      out += ALPHABET[b2 & 0x3f];
    }
  }
  return out;
}

/** Decode unpadded base64url. Rejects invalid characters and non-canonical encodings. */
export function base64UrlToBytes(input: string): Bytes {
  if (input.length === 0) {
    return new Uint8Array(0);
  }
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 128) {
      throw new Error("invalid base64url: non-ASCII character");
    }
    const value = DECODE_TABLE[code];
    if (value < 0) {
      throw new Error("invalid base64url character");
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  // Non-canonical: leftover bits (from an input length not divisible by 4)
  // must be zero, otherwise two encodings could map to one byte string.
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new Error("invalid base64url: non-canonical padding bits");
  }
  return new Uint8Array(out);
}
