import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "@/lib/crypto/encode";
import {
  AES_GCM_IV_BYTES,
  ROOM_DEK_BYTES,
  computeKeyCheck,
  decryptMessage,
  deriveRoomDek,
  ecdhSharedSecret,
  encryptMessage,
  generateEcdhKeyPair,
  randomBytes,
  unwrapRoomDek,
  wrapRoomDek,
} from "@/lib/crypto/primitives";

const ROOM_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ROOM_B = "11111111-2222-4333-8444-555555555555";

async function participantPair() {
  const owner = await generateEcdhKeyPair();
  const guest = await generateEcdhKeyPair();
  return { owner, guest };
}

async function roomDekForBoth(roomId: string = ROOM_A) {
  const { owner, guest } = await participantPair();
  const ownerKey = await deriveRoomDek({
    roomId,
    ownEphemeralPrivateKey: owner.privateKey,
    peerEphemeralPublicKey: guest.publicKey,
  });
  const guestKey = await deriveRoomDek({
    roomId,
    ownEphemeralPrivateKey: guest.privateKey,
    peerEphemeralPublicKey: owner.publicKey,
  });
  return { ownerKey, guestKey, owner, guest };
}

describe("ecdhSharedSecret", () => {
  it("agrees on a shared secret from each side's keypair", async () => {
    const { owner, guest } = await participantPair();
    const a = await ecdhSharedSecret(owner.privateKey, guest.publicKey);
    const b = await ecdhSharedSecret(guest.privateKey, owner.publicKey);
    expect(bytesToBase64Url(a)).toBe(bytesToBase64Url(b));
    expect(a.length).toBe(32);
  });

  it("produces a different secret with a different peer", async () => {
    const { owner, guest } = await participantPair();
    const other = await generateEcdhKeyPair();
    const a = await ecdhSharedSecret(owner.privateKey, guest.publicKey);
    const c = await ecdhSharedSecret(owner.privateKey, other.publicKey);
    expect(bytesToBase64Url(a)).not.toBe(bytesToBase64Url(c));
  });
});

describe("deriveRoomDek", () => {
  it("derives the same DEK and key_check for both participants", async () => {
    const { ownerKey, guestKey } = await roomDekForBoth();
    expect(bytesToBase64Url(ownerKey.dek)).toBe(bytesToBase64Url(guestKey.dek));
    expect(ownerKey.keyCheck).toBe(guestKey.keyCheck);
    expect(ownerKey.dek.length).toBe(ROOM_DEK_BYTES);
  });

  it("binds the DEK to the room id", async () => {
    const { owner, guest } = await participantPair();
    const forA = await deriveRoomDek({
      roomId: ROOM_A,
      ownEphemeralPrivateKey: owner.privateKey,
      peerEphemeralPublicKey: guest.publicKey,
    });
    const forB = await deriveRoomDek({
      roomId: ROOM_B,
      ownEphemeralPrivateKey: owner.privateKey,
      peerEphemeralPublicKey: guest.publicKey,
    });
    expect(bytesToBase64Url(forA.dek)).not.toBe(bytesToBase64Url(forB.dek));
  });

  it("the server, holding only public keys, cannot recover the DEK", async () => {
    const { owner, guest } = await participantPair();
    // A server-side attacker knows: owner.publicKey, guest.publicKey, room id.
    // Without either private key it has no ECDH shared secret to feed the KDF.
    // Using a public key where a private key is required must fail.
    await expect(
      deriveRoomDek({
        roomId: ROOM_A,
        ownEphemeralPrivateKey: owner.publicKey,
        peerEphemeralPublicKey: guest.publicKey,
      }),
    ).rejects.toThrow();
  });

  it("rejects a wrong-length or malformed peer public key", async () => {
    const { owner } = await participantPair();
    await expect(
      deriveRoomDek({
        roomId: ROOM_A,
        ownEphemeralPrivateKey: owner.privateKey,
        peerEphemeralPublicKey: new Uint8Array(8),
      }),
    ).rejects.toThrow();
  });
});

