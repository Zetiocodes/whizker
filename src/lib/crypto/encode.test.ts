import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "@/lib/crypto/encode";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

describe("bytesToBase64Url", () => {
  it("uses only URL-safe characters and no padding", () => {
    for (let i = 0; i < 200; i++) {
      const encoded = bytesToBase64Url(randomBytes(i));
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(encoded).not.toContain("=");
    }
  });

  it("matches known vectors", () => {
    // 0xfb 0xff 0xef => 11111011 11111111 11101111
    //   => 111110(-) 111111(_) 111111(_) 101111(v)
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff, 0xef]))).toBe("-__v");
    expect(bytesToBase64Url(new Uint8Array([]))).toBe("");
    // "Hi" => 0x48 0x69 => 010010(S) 000110(G) 1001_00(k)
    expect(bytesToBase64Url(new Uint8Array([0x48, 0x69]))).toBe("SGk");
  });

  it("round-trips arbitrary lengths", () => {
    for (const length of [0, 1, 2, 3, 4, 15, 16, 17, 100, 255]) {
      const bytes = randomBytes(length);
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    }
  });

  it("round-trips an AES-GCM 12-byte nonce to exactly 16 characters", () => {
    const iv = randomBytes(12);
    expect(bytesToBase64Url(iv)).toHaveLength(16);
  });
});

describe("base64UrlToBytes", () => {
  it("rejects characters outside the alphabet", () => {
    expect(() => base64UrlToBytes("ab=c")).toThrow();
    expect(() => base64UrlToBytes("ab/c")).toThrow();
    expect(() => base64UrlToBytes("ab+c")).toThrow();
    expect(() => base64UrlToBytes("sgjæøå")).toThrow();
  });

  it("rejects non-canonical trailing bits", () => {
    // 'SGk' decodes to 0x48 0x69 with two unused trailing bits set to zero.
    // 'SGk' (last char value 33 = 100001) is canonical; 'SGj' (value 35 =
    // 100011) leaves non-zero trailing bits.
    expect(() => base64UrlToBytes("SGj")).toThrow();
  });

  it("decodes the empty string to an empty array", () => {
    expect(base64UrlToBytes("")).toEqual(new Uint8Array(0));
  });
});
