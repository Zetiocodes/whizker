import { describe, expect, it } from "vitest";
import { stripImageMetadata } from "@/lib/image/metadata";
import type { Bytes } from "@/lib/crypto/encode";

function b(values: number[]): Bytes {
  return Uint8Array.from(values);
}

function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
}

function jpegBytes(payloads: { marker: number; label: string }[]): Bytes {
  const flat: number[] = [0xff, 0xd8]; // SOI
  for (const { marker, label } of payloads) {
    const labelBytes = label.split("").map((c) => c.charCodeAt(0));
    flat.push(...segment(marker, labelBytes));
  }
  flat.push(...segment(0xda, [1, 2, 3, 4, 5])); // SOS
  flat.push(0x12, 0x34, 0x56); // entropy-coded data
  flat.push(0xff, 0xd9); // EOI
  return b(flat);
}

function pngBytes(withText: boolean): Bytes {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]): number[] => [
    (data.length >> 24) & 0xff,
    (data.length >> 16) & 0xff,
    (data.length >> 8) & 0xff,
    data.length & 0xff,
    ...type.split("").map((c) => c.charCodeAt(0)),
    ...data,
    0x00, 0x00, 0x00, 0x00, // CRC (not validated by the stripper)
  ];
  const flat = [...sig, ...chunk("IHDR", [0, 0, 0, 1, 8, 2, 0, 0, 0])];
  if (withText) {
    flat.push(...chunk("tEXt", "Comment\0some text".split("").map((c) => c.charCodeAt(0))));
    flat.push(...chunk("eXIf", [1, 2, 3]));
  }
  flat.push(...chunk("IDAT", [8, 6, 7, 5, 3, 0, 9]));
  flat.push(...chunk("IEND", []));
  return b(flat);
}

function webpBytes(withExif: boolean): Bytes {
  const chunk = (fourcc: string, data: number[]): number[] => [
    ...fourcc.split("").map((c) => c.charCodeAt(0)),
    data.length & 0xff,
    (data.length >> 8) & 0xff,
    (data.length >> 16) & 0xff,
    (data.length >> 24) & 0xff,
    ...data,
    ...(data.length % 2 === 1 ? [0x00] : []), // chunks are padded to even length
  ];
  const body = [...chunk("VP8 ", [1, 2, 3])];
  if (withExif) {
    body.push(...chunk("EXIF", [0x45, 0x78, 0x69, 0x66, 9, 9]));
  }
  const flat = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...body];
  return b(flat);
}

describe("stripImageMetadata", () => {
  it("drops APP1 (EXIF) from JPEG while keeping APP0, DQT, SOS and EOI", () => {
    const src = jpegBytes([
      { marker: 0xe0, label: "JFIF" },
      { marker: 0xe1, label: "EXIF" },
      { marker: 0xdb, label: "DQT!" },
    ]);
    const out = stripImageMetadata(src, "image/jpeg");

    expect(out).not.toEqual(src);
    expect(out.length).toBe(src.length - (2 + 2 + "EXIF".length));
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out[2]).toBe(0xff);
    expect(out[3]).toBe(0xe0); // APP0 kept
    expect(out[out.length - 2]).toBe(0xff);
    expect(out[out.length - 1]).toBe(0xd9); // EOI kept
    // No APP1 marker survives anywhere in the output.
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i] === 0xff) {
        expect(out[i + 1]).not.toBe(0xe1);
      }
    }
  });

  it("keeps a JPEG without any APP1 segment unchanged", () => {
    const src = jpegBytes([{ marker: 0xe0, label: "JFIF" }]);
    const out = stripImageMetadata(src, "image/jpeg");
    expect(out).toEqual(src);
  });

  it("drops tEXt and eXIf chunks from PNG, preserving image chunks", () => {
    const src = pngBytes(true);
    const out = stripImageMetadata(src, "image/png");
    const text = new TextDecoder().decode(out);
    expect(text).not.toContain("tEXt");
    expect(text).not.toContain("eXIf");
    expect(text).toContain("IHDR");
    expect(text).toContain("IDAT");
    expect(text).toContain("IEND");
    expect(out.length).toBeLessThan(src.length);
  });

  it("leaves a PNG without metadata chunks untouched", () => {
    const src = pngBytes(false);
    expect(stripImageMetadata(src, "image/png")).toEqual(src);
  });

  it("drops EXIF from WebP and re-stamps the RIFF size", () => {
    const src = webpBytes(true);
    const out = stripImageMetadata(src, "image/webp");
    expect(new TextDecoder().decode(out)).not.toContain("EXIF");
    const riffSize = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
    expect(riffSize).toBe(out.length - 8);
  });

  it("passes GIF through byte-for-byte", () => {
    const gif = b([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4]);
    expect(stripImageMetadata(gif, "image/gif")).toEqual(gif);
  });

  it("returns the original bytes for unknown mime types", () => {
    const src = jpegBytes([{ marker: 0xe1, label: "EXIF" }]);
    expect(stripImageMetadata(src, "application/octet-stream")).toEqual(src);
  });

  it("returns the original bytes for malformed JPEG instead of corrupting it", () => {
    const malformed = b([0xff, 0xd8, 0x12, 0x34]); // no parseable marker chain
    expect(stripImageMetadata(malformed, "image/jpeg")).toEqual(malformed);
  });

  it("returns the original bytes for truncated PNG chunk data", () => {
    const truncated = pngBytes(true).slice(0, 20);
    expect(stripImageMetadata(truncated, "image/png")).toEqual(truncated);
  });
});
