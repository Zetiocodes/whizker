/**
 * Client-side image metadata stripping (Part 6).
 *
 * Sensitive EXIF/GPS metadata is removed BEFORE encryption, entirely in the
 * browser, so it never leaves the device in readable form and is never visible
 * to the recipient either. Byte-level parsers (no re-encoding, no quality
 * loss, no animation loss):
 *
 *   JPEG  - walk segments, drop APP1 (EXIF + XMP). APP2 (ICC color profile) is
 *           kept so colors render as authored. Entropy-coded scan data is
 *           handled correctly (stuffed 0xFF 0x00 bytes and RSTn markers).
 *   PNG   - walk chunks, drop tEXt / iTXt / zTXt / tIME / eXIf. Image chunks
 *           (IHDR/PLTE/IDAT/IEND) are preserved byte-for-byte with valid CRCs.
 *   WebP  - walk RIFF chunks, drop EXIF / ICCP, re-stamp the RIFF size.
 *   GIF   - passed through byte-for-byte: it has no standard EXIF/GPS
 *           container. (Documented limitation, not silently claimed removed.)
 *
 * If a file's structure does not parse cleanly the ORIGINAL bytes are
 * returned rather than a corrupt image — metadata stripping is best-effort and
 * must never block sending or corrupt a picture. See docs/ENCRYPTION.md for
 * exactly what the server/recipient can still observe.
 */

import type { ValidatedImage } from "./validation";
import type { Bytes } from "@/lib/crypto/encode";

function concatRanges(src: Bytes, ranges: Array<[number, number]>): Bytes {
  let total = 0;
  for (const [start, end] of ranges) {
    total += end - start;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const [start, end] of ranges) {
    const len = end - start;
    out.set(src.subarray(start, end), offset);
    offset += len;
  }
  return out;
}

function stripJpeg(src: Bytes): Bytes {
  // Must start with the SOI marker; otherwise return the original untouched.
  if (src.length < 4 || src[0] !== 0xff || src[1] !== 0xd8) {
    return src;
  }
  const kept: Array<[number, number]> = [[0, 2]];
  let i = 2;
  // While inside an entropy-coded scan, non-marker bytes are image data.
  let scanStart: number | null = null;

  while (i + 1 < src.length) {
    if (src[i] !== 0xff) {
      if (scanStart === null) {
        return src; // bytes outside a scan before any marker = malformed
      }
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < src.length && src[j] === 0xff) {
      j += 1; // fill bytes
    }
    if (j >= src.length) {
      return src;
    }
    const marker = src[j];
    const markerEnd = j + 1;

    if (marker === 0x00) {
      if (scanStart === null) {
        return src;
      }
      i = markerEnd; // stuffed 0x00 inside scan data
      continue;
    }
    if (marker === 0xd9) {
      // End Of Image.
      if (scanStart !== null) {
        kept.push([scanStart, i]);
      }
      kept.push([i, markerEnd]);
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // Standalone: TEM or RSTn.
      if (scanStart !== null) {
        kept.push([scanStart, i]);
        scanStart = markerEnd;
      } else {
        kept.push([i, markerEnd]);
      }
      i = markerEnd;
      continue;
    }
    if (markerEnd + 2 > src.length) {
      return src;
    }
    const len = (src[markerEnd] << 8) | src[markerEnd + 1];
    if (len < 2 || markerEnd + len > src.length) {
      return src;
    }
    const segStart = i;
    const segEnd = markerEnd + len;

    if (scanStart !== null) {
      kept.push([scanStart, segStart]);
      scanStart = null;
    }

    if (marker === 0xda) {
      // Start Of Scan: keep the segment, then the entropy data follows.
      kept.push([segStart, segEnd]);
      scanStart = segEnd;
      i = segEnd;
      continue;
    }

    // APP1 (0xE1) is EXIF and often XMP — drop it. Everything else is kept.
    if (marker !== 0xe1) {
      kept.push([segStart, segEnd]);
    }
    i = segEnd;
  }

  return concatRanges(src, kept);
}

function stripPng(src: Bytes): Bytes {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (src.length < 8 || !sig.every((byte, index) => src[index] === byte)) {
    return src;
  }
  const kept: Array<[number, number]> = [[0, 8]];
  const dropped = new Set(["tEXt", "iTXt", "zTXt", "tIME", "eXIf"]);
  let i = 8;
  while (i + 8 <= src.length) {
    const len = (src[i] << 24) | (src[i + 1] << 16) | (src[i + 2] << 8) | src[i + 3];
    const type = String.fromCharCode(src[i + 4], src[i + 5], src[i + 6], src[i + 7]);
    const chunkEnd = i + 8 + len + 4; // length + type + data + crc
    if (chunkEnd > src.length) {
      return src;
    }
    kept.push([i, chunkEnd]);
    if (type === "IEND") {
      break;
    }
    if (dropped.has(type)) {
      kept.pop();
    }
    i = chunkEnd;
  }
  return concatRanges(src, kept);
}

function stripWebp(src: Bytes): Bytes {
  if (src.length < 12 || src[0] !== 0x52 || src[1] !== 0x49 || src[2] !== 0x46 || src[3] !== 0x46) {
    return src; // not "RIFF"
  }
  if (src[8] !== 0x57 || src[9] !== 0x45 || src[10] !== 0x42 || src[11] !== 0x50) {
    return src; // not "WEBP"
  }
  const kept: Array<[number, number]> = [[0, 12]];
  const dropped = new Set(["EXIF", "ICCP"]);
  let i = 12;
  while (i + 8 <= src.length) {
    const fourcc = String.fromCharCode(src[i], src[i + 1], src[i + 2], src[i + 3]);
    const size = src[i + 4] | (src[i + 5] << 8) | (src[i + 6] << 16) | (src[i + 7] << 24);
    const chunkSize = size + (size % 2); // chunks are padded to even length
    const chunkEnd = i + 8 + chunkSize;
    if (chunkEnd > src.length) {
      return src;
    }
    if (!dropped.has(fourcc)) {
      kept.push([i, chunkEnd]);
    }
    i = chunkEnd;
  }
  const out = concatRanges(src, kept);
  // Re-stamp the RIFF chunk size = file size - 8.
  const riffSize = out.length - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >> 24) & 0xff;
  return out;
}

/**
 * Strip sensitive metadata from a validated image, returning the bytes to be
 * encrypted. Best-effort: unparseable files come back unchanged (see header).
 */
export function stripImageMetadata(bytes: Bytes, mime: string): Bytes {
  switch (mime) {
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/png":
      return stripPng(bytes);
    case "image/webp":
      return stripWebp(bytes);
    case "image/gif":
      return bytes; // no standard EXIF/GPS container; documented
    default:
      return bytes;
  }
}

/**
 * Convenience: validate + strip in one call for the composer. Returns the
 * canonical mime and the stripped bytes (same array for GIF/unknown).
 */
export function validateAndStrip(
  validated: ValidatedImage,
  bytes: Bytes,
): Bytes {
  return stripImageMetadata(bytes, validated.mime);
}
