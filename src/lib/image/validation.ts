/**
 * Client-side image validation (Part 6).
 *
 * Pure and DOM-free so it runs in Node tests with identical behaviour. The
 * browser-provided MIME type is NEVER trusted on its own: the file's magic
 * bytes are sniffed and that canonical type is what the pipeline stores and
 * encrypts. Files are rejected before any encryption or upload work.
 */

/** User-facing categories of rejection, mapped to messages by the caller. */
export type ImageValidationErrorCode = "too-large" | "unsupported-type" | "invalid-image";

export class ImageValidationError extends Error {
  readonly code: ImageValidationErrorCode;

  constructor(code: ImageValidationErrorCode, message: string) {
    super(message);
    this.name = "ImageValidationError";
    this.code = code;
  }
}

export const JPEG_MAGIC = [0xff, 0xd8, 0xff];
export const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const GIF_87A_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
export const GIF_89A_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) {
    return false;
  }
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Sniff the canonical MIME type from the file's header. Returns null when the
 * bytes are not one of the supported image formats.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, JPEG_MAGIC)) {
    return "image/jpeg";
  }
  if (startsWith(bytes, PNG_MAGIC)) {
    return "image/png";
  }
  if (startsWith(bytes, GIF_87A_MAGIC) || startsWith(bytes, GIF_89A_MAGIC)) {
    return "image/gif";
  }
  // WebP: "RIFF"<size>"WEBP".
  if (bytes.length >= 12 && startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

/** The minimal view of a picked file that validation needs. */
export interface ImageFileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export interface ImageLimits {
  maxBytes: number;
  allowedMimeTypes: readonly string[];
}

export interface ValidatedImage {
  /** Canonical MIME type from the sniffed magic bytes (never the declared one). */
  mime: string;
  /** Actual plaintext byte length (authoritative, not `file.size`). */
  sizeBytes: number;
}

/**
 * Validate a picked image. Rejects oversized files first (cheap), then
 * non-images, then formats outside the allow-list. The returned `mime` is the
 * sniffed canonical type.
 */
export function validateImage(
  file: ImageFileLike,
  bytes: Uint8Array,
  limits: ImageLimits,
): ValidatedImage {
  const size = bytes.length;
  if (size > limits.maxBytes) {
    throw new ImageValidationError(
      "too-large",
      `Image exceeds the ${limits.maxBytes} byte limit`,
    );
  }
  if (file.size > limits.maxBytes) {
    // Belt-and-braces: never trust a crafted `size` on the File either.
    throw new ImageValidationError(
      "too-large",
      `Image exceeds the ${limits.maxBytes} byte limit`,
    );
  }
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) {
    throw new ImageValidationError("invalid-image", "The selected file is not a supported image");
  }
  if (!limits.allowedMimeTypes.includes(sniffed)) {
    throw new ImageValidationError("unsupported-type", `Unsupported image format: ${sniffed}`);
  }
  return { mime: sniffed, sizeBytes: size };
}

/** User-facing message for a validation rejection. */
export function imageValidationMessage(code: ImageValidationErrorCode, maxBytes: number): string {
  switch (code) {
    case "too-large":
      return `Image is too large. The maximum is ${(maxBytes / (1024 * 1024)).toFixed(0)} MB.`;
    case "unsupported-type":
      return "Unsupported image format. Send a JPEG, PNG, WebP or GIF.";
    case "invalid-image":
      return "That file is not a supported image.";
  }
}
