import { describe, expect, it } from "vitest";
import {
  GIF_87A_MAGIC,
  ImageValidationError,
  imageValidationMessage,
  JPEG_MAGIC,
  PNG_MAGIC,
  sniffImageMime,
  validateImage,
} from "@/lib/image/validation";

const LIMITS = { maxBytes: 1024, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] } as const;

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function imageWithMime(mime: string): Uint8Array {
  switch (mime) {
    case "image/jpeg":
      return bytesOf(...JPEG_MAGIC, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00);
    case "image/png":
      return bytesOf(...PNG_MAGIC, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52);
    case "image/gif":
      return bytesOf(...GIF_87A_MAGIC, 0x01, 0x00, 0x01, 0x00);
    case "image/webp":
      return bytesOf(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
    default:
      return bytesOf(0x00, 0x01, 0x02);
  }
}

const FILE = { name: "photo.jpg", size: 0, type: "image/jpeg" };

describe("sniffImageMime", () => {
  it("detects JPEG, PNG, GIF87a and GIF89a by magic bytes", () => {
    expect(sniffImageMime(imageWithMime("image/jpeg"))).toBe("image/jpeg");
    expect(sniffImageMime(imageWithMime("image/png"))).toBe("image/png");
    expect(sniffImageMime(imageWithMime("image/gif"))).toBe("image/gif");
    expect(sniffImageMime(bytesOf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00))).toBe("image/gif");
  });

  it("detects WebP only with a complete RIFF+WEBP header", () => {
    expect(sniffImageMime(imageWithMime("image/webp"))).toBe("image/webp");
    expect(sniffImageMime(bytesOf(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00))).toBeNull();
  });

  it("returns null for non-images and truncated headers", () => {
    expect(sniffImageMime(bytesOf())).toBeNull();
    expect(sniffImageMime(bytesOf(0x52, 0x49, 0x46, 0x46))).toBeNull();
    expect(sniffImageMime(bytesOf(...JPEG_MAGIC.slice(0, 2)))).toBeNull();
  });
});

describe("validateImage", () => {
  it("accepts an in-limit supported image and returns the sniffed mime", () => {
    const bytes = imageWithMime("image/jpeg");
    const file = { ...FILE, size: bytes.length };
    expect(validateImage(file, bytes, LIMITS)).toEqual({ mime: "image/jpeg", sizeBytes: bytes.length });
  });

  it("rejects oversized files even when the File reports a smaller size", () => {
    const bytes = new Uint8Array(2048);
    expect(() => validateImage({ ...FILE, size: 10 }, bytes, LIMITS)).toThrow(ImageValidationError);
  });

  it("rejects a File that claims to be larger than the limit", () => {
    expect(() => validateImage({ ...FILE, size: 4096 }, bytesOf(...JPEG_MAGIC), LIMITS)).toThrow(ImageValidationError);
  });

  it("rejects non-images by magic bytes, ignoring the declared type", () => {
    const bytes = bytesOf(0x4d, 0x5a, 0x90, 0x00);
    expect(() => validateImage({ ...FILE, type: "image/jpeg" }, bytes, LIMITS)).toThrow(ImageValidationError);
  });

  it("rejects supported-by-magic formats outside the allow-list", () => {
    // GIF magic, but the allow-list has no gif.
    const bytes = imageWithMime("image/gif");
    expect(() => validateImage({ ...FILE, type: "image/gif" }, bytes, LIMITS)).toThrow(ImageValidationError);
  });

  it("throws ImageValidationError with a stable code for each rejection", () => {
    try {
      validateImage(FILE, new Uint8Array(8192), LIMITS);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ImageValidationError);
      expect((error as ImageValidationError).code).toBe("too-large");
    }
    try {
      validateImage(FILE, bytesOf(0x01, 0x02, 0x03), LIMITS);
      expect.unreachable();
    } catch (error) {
      expect((error as ImageValidationError).code).toBe("invalid-image");
    }
    try {
      validateImage(FILE, imageWithMime("image/gif"), LIMITS);
      expect.unreachable();
    } catch (error) {
      expect((error as ImageValidationError).code).toBe("unsupported-type");
    }
  });
});

describe("imageValidationMessage", () => {
  it("renders a human message per error code", () => {
    expect(imageValidationMessage("too-large", 8 * 1024 * 1024)).toContain("8 MB");
    expect(imageValidationMessage("unsupported-type", 0)).toContain("JPEG, PNG, WebP or GIF");
    expect(imageValidationMessage("invalid-image", 0)).toContain("not a supported image");
  });
});
