"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { appConfig } from "@/config";
import { decryptMessage, encryptMessage } from "@/lib/crypto/primitives";
import { base64UrlToBytes, type Bytes } from "@/lib/crypto/encode";
import { decryptImagePayload } from "@/lib/crypto/image";
import { validateImage, ImageValidationError, imageValidationMessage } from "@/lib/image/validation";
import { stripImageMetadata } from "@/lib/image/metadata";
import { buildAttachmentPath, formatBytes, prepareImageToSend } from "@/lib/image/pipeline";
import { createImagePreview, revokeImagePreview } from "@/lib/image/preview";
import { uploadEncryptedBlob } from "@/lib/storage/upload";
import { sortMessages } from "@/lib/chat/sort";
import { useRoomCrypto } from "@/hooks/use-room-crypto";
import { useRoomTyping } from "@/hooks/use-room-typing";
import { useMessageReceipts } from "@/hooks/use-message-receipts";
import { createClient } from "@/lib/supabase/client";
import { availabilityView } from "@/lib/realtime/status";
import type { RoomAvailability } from "@/lib/realtime/presence";
import type { MessageStatus, MessageType } from "@/types/message";
import { formatClockTime } from "@/lib/ui/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Icon } from "@/components/ui/icon";
import { Dialog } from "@/components/ui/dialog";
import { ChatHeader } from "@/components/rooms/chat-header";
import { EmojiPicker } from "@/components/rooms/emoji-picker";
import { ImageBubble, type ImageStage } from "@/components/rooms/image-bubble";

export interface ChatPanelProps {
  roomId: string;
  userId: string;
  participants: { userId: string; displayName: string }[];
  /** Room availability as derived by RoomShell (connection + peer presence). */
  availability: RoomAvailability;
  /** Other participant's display name, or null while the room is not full. */
  peerName: string | null;
  /** Room expiry (ISO), stamped on every attachment metadata row. */
  expiresAt: string;
  /** Shared browser client; a fresh one is created when omitted. */
  client?: SupabaseClient<Database>;
}

type MessageRow = {
  id: string;
  sender_id: string;
  type: MessageType;
  ciphertext: string;
  iv: string;
  status: MessageStatus;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
};

interface RenderedImage {
  attachmentId: string;
  mime: string | null;
  stage: ImageStage;
  /** Sender-only: decrypt the in-memory ciphertext instead of re-downloading. */
  local: { ciphertext: Bytes; iv: Bytes; mime: string } | null;
}

interface RenderedMessage {
  id: string;
  senderId: string;
  createdAt: string;
  status: MessageStatus;
  deliveredAt: string | null;
  readAt: string | null;
  type: MessageType;
  /** Decrypted text (text messages); null when decryption failed. */
  content: string | null;
  /** Image attachment state (image messages); null when the payload failed. */
  image: RenderedImage | null;
  /** Whether this message was actually rendered. */
  rendered: boolean;
}

interface PendingImage {
  /** Validated, metadata-stripped plaintext bytes (held only in memory). */
  bytes: Bytes;
  mime: string;
  sizeBytes: number;
  previewUrl: string;
}

/** Optimistic text message shown before the server confirms the insert. */
interface PendingText {
  id: string;
  content: string;
  createdAt: string;
  state: "sending" | "failed";
}

type HistoryState = "idle" | "loading" | "done" | "error";
type SendState = "idle" | "encrypting" | "uploading" | "inserting" | "error";

const STATUS_LABEL: Record<MessageStatus, string> = {
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
};

const DECRYPT_TEXT_ERROR = "Unable to decrypt this message.";

