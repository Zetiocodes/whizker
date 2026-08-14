import { describe, expect, it } from "vitest";
import { ROOM_CODE_ALPHABET } from "@/config";
import {
  ROOM_CODE_PATTERN,
  formatRoomCodeInput,
  generateRoomCode,
  normalizeRoomCode,
} from "@/lib/rooms/code";

describe("generateRoomCode", () => {
  it("matches the canonical format", () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateRoomCode()).toMatch(ROOM_CODE_PATTERN);
    }
  });

  it("only uses characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode().replaceAll("-", "");
      for (const char of code) {
        expect(ROOM_CODE_ALPHABET).toContain(char);
      }
    }
  });

  it("never emits ambiguous characters (I, O, 0, 1)", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode();
      expect(code).not.toMatch(/[IO01]/);
    }
  });

  it("produces unique codes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(generateRoomCode());
    }
    expect(seen.size).toBe(10_000);
  });
});

describe("normalizeRoomCode", () => {
  it("normalizes lowercase input", () => {
    expect(normalizeRoomCode("k7xm-4qtp-9nvr")).toBe("K7XM-4QTP-9NVR");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRoomCode("  K7XM-4QTP-9NVR  ")).toBe("K7XM-4QTP-9NVR");
  });

  it("accepts compact codes without separators", () => {
    expect(normalizeRoomCode("K7XM4QTP9NVR")).toBe("K7XM-4QTP-9NVR");
  });

  it("accepts space-separated codes", () => {
    expect(normalizeRoomCode("K7XM 4QTP 9NVR")).toBe("K7XM-4QTP-9NVR");
  });

  it("rejects input of the wrong length", () => {
    expect(normalizeRoomCode("")).toBeNull();
    expect(normalizeRoomCode("SHORT")).toBeNull();
    expect(normalizeRoomCode("K7XM-4QTP-9NVR-EXTRA")).toBeNull();
  });

  it("rejects characters outside the alphabet", () => {
    expect(normalizeRoomCode("K7X1-4QTP-9NVR")).toBeNull();
    expect(normalizeRoomCode("K7XM-4QT0-9NVR")).toBeNull();
    expect(normalizeRoomCode("K7XM-4QTP-9NVI")).toBeNull();
    expect(normalizeRoomCode("K7XM-4QTP-9NVO")).toBeNull();
  });
});

describe("formatRoomCodeInput", () => {
  it("uppercases and inserts separators as you type", () => {
    expect(formatRoomCodeInput("k7xm4qtp9nvr")).toBe("K7XM-4QTP-9NVR");
  });

  it("formats partial input progressively", () => {
    expect(formatRoomCodeInput("k")).toBe("K");
    expect(formatRoomCodeInput("k7xm")).toBe("K7XM");
    expect(formatRoomCodeInput("k7xm4q")).toBe("K7XM-4Q");
    expect(formatRoomCodeInput("k7xm4qtp9")).toBe("K7XM-4QTP-9");
  });

  it("strips invalid and separator characters", () => {
    expect(formatRoomCodeInput("K7XM-4QTP-9NVR")).toBe("K7XM-4QTP-9NVR");
    expect(formatRoomCodeInput("K7X1-4QTP 9NVO!")).toBe("K7X4-QTP9-NV");
  });

  it("clamps to the canonical length", () => {
    expect(formatRoomCodeInput("K7XM4QTP9NVRX")).toBe("K7XM-4QTP-9NVR");
  });
});