describe("encryptMessage / decryptMessage", () => {
  it("round-trips text including unicode and newlines", async () => {
    const { ownerKey } = await roomDekForBoth();
    const plaintext = "Hello 👋\nsecond line — ünïcode";
    const envelope = await encryptMessage(ownerKey.dek, ROOM_A, plaintext);
    expect(await decryptMessage(ownerKey.dek, ROOM_A, envelope)).toBe(plaintext);
  });

  it("stamps the envelope version and a 12-byte base64url IV", async () => {
    const { ownerKey } = await roomDekForBoth();
    const envelope = await encryptMessage(ownerKey.dek, ROOM_A, "x");
    expect(envelope.version).toBe(1);
    expect(envelope.iv).toHaveLength(16);
    expect(base64UrlToBytes(envelope.iv)).toHaveLength(AES_GCM_IV_BYTES);
  });

  it("the peer participant can decrypt what the owner encrypts", async () => {
    const { ownerKey, guestKey } = await roomDekForBoth();
    const envelope = await encryptMessage(ownerKey.dek, ROOM_A, "shared secret");
    expect(await decryptMessage(guestKey.dek, ROOM_A, envelope)).toBe("shared secret");
  });

  it("rejects decryption with a different room key", async () => {
    const { ownerKey } = await roomDekForBoth(ROOM_A);
    const other = await roomDekForBoth(ROOM_B);
    const envelope = await encryptMessage(ownerKey.dek, ROOM_A, "hi");
    await expect(decryptMessage(other.ownerKey.dek, ROOM_A, envelope)).rejects.toThrow();
  });

  it("detects tampered ciphertext", async () => {
    const { ownerKey } = await roomDekForBoth();
    const envelope = await encryptMessage(ownerKey.dek, ROOM_A, "authenticated");
    const tampered = base64UrlToBytes(envelope.ciphertext);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(
      decryptMessage(ownerKey.dek, ROOM_A, { ciphertext: bytesToBase64Url(tampered), iv: envelope.iv }),
    ).rejects.toThrow();
  });

  it("detects a tampered IV", async () => {
    const { ownerKey } = await roomDekForBoth();
    const envelope = await encryptMessage(ownerKey.dek, ROOM_A, "authenticated");
    const tamperedIv = base64UrlToBytes(envelope.iv);
    tamperedIv[0] ^= 0x01;
    await expect(
      decryptMessage(ownerKey.dek, ROOM_A, { ciphertext: envelope.ciphertext, iv: bytesToBase64Url(tamperedIv) }),
    ).rejects.toThrow();
  });

  it("rejects decryption with the wrong room id (AAD mismatch)", async () => {
    const { ownerKey } = await roomDekForBoth();
    const envelope = await encryptMessage(ownerKey.dek, ROOM_A, "bound to room");
    await expect(decryptMessage(ownerKey.dek, ROOM_B, envelope)).rejects.toThrow();
  });

  it("uses a fresh random nonce for every message", async () => {
    const { ownerKey } = await roomDekForBoth();
    const ivs = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const envelope = await encryptMessage(ownerKey.dek, ROOM_A, `message ${i}`);
      ivs.add(envelope.iv);
    }
    expect(ivs.size).toBe(500);
  });

  it("does not reuse a nonce after a message with identical content", async () => {
    const { ownerKey } = await roomDekForBoth();
    const first = await encryptMessage(ownerKey.dek, ROOM_A, "same text");
    const second = await encryptMessage(ownerKey.dek, ROOM_A, "same text");
    expect(second.iv).not.toBe(first.iv);
  });
});

