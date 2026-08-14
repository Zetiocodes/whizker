/**
 * Pure, timezone-safe formatting helpers used across the UI. Everything here
 * is a pure function of its inputs (no timers, no globals) so it can be
 * unit-tested in Node and reused by both server-rendered and client-rendered
 * screens. Client-side relative labels are re-derived on a ticker in the
 * components, never cached against a stale clock.
 */

/**
 * Countdown clock "HH:MM:SS" (e.g. "23:59:59"). Clamps at zero.
 * `hours` is zero-padded to two digits like the rest.
 */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

/**
 * Compact relative duration label: "in 23h 59m", "in 59m", "in 45s",
 * or "expired" once the time has passed.
 */
export function formatRelativeRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds === 0) {
    return "expired";
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `in ${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `in ${minutes}m`;
  }
  return `in ${seconds}s`;
}

/**
 * Short human countdown for headers: "23h left", "59m left", "about to expire".
 */
export function formatRemainingShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds === 0) {
    return "Expired";
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h left`;
  }
  if (minutes > 0) {
    return `${minutes}m left`;
  }
  return "Expires any second";
}

/**
 * Local wall-clock time "HH:MM" (24h) for message timestamps. `hour12: false`
 * keeps the label stable across locales. Returns "" for unparseable input.
 */
export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * Date label for room lists: today/yesterday become friendly words, older
 * dates fall back to a short locale date. Returns "" for unparseable input.
 */
export function formatDayLabel(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date.getTime() >= startOfToday.getTime()) {
    return "Today";
  }
  if (date.getTime() >= startOfYesterday.getTime()) {
    return "Yesterday";
  }
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}
