import { appConfig } from "@/config";

const { alphabet, groups, groupSize, separator } = appConfig.room.code;

/**
 * Canonical format for a room code: three groups of four unambiguous
 * characters separated by dashes (e.g. `K7XM-4QTP-9NVR`). Matches the
 * database check constraint in 002_rooms.sql.
 */
export const ROOM_CODE_PATTERN =
  /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2}$/;

/**
 * Normalizes arbitrary user input into a canonical room code:
 * - trims whitespace and uppercases
 * - accepts codes with or without separators (e.g. `K7XM4QTP9NVR`)
 * - returns null when the input cannot be a valid room code
 *
 * Used before any database interaction so malformed codes never reach the
 * RPCs or leak whether a room exists.
 */
/**
 * Progressive auto-formatting for the join-code input:
 * - uppercases everything typed
 * - drops characters outside the room-code alphabet
 * - inserts a dash every four characters (e.g. typing `k7xm4qtp9nvr` yields
 *   `K7XM-4QTP-9NVR`)
 *
 * Keeps the cursor simple by only ever appending separators; used by the join
 * forms so pasted or typed codes normalize in real time.
 */
export function formatRoomCodeInput(input: string): string {
  const compact = input.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "");
  const maxLength = groups * groupSize;
  const clamped = compact.slice(0, maxLength);

  const parts: string[] = [];
  for (let i = 0; i < groups; i++) {
    const part = clamped.slice(i * groupSize, (i + 1) * groupSize);
    if (part.length === 0) {
      break;
    }
    parts.push(part);
  }
  return parts.join(separator);
}

export function normalizeRoomCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/\s+/g, "").replaceAll(separator, "");

  if (compact.length !== groups * groupSize) {
    return null;
  }

  const parts: string[] = [];
  for (let i = 0; i < groups; i++) {
    const part = compact.slice(i * groupSize, (i + 1) * groupSize);
    if (!/^[A-HJ-NP-Z2-9]+$/.test(part)) {
      return null;
    }
    parts.push(part);
  }

  return parts.join(separator);
}

/**
 * Generates a canonical room code (e.g. `K7XM-4QTP-9NVR`) from
 * cryptographically secure randomness.
 *
 * The alphabet has exactly 32 symbols (5 bits of entropy per character), so
 * `byte % 32` is uniformly distributed — 256 is a multiple of 32. A 12-char
 * code therefore carries 60 bits of entropy, impractical to brute-force.
 *
 * The code is only a human-readable handle; it is never used as a key.
 */
export function generateRoomCode(): string {
  if (alphabet.length !== 32) {
    throw new Error(
      `Room-code alphabet must be exactly 32 characters (got ${alphabet.length}).`,
    );
  }

  const length = groups * groupSize;
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  const chars: string[] = [];
  for (const byte of bytes) {
    chars.push(alphabet[byte % alphabet.length]);
  }

  const parts: string[] = [];
  for (let i = 0; i < groups; i++) {
    parts.push(chars.slice(i * groupSize, (i + 1) * groupSize).join(""));
  }
  return parts.join(separator);
}
