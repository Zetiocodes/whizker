import { describe, expect, it } from "vitest";
import { createImagePreview, revokeImagePreview, type UrlApi } from "@/lib/image/preview";

function fakeUrlApi(): { api: UrlApi; created: string[]; revoked: string[] } {
  const created: string[] = [];
  const revoked: string[] = [];
  const api: UrlApi = {
    createObjectURL: () => {
      const url = `blob:mock/${created.length + 1}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
  };
  return { api, created, revoked };
}

const blob = new Blob(["x"], { type: "image/jpeg" });

describe("createImagePreview", () => {
  it("creates an object URL for the blob", () => {
    const { api, created } = fakeUrlApi();
    const url = createImagePreview(blob, api);
    expect(url).toBe("blob:mock/1");
    expect(created).toHaveLength(1);
  });
});

describe("revokeImagePreview", () => {
  it("revokes a created URL", () => {
    const { api, revoked } = fakeUrlApi();
    const url = createImagePreview(blob, api);
    revokeImagePreview(url, api);
    expect(revoked).toEqual([url]);
  });

  it("is a no-op for null / undefined / empty", () => {
    const { api, revoked } = fakeUrlApi();
    revokeImagePreview(null, api);
    revokeImagePreview(undefined, api);
    revokeImagePreview("", api);
    expect(revoked).toEqual([]);
  });
});
