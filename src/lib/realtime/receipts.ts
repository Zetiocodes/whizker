/**
 * Pure read-receipt batching (Part 5).
 *
 * Delivery/read receipts must never be a per-message write and must never be
 * forgeable:
 * - The RECIPIENT is the only actor allowed to advance a message's status
 *   (enforced server-side by `mark_messages_delivered` / `mark_messages_read`
 *   — see migration 007), so a participant can never fabricate the other
 *   side's receipts. The batcher here only ever collects messages where
 *   `senderId !== myUserId`.
 * - Batches are computed from the current view of the message list and flushed
 *   in ONE write per status. `ReceiptBatcher` tracks what has already been
 *   sent so a flush never re-sends the same id, and prunes state once a
 *   message is fully `read` (keeps memory bounded).
 * - "Read" is only collected while the recipient is actually viewing the
 *   conversation (`viewing: true`); otherwise only "delivered" is collected.
 *   A message that was merely delivered is collected for "read" the moment the
 *   viewer is looking again. `read` always implies `delivered`, so a message
 *   is never collected for both at once.
 *
 * Only message ids and room state pass through here — no content ever.
 */

import type { MessageStatus } from "@/types/message";

/**
 * The minimal view of a message the batcher needs.
 */
export interface ReceiptCandidate {
  id: string;
  senderId: string;
  status: MessageStatus;
  /**
   * Whether the message has actually been RENDERED on this device (text =
   * decrypted, image = the image is displayed). "Read" is only collected for
   * rendered messages; a device merely holding ciphertext is "delivered", not
   * "read". Undefined/absent counts as rendered (Part 5 text behaviour).
   */
  rendered?: boolean;
}

/**
 * Compute which message ids still need a receipt update from the current
 * message list. Pure: no sets, no side effects.
 *
 * - Own messages are never collected (they would forge the peer's receipt).
 * - Already-`read` messages are never re-collected (monotonic, server-enforced
 *   too).
 * - While viewing: received `sent`/`delivered` messages that have been
 *   RENDERED are collected for the "read" batch (read implies delivered).
 *   Received `sent` messages that are not yet rendered are collected for the
 *   "delivered" batch instead, so a loading image still records delivery.
 * - While NOT viewing: only received `sent` messages are collected for the
 *   "delivered" batch.
 */
export function collectReceiptBatches(
  rows: ReceiptCandidate[],
  myUserId: string,
  viewing: boolean,
): { delivered: string[]; read: string[] } {
  const delivered: string[] = [];
  const read: string[] = [];
  for (const row of rows) {
    if (row.senderId === myUserId || row.status === "read") {
      continue;
    }
    const rendered = row.rendered !== false;
    if (viewing && rendered) {
      // 'sent' or 'delivered': read implies delivered.
      read.push(row.id);
    } else if (row.status === "sent") {
      delivered.push(row.id);
    }
  }
  return { delivered, read };
}

/**
 * Stateful batcher that dedupes against what has already been sent. Used by
 * `useMessageReceipts`; kept pure (no timers, no network) for tests.
 */
export class ReceiptBatcher {
  private readonly sentDelivered = new Set<string>();
  private readonly sentRead = new Set<string>();

  constructor(private readonly myUserId: string) {}

  /**
   * Compute the next batch to send from the full current view, excluding ids
   * that were already sent for the same status.
   */
  compute(rows: ReceiptCandidate[], viewing: boolean): { delivered: string[]; read: string[] } {
    const { delivered, read } = collectReceiptBatches(rows, this.myUserId, viewing);
    return {
      delivered: delivered.filter((id) => !this.sentDelivered.has(id)),
      read: read.filter((id) => !this.sentRead.has(id)),
    };
  }

  /** Record that a batch was handed to the network so it is not re-sent. */
  commit(delivered: string[], read: string[]): void {
    for (const id of delivered) {
      this.sentDelivered.add(id);
    }
    for (const id of read) {
      this.sentRead.add(id);
    }
  }

  /**
   * Forget bookkeeping for messages that are now fully `read` so the sets stay
   * bounded over a long conversation.
   */
  prune(rows: ReceiptCandidate[]): void {
    const readIds = new Set(rows.filter((row) => row.status === "read").map((row) => row.id));
    for (const id of [...this.sentDelivered]) {
      if (readIds.has(id)) {
        this.sentDelivered.delete(id);
      }
    }
    for (const id of [...this.sentRead]) {
      if (readIds.has(id)) {
        this.sentRead.delete(id);
      }
    }
  }
}
