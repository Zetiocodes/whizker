import { describe, expect, it } from "vitest";
import { randomBytes } from "@/lib/crypto/primitives";
import { base64UrlToBytes, bytesToBase64Url } from "@/lib/crypto/encode";
import { decryptImageBlob, decryptImagePayload } from "@/lib/crypto/image";
import {
  ATTACHMENT_EXTENSION,
  buildAttachmentPath,
  formatBytes,
  prepareImageToSend,
  roomIdFromPath,
} from "@/lib/image/pipeline";
import type { Bytes } from "@/lib/crypto/encode";

const ROOM_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MSG_ID = "11111111-2222-4333-8444-555555555555";
const ATTACHMENT_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";

function dek(): Bytes {
  return randomBytes(32);
}

describe("buildAttachmentPath", () => {
  it("joins room id and attachment id with the opaque .bin extension", () => {
    const path = buildAttachmentPath(ROOM_ID, ATTACHMENT_ID);
    expect(path).toBe(`${ROOM_ID}/${ATTACHMENT_ID}.${ATTACHMENT_EXTENSION}`);
  });
});

describe("roomIdFromPath", () => {
  it("extracts the room id from a valid attachment path", () => {
    expect(roomIdFromPath(`${ROOM_ID}/${ATTACHMENT_ID}.bin`)).toBe(ROOM_ID);
  });

  it("rejects non-uuid folders, wrong extensions and garbage", () => {
    expect(roomIdFromPath("not-a-uuid/x.bin")).toBeNull();
    expect(roomIdFromPath(`${ROOM_ID}/x.png`)).toBeNull();
    expect(roomIdFromPath(`${ROOM_ID}/`)).toBeNull();
    expect(roomIdFromPath("")).toBeNull();
    expect(roomIdFromPath("abcdefgh/x.bin")).toBeNull();
  });
});

describe("prepareImageToSend", () => {
  it("returns only ciphertext plus an encrypted attachment pointer", async () => {
    const plaintext = new TextEncoder().encode("fake image bytes");
    const prepared = await prepareImageToSend({
      dek: dek(),
      roomId: ROOM_ID,
      messageId: MSG_ID,
      attachmentId: ATTACHMENT_ID,
      plainBytes: plaintext,
      mime: "image/png",
    });

    expect(prepared.blob.type).toBe("application/octet-stream");
    expect(prepared.blob.size).toBe(prepared.ciphertext.length);
    expect(prepared.sizeBytes).toBe(prepared.ciphertext.length);
    expect(prepared.ivB64).toHaveLength(16);
    expect(base64UrlToBytes(prepared.ivB64)).toHaveLength(12);
    expect(prepared.attachmentId).toBe(ATTACHMENT_ID);
    expect(prepared.messageId).toBe(MSG_ID);
    expect(prepared.mime).toBe("image/png");
    expect(prepared.payload.version).toBe(1);
  });

  it("the blob and payload decrypt back to the original bytes and pointer", async () => {
    const key = dek();
    const plaintext = new TextEncoder().encode("the real image");
    const prepared = await prepareImageToSend({
      dek: key,
      roomId: ROOM_ID,
      messageId: MSG_ID,
      attachmentId: ATTACHMENT_ID,
      plainBytes: plaintext,
      mime: "image/webp",
    });

    const reopened = await decryptImageBlob(
      key,
      ROOM_ID,
      MSG_ID,
      ATTACHMENT_ID,
      prepared.ciphertext,
      base64UrlToBytes(prepared.ivB64),
    );
    expect(bytesToBase64Url(reopened)).toBe(bytesToBase64Url(plaintext));

    const payload = await decryptImagePayload(key, ROOM_ID, prepared.payload);
    expect(payload.attachmentId).toBe(ATTACHMENT_ID);
  });

  it("never embeds the plaintext image bytes in anything persisted", async () => {
    const secret = new TextEncoder().encode("GEO: secret location");
    const prepared = await prepareImageToSend({
      dek: dek(),
      roomId: ROOM_ID,
      messageId: MSG_ID,
      attachmentId: ATTACHMENT_ID,
      plainBytes: secret,
      mime: "image/jpeg",
    });
    // The uploadable surface is the blob bytes + the base64 payload row.
    const uploadable = new TextDecoder().decode(await prepared.blob.arrayBuffer());
    expect(uploadable).not.toContain("GEO");
    const persistedRow = JSON.stringify(prepared.payload);
    expect(persistedRow).not.toContain("GEO");
  });
});

describe("formatBytes", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(4 * 1024)).toBe("4.0 KB");
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
    expect(formatBytes(8 * 1024 * 1024)).toBe("8.0 MB");
  });
});
