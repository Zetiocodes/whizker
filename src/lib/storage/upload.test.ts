import { describe, expect, it } from "vitest";
import { storageUploadEndpoint, UploadError } from "@/lib/storage/upload";

describe("storageUploadEndpoint", () => {
  it("builds the object upload URL from origin + bucket + path", () => {
    const url = storageUploadEndpoint(
      "https://project.supabase.co",
      "encrypted-attachments",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/77777777-8888-4999-8aaa-bbbbbbbbbbbb.bin",
    );
    expect(url).toBe(
      "https://project.supabase.co/storage/v1/object/encrypted-attachments/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/77777777-8888-4999-8aaa-bbbbbbbbbbbb.bin",
    );
  });

  it("uses only the origin, dropping any URL path", () => {
    const url = storageUploadEndpoint("https://project.supabase.co/path/to/proxy", "b", "a/x.bin");
    expect(url.startsWith("https://project.supabase.co/storage/")).toBe(true);
  });

  it("percent-encodes bucket and path segments", () => {
    const url = storageUploadEndpoint("https://p.supabase.co", "my bucket", "room id/x.bin");
    expect(url).toBe("https://p.supabase.co/storage/v1/object/my%20bucket/room%20id/x.bin");
  });
});

describe("UploadError", () => {
  it("carries a stable machine-readable code", () => {
    const error = new UploadError("network", "boom");
    expect(error.code).toBe("network");
    expect(error.message).toBe("boom");
    expect(error.name).toBe("UploadError");
  });
});
