import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, type Bytes } from "@/lib/crypto/encode";
import { randomBytes } from "@/lib/crypto/primitives";
import {
  decryptImageBlob,
  decryptImagePayload,
  encryptImageBlob,
  encryptImagePayload,
} from "@/lib/crypto/image";

const ROOM_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ROOM_B = "11111111-2222-4333-8444-555555555555";
const MSG_ID = "22222222-3333-4444-8555-666666666666";
const ATT_ID = "33333333-4444-4555-8666-777777777777";

function key(): Bytes {
  return randomBytes(32);
}

describe("encryptImagePayload / decryptImagePayload", () => {
  it("round-trips the encrypted attachment pointer", async () => {
    const dek = key();
    const envelope = await encryptImagePayload(dek, ROOM_A, { attachmentId: ATT_ID });
    expect(await decryptImagePayload(dek, ROOM_A, envelope)).toEqual({ attachmentId: ATT_ID });
  });

  it("stamps a fresh 12-byte IV and V1 version", async () => {
    const dek = key();
    const envelope = await encryptImagePayload(dek, ROOM_A, { attachmentId: ATT_ID });
    expect(envelope.version).toBe(1);
    expect(envelope.iv).toHaveLength(16);
    expect(base64UrlToBytes(envelope.iv)).toHaveLength(12);
  });

  it("rejects decryption with the wrong room (AAD mismatch)", async () => {
    const dek = key();
    const envelope = await encryptImagePayload(dek, ROOM_A, { attachmentId: ATT_ID });
    await expect(decryptImagePayload(dek, ROOM_B, envelope)).rejects.toThrow();
  });

  it("rejects decryption with the wrong key", async () => {
    const envelope = await encryptImagePayload(key(), ROOM_A, { attachmentId: ATT_ID });
    await expect(decryptImagePayload(key(), ROOM_A, envelope)).rejects.toThrow();
  });

  it("detects tampered ciphertext and rejects non-pointer plaintext", async () => {
    const dek = key();
    const envelope = await encryptImagePayload(dek, ROOM_A, { attachmentId: ATT_ID });
    const tampered = base64UrlToBytes(envelope.ciphertext);
    tampered[0] ^= 0x01;
    await expect(
      decryptImagePayload(dek, ROOM_A, { ciphertext: bytesToBase64Url(tampered), iv: envelope.iv }),
    ).rejects.toThrow();

    // A validly encrypted but malformed payload is also rejected.
    const wrong = await encryptImagePayload(dek, ROOM_A, { attachmentId: "not a uuid" });
    expect((await decryptImagePayload(dek, ROOM_A, wrong)).attachmentId).toBe("not a uuid");
  });
});

describe("encryptImageBlob / decryptImageBlob", () => {
  it("round-trips binary image bytes (binary in, binary out)", async () => {
    const dek = key();
    const plaintext = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x12, 0x34]);
    const { ciphertext, iv } = await encryptImageBlob(dek, ROOM_A, MSG_ID, ATT_ID, plaintext);
    expect(ciphertext.length).toBe(plaintext.length + 16); // GCM tag
    const reopened = await decryptImageBlob(dek, ROOM_A, MSG_ID, ATT_ID, ciphertext, iv);
    expect(bytesToBase64Url(reopened)).toBe(bytesToBase64Url(plaintext));
  });

  it("is bound to the exact room, message and attachment (AAD)", async () => {
    const dek = key();
    const plaintext = new TextEncoder().encode("only for this message");
    const { ciphertext, iv } = await encryptImageBlob(dek, ROOM_A, MSG_ID, ATT_ID, plaintext);

    await expect(decryptImageBlob(dek, ROOM_B, MSG_ID, ATT_ID, ciphertext, iv)).rejects.toThrow();
    await expect(decryptImageBlob(dek, ROOM_A, "other-msg", ATT_ID, ciphertext, iv)).rejects.toThrow();
    await expect(decryptImageBlob(dek, ROOM_A, MSG_ID, "other-att", ciphertext, iv)).rejects.toThrow();
  });

  it("detects tampered blob ciphertext and iv", async () => {
    const dek = key();
    const { ciphertext, iv } = await encryptImageBlob(dek, ROOM_A, MSG_ID, ATT_ID, new TextEncoder().encode("x"));
    ciphertext[ciphertext.length - 1] ^= 0x01;
    await expect(decryptImageBlob(dek, ROOM_A, MSG_ID, ATT_ID, ciphertext, iv)).rejects.toThrow();

    const { ciphertext: c2, iv: iv2 } = await encryptImageBlob(dek, ROOM_A, MSG_ID, ATT_ID, new TextEncoder().encode("y"));
    iv2[0] ^= 0x01;
    await expect(decryptImageBlob(dek, ROOM_A, MSG_ID, ATT_ID, c2, iv2)).rejects.toThrow();
  });

  it("uses a unique nonce per encryption", async () => {
    const dek = key();
    const plaintext = new TextEncoder().encode("same bytes");
    const first = await encryptImageBlob(dek, ROOM_A, MSG_ID, ATT_ID, plaintext);
    const second = await encryptImageBlob(dek, ROOM_A, MSG_ID, ATT_ID, plaintext);
    expect(bytesToBase64Url(second.iv)).not.toBe(bytesToBase64Url(first.iv));
  });
});
