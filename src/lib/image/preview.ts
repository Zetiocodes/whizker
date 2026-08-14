/**
 * Local image preview management (Part 6).
 *
 * Previews use object URLs (never the raw File, never a server round trip).
 * URL creation/revocation is injected so the lifecycle is unit-testable and so
 * the caller can be sure every preview is revoked (browsers do not reclaim
 * object URLs automatically).
 */

export interface UrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

const browserUrlApi: UrlApi = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

/**
 * Create a preview object URL for a local blob. The caller must later call
 * {@link revokeImagePreview} — including on component unmount.
 */
export function createImagePreview(blob: Blob, api: UrlApi = browserUrlApi): string {
  return api.createObjectURL(blob);
}

/** Revoke a preview object URL (null-safe, idempotent via the URL API). */
export function revokeImagePreview(url: string | null | undefined, api: UrlApi = browserUrlApi): void {
  if (url) {
    api.revokeObjectURL(url);
  }
}
