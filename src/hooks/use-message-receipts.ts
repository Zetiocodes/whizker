"use client";

import { useCallback, useEffect, useRef } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { appConfig } from "@/config";
import { ReceiptBatcher } from "@/lib/realtime/receipts";
import type { MessageStatus } from "@/types/message";

/** The minimal message view the receipts hook needs from the chat panel. */
export interface ReceiptMessage {
  id: string;
  senderId: string;
  status: MessageStatus;
  /** False for image messages that have not been displayed yet. */
  rendered: boolean;
}

/**
 * Batches delivery/read receipts for the messages the caller RECEIVED and
 * pushes them through `mark_messages_delivered` / `mark_messages_read` (see
 * migration 007). Design constraints this honors:
 *
 * - Receipts are batched: one DB write per status per debounce window, never
 *   one write per message (`ReceiptBatcher` dedupes what was already sent).
 * - Only the recipient's client ever sends receipts, and only for messages it
 *   received; the server enforces the same boundary, so nobody can forge
 *   another user's receipts.
 * - "Read" is collected only while `viewing` (the conversation is visible and
 *   focused); otherwise only "delivered" is collected. A message merely
 *   delivered is re-collected for "read" the moment the recipient is looking
 *   again.
 * - Flushes are debounced and also run immediately when the tab loses
 *   visibility or focus, so receipts never stall. Only ids cross the wire —
 *   no content, no plaintext.
 */
export function useMessageReceipts(params: {
  client: SupabaseClient<Database>;
  roomId: string;
  userId: string;
  messages: ReceiptMessage[];
  viewing: boolean;
  enabled: boolean;
}): void {
  const { client, roomId, userId, messages, viewing, enabled } = params;

  const batcherRef = useRef<ReceiptBatcher | null>(null);
  if (batcherRef.current === null) {
    batcherRef.current = new ReceiptBatcher(userId);
  }

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const viewingRef = useRef(viewing);
  useEffect(() => {
    viewingRef.current = viewing;
  }, [viewing]);

  const flush = useCallback(async () => {
    if (!enabled) {
      return;
    }
    const batcher = batcherRef.current;
    if (batcher === null) {
      return;
    }
    const rows = messagesRef.current;
    const { delivered, read } = batcher.compute(rows, viewingRef.current);    batcher.prune(rows);
    if (delivered.length === 0 && read.length === 0) {
      return;
    }
    batcher.commit(delivered, read);

    const calls: Array<PromiseLike<unknown>> = [];
    if (delivered.length > 0) {
      calls.push(client.rpc("mark_messages_delivered", { p_room: roomId, p_message_ids: delivered }));
    }
    if (read.length > 0) {
      calls.push(client.rpc("mark_messages_read", { p_room: roomId, p_message_ids: read }));
    }
    await Promise.all(calls).catch(() => undefined);
  }, [client, enabled, roomId]);

  // Debounced flush whenever the message list or the viewing state changes.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const delay = viewing ? appConfig.realtime.readBatchMs : appConfig.realtime.deliveredBatchMs;
    const timer = window.setTimeout(() => void flush(), delay);
    return () => window.clearTimeout(timer);
  }, [enabled, flush, messages, viewing]);

  // Flush promptly when the tab loses visibility/focus (receipts must not
  // stall just because the user switched away), and on refocus so "read" is
  // re-collected the moment the recipient is looking again.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handle = () => void flush();
    document.addEventListener("visibilitychange", handle);
    window.addEventListener("blur", handle);
    window.addEventListener("focus", handle);
    return () => {
      document.removeEventListener("visibilitychange", handle);
      window.removeEventListener("blur", handle);
      window.removeEventListener("focus", handle);
    };
  }, [enabled, flush]);
}
