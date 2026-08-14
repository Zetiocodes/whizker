import { describe, expect, it } from "vitest";
import { ReceiptBatcher, collectReceiptBatches } from "@/lib/realtime/receipts";
import type { ReceiptCandidate } from "@/lib/realtime/receipts";

const ME = "user-me";
const PEER = "user-peer";

function msg(
  id: string,
  overrides: Partial<ReceiptCandidate> = {},
): ReceiptCandidate {
  return { id, senderId: PEER, status: "sent", ...overrides };
}

describe("collectReceiptBatches", () => {
  it("never collects the caller's own messages", () => {
    const rows = [msg("a", { senderId: ME })];
    expect(collectReceiptBatches(rows, ME, true)).toEqual({ delivered: [], read: [] });
  });

  it("collects received sent messages for delivered while not viewing", () => {
    const rows = [msg("a"), msg("b")];
    expect(collectReceiptBatches(rows, ME, false)).toEqual({
      delivered: ["a", "b"],
      read: [],
    });
  });

  it("collects received sent messages for read while viewing (read implies delivered)", () => {
    const rows = [msg("a"), msg("b")];
    expect(collectReceiptBatches(rows, ME, true)).toEqual({
      delivered: [],
      read: ["a", "b"],
    });
  });

  it("collects delivered-but-unread messages for read while viewing", () => {
    const rows = [msg("a", { status: "delivered" })];
    expect(collectReceiptBatches(rows, ME, true)).toEqual({ delivered: [], read: ["a"] });
  });

  it("does not re-collect delivered messages while not viewing", () => {
    const rows = [msg("a", { status: "delivered" }), msg("b", { status: "read" })];
    expect(collectReceiptBatches(rows, ME, false)).toEqual({ delivered: [], read: [] });
  });

  it("never re-collects read messages", () => {
    const rows = [msg("a", { status: "read" })];
    expect(collectReceiptBatches(rows, ME, true)).toEqual({ delivered: [], read: [] });
  });

  it("collects a not-yet-rendered image for delivered, not read, while viewing", () => {
    const rows = [msg("img", { rendered: false })];
    expect(collectReceiptBatches(rows, ME, true)).toEqual({
      delivered: ["img"],
      read: [],
    });
  });

  it("collects a rendered image for read while viewing (read implies delivered)", () => {
    const rows = [msg("img", { rendered: true })];
    expect(collectReceiptBatches(rows, ME, true)).toEqual({
      delivered: [],
      read: ["img"],
    });
  });

  it("treats absent rendered as rendered (Part 5 text behaviour)", () => {
    const rows = [msg("text-no-rendered-flag")];
    expect(collectReceiptBatches(rows, ME, true)).toEqual({ delivered: [], read: ["text-no-rendered-flag"] });
  });

  it("collects a not-yet-rendered image for delivered only once, then read after render", () => {
    const batcher = new ReceiptBatcher(ME);
    const rows = [msg("img", { rendered: false })];

    const deliveredOnly = batcher.compute(rows, true);
    expect(deliveredOnly).toEqual({ delivered: ["img"], read: [] });
    batcher.commit(deliveredOnly.delivered, deliveredOnly.read);

    // Still not rendered: no read receipt yet, no re-sent delivered either.
    expect(batcher.compute(rows, true)).toEqual({ delivered: [], read: [] });

    // Once rendered, the read batch goes out (message stays delivered-or-read).
    const renderedRows = [msg("img", { rendered: true })];
    const readBatch = batcher.compute(renderedRows, true);
    expect(readBatch).toEqual({ delivered: [], read: ["img"] });
  });
});

describe("ReceiptBatcher", () => {
  it("does not re-send ids that were already committed", () => {
    const batcher = new ReceiptBatcher(ME);
    const rows = [msg("a")];

    const first = batcher.compute(rows, false);
    expect(first.delivered).toEqual(["a"]);
    batcher.commit(first.delivered, first.read);

    expect(batcher.compute(rows, false).delivered).toEqual([]);
  });

  it("sends a delivered batch first, then a read batch when viewing starts", () => {
    const batcher = new ReceiptBatcher(ME);
    const rows = [msg("a")];

    const notViewing = batcher.compute(rows, false);
    expect(notViewing).toEqual({ delivered: ["a"], read: [] });
    batcher.commit(notViewing.delivered, notViewing.read);

    const viewing = batcher.compute(rows, true);
    expect(viewing).toEqual({ delivered: [], read: ["a"] });
    batcher.commit(viewing.delivered, viewing.read);

    expect(batcher.compute(rows, true)).toEqual({ delivered: [], read: [] });
  });

  it("never collects own messages even after commits", () => {
    const batcher = new ReceiptBatcher(ME);
    const rows = [msg("a", { senderId: ME }), msg("b")];
    const batch = batcher.compute(rows, false);
    expect(batch.delivered).toEqual(["b"]);
  });

  it("prune() forgets bookkeeping for read messages", () => {
    const batcher = new ReceiptBatcher(ME);
    const rows = [msg("a")];

    const notViewing = batcher.compute(rows, false);
    batcher.commit(notViewing.delivered, notViewing.read);
    batcher.prune(rows.map((r) => ({ ...r, status: "read" })));

    // After pruning, a read message is simply skipped, not re-sent.
    const rowsRead = [msg("a", { status: "read" })];
    expect(batcher.compute(rowsRead, true)).toEqual({ delivered: [], read: [] });
  });

  it("handles mixed lists with own, sent and delivered messages", () => {
    const batcher = new ReceiptBatcher(ME);
    const rows = [
      msg("mine", { senderId: ME }),
      msg("sent-a"),
      msg("delivered-b", { status: "delivered" }),
      msg("read-c", { status: "read" }),
    ];

    const notViewing = batcher.compute(rows, false);
    expect(notViewing.delivered).toEqual(["sent-a"]);

    const viewing = batcher.compute(rows, true);
    expect(viewing.read).toEqual(["sent-a", "delivered-b"]);
  });
});
