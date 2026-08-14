import { describe, expect, it } from "vitest";
import {
  formatClockTime,
  formatCountdown,
  formatDayLabel,
  formatRelativeRemaining,
  formatRemainingShort,
} from "@/lib/ui/format";

describe("formatCountdown", () => {
  it("formats a full 24-hour countdown", () => {
    expect(formatCountdown(24 * 60 * 60 * 1000 - 1)).toBe("23:59:59");
  });

  it("formats hours, minutes and seconds", () => {
    expect(formatCountdown((3 * 3600 + 12 * 60 + 7) * 1000)).toBe("03:12:07");
  });

  it("zero-pads each unit", () => {
    expect(formatCountdown(9 * 1000)).toBe("00:00:09");
  });

  it("clamps negatives to zero", () => {
    expect(formatCountdown(-5000)).toBe("00:00:00");
  });

  it("floors milliseconds", () => {
    expect(formatCountdown(1500)).toBe("00:00:01");
  });
});

describe("formatRelativeRemaining", () => {
  it("uses hours and minutes for long durations", () => {
    expect(formatRelativeRemaining((23 * 3600 + 59 * 60) * 1000)).toBe("in 23h 59m");
  });

  it("drops hours when under an hour", () => {
    expect(formatRelativeRemaining(59 * 60 * 1000)).toBe("in 59m");
  });

  it("falls back to seconds when under a minute", () => {
    expect(formatRelativeRemaining(45 * 1000)).toBe("in 45s");
  });

  it("reports expired at or below zero", () => {
    expect(formatRelativeRemaining(0)).toBe("expired");
    expect(formatRelativeRemaining(-1000)).toBe("expired");
  });
});

describe("formatRemainingShort", () => {
  it("labels hours and minutes", () => {
    expect(formatRemainingShort(23 * 3600 * 1000)).toBe("23h left");
    expect(formatRemainingShort(59 * 60 * 1000)).toBe("59m left");
  });

  it("labels the final seconds", () => {
    expect(formatRemainingShort(3000)).toBe("Expires any second");
  });

  it("reports expiry", () => {
    expect(formatRemainingShort(0)).toBe("Expired");
  });
});

describe("formatClockTime", () => {
  it("formats a local time", () => {
    expect(formatClockTime("2026-01-02T03:04:00Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("returns an empty string for invalid input", () => {
    expect(formatClockTime("not-a-date")).toBe("");
  });
});

describe("formatDayLabel", () => {
  const now = new Date("2026-08-14T12:00:00Z").getTime();

  it("labels today", () => {
    expect(formatDayLabel("2026-08-14T08:00:00Z", now)).toBe("Today");
  });

  it("labels yesterday", () => {
    expect(formatDayLabel("2026-08-13T08:00:00Z", now)).toBe("Yesterday");
  });

  it("falls back to a short date for older entries", () => {
    const label = formatDayLabel("2026-08-01T08:00:00Z", now);
    expect(label).toMatch(/Aug/i);
    expect(label).not.toBe("Today");
  });

  it("returns an empty string for invalid input", () => {
    expect(formatDayLabel("nope", now)).toBe("");
  });
});