describe("server only ever sees ciphertext", () => {
  it("the stored message payload contains no plaintext", async () => {
    const { ownerKey } = await roomDekForBoth();
    const secret = "attack at dawn — do not leak this";
    const envelope = await encryptMessage(ownerKey.dek, ROOM_A, secret);

    // This is exactly the row shape written to `messages` (see ChatPanel).
    const storedRow = JSON.stringify({
      room_id: ROOM_A,
      sender_id: "user-1",
      type: "text",
      ciphertext: envelope.ciphertext,
      iv: envelope.iv,
      version: envelope.version,
    });

    expect(storedRow).not.toContain(secret);
    expect(storedRow).not.toContain("attack");
    expect(storedRow).not.toContain(JSON.stringify(secret.slice(0, 8)));
    // The stored bytes are not the UTF-8 encoding of the plaintext.
    expect(base64UrlToBytes(envelope.ciphertext)).not.toEqual(new TextEncoder().encode(secret));
  });

  it("a server-side observer with only ciphertext + iv cannot decrypt", async () => {
    const { ownerKey } = await roomDekForBoth();
    const secret = "server eyes only see ciphertext";
    const envelope = await encryptMessage(ownerKey.dek, ROOM_A, secret);
    const randomKey = randomBytes(ROOM_DEK_BYTES);
    await expect(decryptMessage(randomKey, ROOM_A, envelope)).rejects.toThrow();
    expect(await decryptMessage(ownerKey.dek, ROOM_A, envelope)).toBe(secret);
  });
});

describe("wrapRoomDek / unwrapRoomDek", () => {
  it("round-trips a DEK under the identity key", async () => {
    const { ownerKey } = await roomDekForBoth();
    const identity = await generateEcdhKeyPair();
    const wrapped = await wrapRoomDek(ownerKey.dek, identity.privateKey, identity.publicKey, ROOM_A);
    const unwrapped = await unwrapRoomDek(wrapped, identity.privateKey, identity.publicKey, ROOM_A);
    expect(bytesToBase64Url(unwrapped)).toBe(bytesToBase64Url(ownerKey.dek));
    // The unwrapped DEK still decrypts the conversation's messages.
    const envelope = await encryptMessage(ownerKey.dek, ROOM_A, "recovery works");
    expect(await decryptMessage(unwrapped, ROOM_A, envelope)).toBe("recovery works");
  });

  it("rejects unwrapping with a different identity", async () => {
    const { ownerKey } = await roomDekForBoth();
    const identityA = await generateEcdhKeyPair();
    const identityB = await generateEcdhKeyPair();
    const wrapped = await wrapRoomDek(ownerKey.dek, identityA.privateKey, identityA.publicKey, ROOM_A);
    await expect(unwrapRoomDek(wrapped, identityB.privateKey, identityB.publicKey, ROOM_A)).rejects.toThrow();
  });

  it("detects tampering of the wrapped blob", async () => {
    const { ownerKey } = await roomDekForBoth();
    const identity = await generateEcdhKeyPair();
    const wrapped = await wrapRoomDek(ownerKey.dek, identity.privateKey, identity.publicKey, ROOM_A);
    const blob = base64UrlToBytes(wrapped);
    blob[blob.length - 1] ^= 0x01;
    await expect(unwrapRoomDek(bytesToBase64Url(blob), identity.privateKey, identity.publicKey, ROOM_A)).rejects.toThrow();
  });
});

describe("computeKeyCheck", () => {
  it("agrees across participants and differs across rooms", async () => {
    const { ownerKey, guestKey } = await roomDekForBoth();
    expect(ownerKey.keyCheck).toBe(guestKey.keyCheck);
    const other = await roomDekForBoth(ROOM_B);
    expect(other.ownerKey.keyCheck).not.toBe(ownerKey.keyCheck);
    expect(ownerKey.keyCheck).toBe(await computeKeyCheck(ownerKey.dek));
  });

  it("reveals nothing about the DEK (fixed-length, non-empty, base64url)", async () => {
    const { ownerKey } = await roomDekForBoth();
    expect(ownerKey.keyCheck).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ownerKey.keyCheck.length).toBeGreaterThan(20);
    expect(ownerKey.keyCheck).not.toContain(bytesToBase64Url(ownerKey.dek));
  });
});
