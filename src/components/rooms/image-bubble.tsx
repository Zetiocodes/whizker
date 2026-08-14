"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import type { Bytes } from "@/lib/crypto/encode";
import { base64UrlToBytes } from "@/lib/crypto/encode";
import { decryptImageBlob } from "@/lib/crypto/image";
import { appConfig } from "@/config";
import { Icon } from "@/components/ui/icon";

export type ImageStage = "loading" | "ready" | "error";

export interface ImageBubbleProps {
  client: SupabaseClient<Database>;
  /** The room DEK. Non-null: the bubble only mounts once the room is ready. */
  dek: Bytes;
  roomId: string;
  messageId: string;
  /** Attachment id from the decrypted image message payload. */
  attachmentId: string;
  /** Known MIME type (own messages know it immediately). */
  mime: string | null;
  /**
   * For the SENDER's own just-sent images: the ciphertext + IV already in
   * memory, so the bubble decrypts locally instead of re-downloading the blob.
   * Peer images pass null and go through authenticated storage retrieval.
   */
  local?: { ciphertext: Bytes; iv: Bytes; mime: string } | null;
  /** Reports the display stage up so the parent can drive read receipts. */
  onStageChange: (stage: ImageStage) => void;
  /** Opens the full-size lightbox with the displayed object URL. */
  onExpand: (url: string) => void;
}

const DECRYPT_ERROR = "Unable to decrypt this image.";
const UNAVAILABLE_ERROR = "This image is no longer available.";

/**
 * The sender creates the messages row before the attachments row (the RLS
 * INSERT policy requires the message to exist). Realtime can deliver the
 * message INSERT to the peer a few ms before the attachment row commits, so
 * the attachment fetch is retried briefly before giving up.
 */
const ATTACHMENT_ROW_RETRIES = 8;
const ATTACHMENT_ROW_RETRY_DELAY_MS = 400;

/**
 * Renders one encrypted image message: downloads the ciphertext blob through
 * the authenticated (RLS-scoped) storage API, decrypts it locally with the
 * room DEK and shows the result. The image bytes are only ever materialized on
 * the viewing device; the blob object URL is revoked on unmount and the
 * displayed image expands into a full-screen lightbox via `onExpand`.
 *
 * Only the message *id* and attachment *id* travel through realtime/DB; the
 * storage path is fetched from the attachment row the recipient can see, and
 * the blob is never referenced by a public URL.
 */
export function ImageBubble({
  client,
  dek,
  roomId,
  messageId,
  attachmentId,
  mime: knownMime,
  local,
  onStageChange,
  onExpand,
}: ImageBubbleProps) {
  const [stage, setStage] = useState<ImageStage>("loading");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const report = useCallback(
    (next: ImageStage) => {
      setStage(next);
      onStageChange(next);
    },
    [onStageChange],
  );

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    const load = async () => {
      let ciphertext: Bytes;
      let iv: Bytes;
      let mime: string;

      try {
        if (local?.ciphertext && local.iv) {
          // Own message: decrypt the in-memory ciphertext (no re-download).
          ciphertext = local.ciphertext;
          iv = local.iv;
          mime = local.mime;
        } else {
          // Fetch the attachment row the recipient is allowed to see, then the
          // blob. The row must match the decrypted payload's attachment id and
          // this message id, so a swapped-in attachment is rejected. Retry
          // briefly because the sender inserts the messages row first and the
          // realtime notification can beat the attachment row's commit.
          let attachment: {
            storage_path: string;
            iv: string;
            mime_type: string;
            size_bytes: number;
          } | null = null;
          for (let attempt = 0; attempt < ATTACHMENT_ROW_RETRIES; attempt++) {
            const { data, error: rowError } = await client
              .from("attachments")
              .select("storage_path, iv, mime_type, size_bytes")
              .eq("id", attachmentId)
              .eq("message_id", messageId)
              .maybeSingle();
            if (cancelled) {
              return;
            }
            if (rowError) {
              throw new Error("attachment row unavailable");
            }
            if (data) {
              attachment = data;
              break;
            }
            await new Promise((resolve) =>
              setTimeout(resolve, ATTACHMENT_ROW_RETRY_DELAY_MS),
            );
          }
          if (!attachment) {
            throw new Error("attachment row unavailable");
          }
          const { data: blob, error: downloadError } = await client.storage
            .from(appConfig.supabase.storageBucket)
            .download(attachment.storage_path);
          if (cancelled) {
            return;
          }
          if (downloadError || !blob) {
            throw new Error("download failed");
          }
          if (blob.size !== attachment.size_bytes) {
            throw new Error("size mismatch");
          }
          ciphertext = new Uint8Array(await blob.arrayBuffer());
          iv = base64UrlToBytes(attachment.iv);
          mime = attachment.mime_type;
        }
      } catch {
        if (!cancelled) {
          setError(UNAVAILABLE_ERROR);
          report("error");
        }
        return;
      }

      try {
        const plain = await decryptImageBlob(dek, roomId, messageId, attachmentId, ciphertext, iv);
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([plain], { type: mime ?? "image/jpeg" }));
        setUrl(objectUrl);
        report("ready");
      } catch {
        if (!cancelled) {
          setError(DECRYPT_ERROR);
          report("error");
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [client, dek, roomId, messageId, attachmentId, local, report, attempt]);

  if (stage === "error") {
    return (
      <div className="flex flex-col items-start gap-2 py-1">
        <p className="flex items-center gap-1.5 text-xs">
          <Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
        <button
          type="button"
          className="focus-ring rounded bg-surface-overlay px-2 py-1 text-xs text-muted hover:text-foreground"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </button>
      </div>
    );
  }

  if (stage === "ready" && url) {
    return (
      <button
        type="button"
        onClick={() => onExpand(url)}
        className="group relative block overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="View image full size"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- decrypted blob object URL */}
        <img
          src={url}
          alt="Shared image"
          className="max-h-80 max-w-full rounded-lg object-contain transition-transform group-hover:scale-[1.01]"
        />
        <span
          aria-hidden="true"
          className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/40 group-hover:flex group-focus-visible:flex"
        >
          <Icon name="external" className="h-5 w-5 text-white" />
        </span>
      </button>
    );
  }

  return (
    <div className="flex h-32 w-32 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface-overlay">
      <span
        aria-hidden="true"
        className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent"
      />
      <span className="text-xs text-muted">
        {knownMime ? "Decrypting image…" : "Loading image…"}
      </span>
    </div>
  );
}