/**
 * Encrypted conversation panel (Part 5 + Part 6) with the Part 7 UI polish.
 *
 * Nothing here ever sends plaintext anywhere: text messages are sealed with
 * AES-256-GCM under the room DEK, and images are validated, stripped of
 * metadata and encrypted in the browser BEFORE the ciphertext blob is uploaded
 * to the private storage bucket. The server only ever receives ciphertext +
 * encrypted attachment pointers + message ids. Rows that fail to decrypt
 * render as error bubbles containing no content.
 *
 * On top of the Part 4 crypto this adds the realtime layer (Sent/Delivered/
 * Read, typing, availability) and image sharing: an attach button with local
 * preview, encrypt-then-upload with progress, realtime delivery, and
 * decrypt-on-view. Reconnecting and refreshing never destroy the room: the DEK
 * is restored from IndexedDB / `wrapped_key`, history is re-fetched, and the
 * UI recovers when the connection or the peer returns. Sent content is stored
 * as encrypted ciphertext (Supabase) for the room's 24-hour lifetime and is
 * never deleted merely because a participant went offline.
 */
export function ChatPanel({
  roomId,
  userId,
  participants,
  availability,
  peerName,
  expiresAt,
  client: clientProp,
}: ChatPanelProps) {
  const client = useMemo(() => clientProp ?? createClient(), [clientProp]);
  const { state: crypto, refresh } = useRoomCrypto({ client, roomId, userId, enabled: true });

  const peerUserId = useMemo(() => {
    if (participants.length < 2) {
      return null;
    }
    return participants.find((p) => p.userId !== userId)?.userId ?? null;
  }, [participants, userId]);

  const [messages, setMessages] = useState<RenderedMessage[]>([]);
  const [history, setHistory] = useState<HistoryState>("idle");
  const [pendingTexts, setPendingTexts] = useState<PendingText[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [sendState, setSendState] = useState<SendState>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string } | null>(null);

  const dekRef = useRef<Bytes | null>(null);
  useEffect(() => {
    dekRef.current = crypto.dek;
  }, [crypto.dek]);

  // Guards concurrent text sends (Enter + submit race). Images use `sending`.
  const textSendingRef = useRef(false);

  const pendingRef = useRef<PendingImage | null>(null);
  const updatePending = useCallback((next: PendingImage | null) => {
    if (pendingRef.current && pendingRef.current.previewUrl !== next?.previewUrl) {
      revokeImagePreview(pendingRef.current.previewUrl);
    }
    pendingRef.current = next;
    setPendingImage(next);
  }, []);
  // Revoke the preview object URL on unmount (browsers never reclaim them).
  useEffect(
    () => () => {
      if (pendingRef.current) {
        revokeImagePreview(pendingRef.current.previewUrl);
      }
    },
    [],
  );

  const seenIds = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const participantNames = useMemo(
    () => new Map(participants.map((p) => [p.userId, p.displayName])),
    [participants],
  );

  // Whether the recipient is actually looking at the conversation. Drives the
  // "read" receipts: never read merely for being online. Initialized false and
  // computed in an effect so the server and client first renders agree.
  const [viewing, setViewing] = useState(false);
  useEffect(() => {
    const update = () => {
      setViewing(document.visibilityState === "visible" && document.hasFocus());
    };
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);

  const ready = crypto.status === "ready" && crypto.dek !== null;
  const waiting = crypto.status === "awaiting-peer";
  const avail = availabilityView(availability, peerName);
  const imageEnabled = appConfig.featureFlags.imageSharingEnabled;

  const { peerTyping, notifyActivity, stopTyping } = useRoomTyping({
    client,
    roomId,
    userId,
    peerUserId,
    enabled: ready && avail.chatAvailable,
  });

  // Batch delivery/read receipts for received messages. Only ids cross the
  // wire; the server enforces that only the recipient can advance a message's
  // status (see migration 007). Image messages only count as "read" once the
  // image has actually been displayed (rendered), never merely downloaded.
  useMessageReceipts({
    client,
    roomId,
    userId,
    enabled: ready,
    viewing,
    messages: messages.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      status: m.status,
      rendered: m.rendered,
    })),
  });

  const markImageStage = useCallback((id: string, stage: ImageStage) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id && m.image
          ? { ...m, image: { ...m.image, stage }, rendered: stage === "ready" }
          : m,
      ),
    );
  }, []);

  const appendRow = useCallback(
    (row: MessageRow, opts?: { local?: { ciphertext: Bytes; iv: Bytes; mime: string } }) => {
      if (seenIds.current.has(row.id)) {
        return;
      }
      seenIds.current.add(row.id);
      const dek = dekRef.current;
      const push = (rendered: RenderedMessage) => {
        setMessages((prev) =>
          prev.some((m) => m.id === rendered.id) ? prev : [...prev, rendered],
        );
      };
      const base: RenderedMessage = {
        id: row.id,
        senderId: row.sender_id,
        createdAt: row.created_at,
        status: row.status,
        deliveredAt: row.delivered_at,
        readAt: row.read_at,
        type: row.type,
        content: null,
        image: null,
        rendered: true,
      };

      if (row.type === "image") {
        if (!dek) {
          push(base);
          return;
        }
        void decryptImagePayload(dek, roomId, { ciphertext: row.ciphertext, iv: row.iv })
          .then((payload) =>
            push({
              ...base,
              rendered: false,
              image: {
                attachmentId: payload.attachmentId,
                mime: opts?.local?.mime ?? null,
                stage: "loading",
                local: opts?.local ?? null,
              },
            }),
          )
          .catch(() => push(base));
        return;
      }

      if (!dek) {
        push(base);
        return;
      }
      void decryptMessage(dek, roomId, { ciphertext: row.ciphertext, iv: row.iv })
        .then((content) => push({ ...base, content }))
        .catch(() => push(base));
    },
    [roomId],
  );

  const loadHistory = useCallback(async () => {
    const dek = dekRef.current;
    if (!dek) {
      return;
    }
    setHistory("loading");
    const { data, error } = await client
      .from("messages")
      .select("id, sender_id, type, ciphertext, iv, status, created_at, delivered_at, read_at")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });
    if (error || !dekRef.current) {
      setHistory("error");
      return;
    }
    const rows = (data ?? []) as MessageRow[];
    for (const row of rows) {
      appendRow(row);
    }
    setHistory("done");
  }, [client, roomId, appendRow]);

  // Load history the moment the room DEK is available.
  useEffect(() => {
    if (crypto.status === "ready" && history === "idle") {
      void loadHistory();
    }
  }, [crypto.status, history, loadHistory]);

  // Realtime: new encrypted rows stream in and are decrypted locally; status
  // changes (delivered/read, set by the recipient via the receipt RPCs) update
  // the sender's copy in place. The payloads are ciphertext + status only —
  // never image bytes.
  useEffect(() => {
    const channel = client
      .channel(`messages:${roomId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `room_id=eq.${roomId}` },
        (payload) => {
          appendRow(payload.new as MessageRow);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages", filter: `room_id=eq.${roomId}` },
        (payload) => {
          const row = payload.new as MessageRow;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === row.id
                ? {
                    ...m,
                    status: row.status,
                    deliveredAt: row.delivered_at,
                    readAt: row.read_at,
                  }
                : m,
            ),
          );
        },
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [client, roomId, appendRow]);

  // Deterministic ordering regardless of arrival order.
  const orderedMessages = useMemo(() => sortMessages(messages), [messages]);

  // Auto-scroll to the newest content (history + optimistic messages).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [orderedMessages, pendingTexts]);

  // ---- Text sending with optimistic pending + failed/retry states ----

  const addPendingText = useCallback((content: string): string => {
    const id = `local-${globalThis.crypto.randomUUID()}`;
    setPendingTexts((prev) => [
      ...prev,
      { id, content, createdAt: new Date().toISOString(), state: "sending" },
    ]);
    return id;
  }, []);

  const updatePendingText = useCallback((id: string, patch: Partial<PendingText>) => {
    setPendingTexts((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const removePendingText = useCallback((id: string) => {
    setPendingTexts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const sendTextCore = useCallback(
    async (content: string, pendingId: string) => {
      const dek = dekRef.current;
      if (!dek) {
        updatePendingText(pendingId, { state: "failed" });
        return;
      }
      if (textSendingRef.current) {
        return;
      }
      textSendingRef.current = true;
      stopTyping();
      try {
        const envelope = await encryptMessage(dek, roomId, content);
        const { data, error } = await client
          .from("messages")
          .insert({
            room_id: roomId,
            sender_id: userId,
            type: "text",
            ciphertext: envelope.ciphertext,
            iv: envelope.iv,
            version: envelope.version,
          })
          .select("id, sender_id, type, ciphertext, iv, status, created_at, delivered_at, read_at")
          .single();
        if (error || !data) {
          throw error ?? new Error("no row returned");
        }
        setInputValue("");
        removePendingText(pendingId);
        appendRow(data as MessageRow);
      } catch {
        updatePendingText(pendingId, { state: "failed" });
      } finally {
        textSendingRef.current = false;
      }
    },
    [client, roomId, userId, appendRow, removePendingText, stopTyping, updatePendingText],
  );

  const handleSendText = useCallback(() => {
    const text = inputValue.trim();
    if (text.length === 0 || text.length > appConfig.limits.messageMaxLength) {
      return;
    }
    if (textSendingRef.current || sending) {
      return;
    }
    const pendingId = addPendingText(text);
    void sendTextCore(text, pendingId);
  }, [inputValue, sending, addPendingText, sendTextCore]);

  const retryPendingText = useCallback(
    (item: PendingText) => {
      updatePendingText(item.id, { state: "sending" });
      void sendTextCore(item.content, item.id);
    },
    [sendTextCore, updatePendingText],
  );

  // ---- Image sending ----

  const sendImage = useCallback(async () => {
    const pending = pendingRef.current;
    const dek = dekRef.current;
    if (!pending || !dek || sending || !avail.chatAvailable) {
      return;
    }
    setSending(true);
    setSendState("encrypting");
    setUploadProgress(0);
    setImageError(null);

    const messageId = globalThis.crypto.randomUUID();
    const attachmentId = globalThis.crypto.randomUUID();
    let path: string | null = null;
    try {
      const prepared = await prepareImageToSend({
        dek,
        roomId,
        messageId,
        attachmentId,
        plainBytes: pending.bytes,
        mime: pending.mime,
      });
      path = buildAttachmentPath(roomId, attachmentId);

      // Upload ONLY the ciphertext blob; the plaintext image never leaves this
      // browser.
      setSendState("uploading");
      await uploadEncryptedBlob({
        client,
        supabaseUrl: appConfig.supabase.url,
        bucket: appConfig.supabase.storageBucket,
        path,
        blob: prepared.blob,
        onProgress: setUploadProgress,
      });

      setSendState("inserting");

      // Order matters (Part 8 hardening): the attachments INSERT policy now
      // requires the referenced messages row to already exist (same room,
      // sender-owned, type image), so the messages row is created FIRST and
      // the attachments row second. Realtime notifies the peer on the messages
      // insert; the peer's image bubble tolerates the few-ms window before the
      // attachment row commits (see image-bubble retry).
      const { data, error } = await client
        .from("messages")
        .insert({
          id: messageId,
          room_id: roomId,
          sender_id: userId,
          type: "image",
          ciphertext: prepared.payload.ciphertext,
          iv: prepared.payload.iv,
          version: prepared.payload.version,
        })
        .select("id, sender_id, type, ciphertext, iv, status, created_at, delivered_at, read_at")
        .single();
      if (error || !data) {
        throw error ?? new Error("no row returned");
      }

      const { error: attachmentError } = await client.from("attachments").insert({
        id: attachmentId,
        room_id: roomId,
        message_id: messageId,
        sender_id: userId,
        storage_path: path,
        mime_type: pending.mime,
        size_bytes: prepared.sizeBytes,
        iv: prepared.ivB64,
        version: prepared.payload.version,
        expires_at: expiresAt,
      });
      if (attachmentError) {
        throw attachmentError;
      }

      // Render the sender's copy straight from the in-memory ciphertext.
      appendRow(data as MessageRow, {
        local: {
          ciphertext: prepared.ciphertext,
          iv: base64UrlToBytes(prepared.ivB64),
          mime: pending.mime,
        },
      });
      updatePending(null);
    } catch {
      // Best-effort: remove the just-uploaded blob. Clients have no storage
      // DELETE policy, so on failure the orphan is swept by the hourly purge.
      // If the messages row was already inserted before the attachment step
      // failed, that row survives as a broken image ("no longer available")
      // until the 24h purge — clients deliberately have no delete path, and
      // the sender's copy is already shown as failed.
      if (path) {
        try {
          await client.storage.from(appConfig.supabase.storageBucket).remove([path]);
        } catch {
          // Ignore: purge_expired_rooms cleanup is authoritative.
        }
      }
      setSendState("error");
    } finally {
      setSending(false);
    }
  }, [avail.chatAvailable, client, expiresAt, roomId, userId, sending, appendRow, updatePending]);

  const onFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) {
        return;
      }
      setImageError(null);
      try {
        // The generic `Uint8Array(buffer)` overload types the result as
        // `Uint8Array<ArrayBufferLike>`; narrow it to the crypto `Bytes` type.
        const raw = new Uint8Array(await file.arrayBuffer()) as Bytes;
        // Validate by magic bytes (never the browser MIME alone) and reject
        // oversized files before any expensive work.
        const validated = validateImage(file, raw, appConfig.image);
        // Strip EXIF/GPS metadata locally, before encryption.
        const stripped = stripImageMetadata(raw, validated.mime);
        updatePending({
          bytes: stripped,
          mime: validated.mime,
          sizeBytes: stripped.length,
          previewUrl: createImagePreview(new Blob([stripped], { type: validated.mime })),
        });
      } catch (error) {
        if (error instanceof ImageValidationError) {
          setImageError(imageValidationMessage(error.code, appConfig.image.maxBytes));
        } else {
          setImageError("That file could not be read.");
        }
      }
    },
    [updatePending],
  );

  const cancelPendingImage = useCallback(() => {
    if (sending) {
      return;
    }
    updatePending(null);
    setSendState("idle");
    setImageError(null);
  }, [sending, updatePending]);

  // Ephemeral typing: never published for a disabled composer, and cleared on
  // unmount so a navigated-away tab cannot leave a stale indicator behind.
  useEffect(() => () => stopTyping(), [stopTyping]);

  const insertEmoji = useCallback(
    (emoji: string) => {
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? inputValue.length;
      const end = textarea?.selectionEnd ?? inputValue.length;
      const next = inputValue.slice(0, start) + emoji + inputValue.slice(end);
      setInputValue(next);
      notifyActivity();
      window.requestAnimationFrame(() => {
        if (textarea) {
          textarea.focus();
          const position = start + emoji.length;
          textarea.setSelectionRange(position, position);
        }
      });
    },
    [inputValue, notifyActivity],
  );

  const onComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter and IME composition insert a newline.
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (!textSendingRef.current && !sending && inputValue.trim().length > 0) {
          handleSendText();
        }
      }
    },
    [inputValue, sending, handleSendText],
  );

  const composerDisabled = !ready || !avail.chatAvailable;
  const hasImage = pendingImage !== null;
  const canSend = !composerDisabled && !sending && (inputValue.trim().length > 0 || hasImage);
  const sendingLabel =
    sendState === "encrypting"
      ? "Encrypting…"
      : sendState === "uploading"
        ? `Uploading ${uploadProgress}%`
        : sendState === "inserting"
          ? "Saving…"
          : "Sending…";

  // Offline/availability banners. The text is honest about the storage model:
  // messages are end-to-end encrypted, their ciphertext is temporarily stored
  // (Supabase) and delivered later, and everything is destroyed when the room
  // expires after 24 hours. We never claim content is "stored only on your
  // device" — the server does hold encrypted ciphertext for the room lifetime.
  const banner: { tone: "muted" | "warning"; text: string } | null = (() => {
    if (availability === "reconnecting") {
      return {
        tone: "warning",
        text: "Connection lost. Reconnecting — sent messages are stored as encrypted ciphertext and delivered when the connection returns.",
      };
    }
    if (availability === "peer-offline") {
      return {
        tone: "warning",
        text: `${peerName ?? "The other person"} is offline. Messages you send are end-to-end encrypted and will be delivered when they return.`,
      };
    }
    if (availability === "peer-away") {
      return {
        tone: "warning",
        text: `${peerName ?? "The other person"} dropped off for a moment — they'll catch up when they're back.`,
      };
    }
    if (availability === "waiting-for-peer") {
      return {
        tone: "muted",
        text: "Waiting for the other person to join. Messages you send are end-to-end encrypted and stored until this room expires in 24 hours.",
      };
    }
    return null;
  })();

  return (
    <div className="flex h-full flex-col">
      <ChatHeader peerName={peerName} avail={avail} encrypted={ready} expiresAt={expiresAt} />

      <div className="flex min-h-0 flex-1 flex-col">
        {banner ? (
          <div
            role="status"
            className={cn(
              "flex items-center gap-2 border-b px-4 py-2 text-xs",
              banner.tone === "warning"
                ? "border-warning/20 bg-warning/10 text-warning"
                : "border-border bg-surface-raised text-muted",
            )}
          >
            <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
            {banner.text}
          </div>
        ) : null}

        {crypto.error ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 text-center shadow-card">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-danger/10 text-danger">
                <Icon name="alert" className="h-5 w-5" />
              </span>
              <p className="mt-3 text-sm font-medium">Encryption setup failed</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{crypto.error}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-4"
                onClick={() => void refresh()}
              >
                Try again
              </Button>
            </div>
          </div>
        ) : waiting ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-sm text-center">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Icon name="key" className="h-5 w-5" />
              </span>
              <p className="mt-3 text-sm font-medium">Setting up end-to-end encryption</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                The conversation unlocks automatically when the other person
                joins the room.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Message stream */}
            <div
              ref={scrollRef}
              className="flex-1 space-y-3 overflow-y-auto px-3 py-4 lg:px-5"
            >
              {history === "error" ? (
                <div className="flex flex-col items-center gap-3 py-10 text-center">
                  <Icon name="alert" className="h-6 w-6 text-muted" />
                  <p className="text-sm text-muted">Could not load previous messages.</p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void loadHistory()}
                  >
                    Retry
                  </Button>
                </div>
              ) : history === "loading" && orderedMessages.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
                  <Spinner className="h-4 w-4" />
                  Loading messages…
                </div>
              ) : orderedMessages.length === 0 && pendingTexts.length === 0 && history === "done" ? (
                <div className="flex flex-col items-center gap-2 py-12 text-center">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-raised text-muted">
                    <Icon name="chat" className="h-5 w-5" />
                  </span>
                  <p className="text-sm text-muted">No messages yet.</p>
                  <p className="text-xs text-muted">
                    Say hello — the conversation is end-to-end encrypted.
                  </p>
                </div>
              ) : (
                <>
                  {orderedMessages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isOwn={message.senderId === userId}
                      peerName={
                        participantNames.get(message.senderId) ?? "Someone"
                      }
                      participantCount={participants.length}
                      renderImage={(m) =>
                        m.image && crypto.dek ? (
                          <ImageBubble
                            client={client}
                            dek={crypto.dek}
                            roomId={roomId}
                            messageId={m.id}
                            attachmentId={m.image.attachmentId}
                            mime={m.image.mime}
                            local={m.image.local}
                            onStageChange={(stage) => markImageStage(m.id, stage)}
                            onExpand={(url) => setLightbox({ url })}
                          />
                        ) : (
                          <p className="text-xs">Unable to decrypt this image.</p>
                        )
                      }
                    />
                  ))}

                  {pendingTexts.map((item) => (
                    <div
                      key={item.id}
                      className="flex justify-end animate-message-in"
                    >
                      <div
                        className={cn(
                          "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm",
                          item.state === "failed"
                            ? "rounded-br-sm border border-danger/40 bg-danger/20 text-danger"
                            : "rounded-br-sm bg-bubble-own text-foreground",
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">{item.content}</p>
                        <p className="mt-0.5 flex items-center justify-end gap-1.5 text-[10px] leading-none text-muted">
                          {item.state === "failed" ? (
                            <>
                              <span className="text-danger">Failed to send</span>
                              <button
                                type="button"
                                className="font-medium text-danger underline hover:no-underline"
                                onClick={() => retryPendingText(item)}
                              >
                                Retry
                              </button>
                              <button
                                type="button"
                                className="font-medium text-muted underline hover:no-underline"
                                aria-label="Discard message"
                                onClick={() => removePendingText(item.id)}
                              >
                                Discard
                              </button>
                            </>
                          ) : (
                            <>
                              <Spinner className="h-2.5 w-2.5" />
                              <span>Sending…</span>
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>

            {peerTyping && avail.chatAvailable && (
              <div className="flex items-center gap-2 px-3 pb-1 text-xs text-muted lg:px-5">
                <span aria-hidden="true" className="flex items-end gap-0.5">
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
                </span>
                <span role="status">
                  {peerName ?? "Someone"} is typing…
                </span>
              </div>
            )}

            {/* Composer */}
            <div className="shrink-0 border-t border-border bg-background px-3 py-3 lg:px-5">
              <form
                className="mx-auto max-w-3xl"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (pendingRef.current) {
                    void sendImage();
                  } else if (inputValue.trim().length > 0) {
                    handleSendText();
                  }
                }}
              >
                {imageEnabled && (
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={appConfig.image.accept}
                    className="hidden"
                    onChange={onFileSelected}
                    disabled={composerDisabled || sending}
                  />
                )}

                {imageEnabled && hasImage && pendingImage && (
                  <div className="mb-2 flex items-center gap-3 rounded-xl border border-border bg-surface-raised p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element -- in-memory preview blob */}
                    <img
                      src={pendingImage.previewUrl}
                      alt="Image preview"
                      className="h-14 w-14 shrink-0 rounded-lg object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-foreground">Image ready to send</p>
                      <p className="text-[10px] text-muted">
                        {formatBytes(pendingImage.sizeBytes)} · {pendingImage.mime}
                      </p>
                      {sending && (
                        <p className="mt-1 text-[10px] text-muted" role="status">
                          {sendingLabel}
                        </p>
                      )}
                      {sending && sendState === "uploading" && (
                        <div
                          className="mt-1 h-1 w-full overflow-hidden rounded bg-surface-overlay"
                          role="progressbar"
                          aria-valuenow={uploadProgress}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label="Upload progress"
                        >
                          <div
                            className="h-full rounded bg-accent transition-[width]"
                            style={{ width: `${uploadProgress}%` }}
                          />
                        </div>
                      )}
                      {!sending && sendState === "error" && (
                        <p className="text-[10px] text-danger">
                          Could not send the image. Check your connection and try again.
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={cancelPendingImage}
                      disabled={sending}
                      aria-label="Remove image"
                    >
                      <Icon name="x" className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                <div className="flex items-end gap-2">
                  {imageEnabled && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={composerDisabled || sending || hasImage}
                      title="Attach an image"
                      aria-label="Attach an image"
                    >
                      <Icon name="image" className="h-4 w-4" />
                    </Button>
                  )}
                  <EmojiPicker onPick={insertEmoji} disabled={composerDisabled || sending} />
                  <textarea
                    ref={textareaRef}
                    value={inputValue}
                    onChange={(event) => {
                      setInputValue(event.target.value);
                      notifyActivity();
                    }}
                    onBlur={stopTyping}
                    onFocus={() => {
                      // Bring the composer above the on-screen keyboard.
                      textareaRef.current?.scrollIntoView({ block: "nearest" });
                    }}
                    onKeyDown={onComposerKeyDown}
                    maxLength={appConfig.limits.messageMaxLength}
                    rows={1}
                    className="field-sizing-content max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
                    placeholder={
                      avail.chatAvailable ? "Write a message…" : "Chat is unavailable"
                    }
                    disabled={composerDisabled || sending || hasImage}
                    aria-label="Message"
                  />
                  <Button
                    type="submit"
                    disabled={!canSend}
                    className="h-10 shrink-0"
                    aria-label={hasImage ? "Send image" : "Send message"}
                  >
                    {sending ? (
                      <Spinner className="h-4 w-4" />
                    ) : (
                      <Icon name="send" className="h-4 w-4" />
                    )}
                    <span className="hidden sm:inline">{sending ? sendingLabel : "Send"}</span>
                  </Button>
                </div>

                {imageError ? (
                  <p className="mt-2 text-xs text-danger" role="alert">
                    {imageError}
                  </p>
                ) : null}
                {!avail.chatAvailable && banner === null && !waiting && !crypto.error ? (
                  <p className="mt-2 text-xs text-muted">{avail.detail}</p>
                ) : null}
              </form>
            </div>
          </>
        )}
      </div>

      <Dialog
        open={lightbox !== null}
        onClose={() => setLightbox(null)}
        title="Image"
        size="lg"
      >
        {lightbox ? (
          <div className="flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- decrypted blob object URL */}
            <img
              src={lightbox.url}
              alt="Shared image"
              className="max-h-[70vh] w-auto max-w-full rounded-xl object-contain"
            />
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

interface MessageBubbleProps {
  message: RenderedMessage;
  isOwn: boolean;
  peerName: string;
  participantCount: number;
  renderImage: (message: RenderedMessage) => ReactNode;
}

function MessageBubble({
  message,
  isOwn,
  peerName,
  participantCount,
  renderImage,
}: MessageBubbleProps) {
  const undecryptable = message.content === null && message.image === null;

  return (
    <div
      className={cn("flex animate-message-in", isOwn ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm sm:max-w-[75%]",
          isOwn ? "rounded-br-sm bg-accent text-white" : "rounded-bl-sm bg-surface-raised text-foreground",
          undecryptable &&
            (isOwn
              ? "border border-danger/40 bg-danger/20 text-danger"
              : "border border-danger/30 bg-danger/10 text-danger"),
        )}
      >
        {!isOwn && participantCount > 1 && (
          <p className="mb-0.5 truncate text-xs font-medium text-muted">
            {peerName}
          </p>
        )}
        {message.type === "image" ? (
          message.image ? (
            renderImage(message)
          ) : (
            <p className="flex items-center gap-1.5 text-xs">
              <Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
              Unable to decrypt this image.
            </p>
          )
        ) : (
          <p className="whitespace-pre-wrap break-words">
            {message.content ?? DECRYPT_TEXT_ERROR}
          </p>
        )}
        <p
          className={cn(
            "mt-0.5 text-right text-[10px] leading-none",
            isOwn ? "text-white/70" : "text-muted",
          )}
        >
          <time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>
          {isOwn && (
            <span
              className={cn(
                "ml-1.5",
                message.status === "read" && "font-medium text-white",
              )}
            >
              {STATUS_LABEL[message.status]}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
