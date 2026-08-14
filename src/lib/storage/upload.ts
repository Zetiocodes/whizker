/**
 * Authenticated storage upload for encrypted blobs (Part 6).
 *
 * supabase-js's storage upload does not expose progress, so the blob is sent
 * with an XHR against the SAME Supabase Storage REST endpoint
 * (`POST /storage/v1/object/<bucket>/<path>`) that the typed client would use.
 * Authorization is the user's current anon-key session JWT, so every storage
 * policy on `storage.objects` applies exactly as if the typed client were used
 * — nothing is bypassed and no service-role credential ever reaches the
 * browser.
 *
 * Only ciphertext is uploaded: the body is `application/octet-stream` (never
 * `image/*`, so Storage never even believes it holds an image).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

/** The authenticated storage upload endpoint for a bucket + path. */
export function storageUploadEndpoint(supabaseUrl: string, bucket: string, path: string): string {
  const origin = new URL(supabaseUrl).origin;
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${origin}/storage/v1/object/${encodeURIComponent(bucket)}/${encoded}`;
}

/** User-facing upload failure categories. */
export type UploadErrorCode = "not-authenticated" | "upload-failed" | "network" | "timeout";

export class UploadError extends Error {
  readonly code: UploadErrorCode;

  constructor(code: UploadErrorCode, message = "Upload failed") {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

export async function uploadEncryptedBlob(params: {
  client: SupabaseClient<Database>;
  /** Public Supabase origin used to build the storage REST endpoint. */
  supabaseUrl: string;
  bucket: string;
  path: string;
  blob: Blob;
  onProgress?: (percent: number) => void;
  timeoutMs?: number;
}): Promise<void> {
  const { data: sessionData } = await params.client.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) {
    throw new UploadError("not-authenticated");
  }
  const url = storageUploadEndpoint(params.supabaseUrl, params.bucket, params.path);

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (params.timeoutMs) {
      xhr.timeout = params.timeoutMs;
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && params.onProgress) {
        params.onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new UploadError("upload-failed"));
      }
    };
    xhr.onerror = () => reject(new UploadError("network"));
    xhr.ontimeout = () => reject(new UploadError("timeout"));
    xhr.send(params.blob);
  });
}
