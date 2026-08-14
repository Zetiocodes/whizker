import { describe, expect, it } from "vitest";
import { compareMessages, sortMessages, type SortableMessage } from "@/lib/chat/sort";

function msg(id: string, createdAt: string): SortableMessage {
  return { id, createdAt };
}

describe("compareMessages", () => {
  it("orders ascending by createdAt", () => {
    const a = msg("a", "2025-01-01T00:00:00.000Z");
    const b = msg("b", "2025-01-01T00:01:00.000Z");
    expect(compareMessages(a, b)).toBeLessThan(0);
    expect(compareMessages(b, a)).toBeGreaterThan(0);
  });

  it("breaks createdAt ties by id for determinism", () => {
    const a = msg("a-id", "2025-01-01T00:00:00.000Z");
    const b = msg("b-id", "2025-01-01T00:00:00.000Z");
    expect(compareMessages(a, b)).toBeLessThan(0);
    expect(compareMessages(b, a)).toBeGreaterThan(0);
    expect(compareMessages(a, a)).toBe(0);
  });

  it("falls back to id ordering when a date is invalid", () => {
    const a = msg("a", "not-a-date");
    const b = msg("b", "2025-01-01T00:00:00.000Z");
    expect(compareMessages(a, b)).toBeLessThan(0); // "a" < "b"
  });
});

describe("sortMessages", () => {
  it("returns a new array sorted deterministically and does not mutate input", () => {
    const rows = [
      msg("late", "2025-01-01T00:02:00.000Z"),
      msg("first", "2024-01-01T00:00:00.000Z"),
      msg("tie-b", "2025-01-01T00:00:00.000Z"),
      msg("tie-a", "2025-01-01T00:00:00.000Z"),
    ];
    const original = [...rows];
    const sorted = sortMessages(rows);

    expect(sorted.map((m) => m.id)).toEqual(["first", "tie-a", "tie-b", "late"]);
    expect(rows).toEqual(original);
  });
});
