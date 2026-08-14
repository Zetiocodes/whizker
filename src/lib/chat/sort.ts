/**
 * Message ordering (Part 6).
 *
 * History is fetched ordered by `created_at` and live rows arrive in realtime
 * order; sorting the rendered list with a stable comparator makes ordering
 * deterministic regardless of arrival order.
 */

export interface SortableMessage {
  id: string;
  createdAt: string;
}

/** Stable comparator: ascending by createdAt, then by id. */
export function compareMessages(a: SortableMessage, b: SortableMessage): number {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    return a.id.localeCompare(b.id);
  }
  if (ta !== tb) {
    return ta - tb;
  }
  return a.id.localeCompare(b.id);
}

/** Return a new array sorted ascending by createdAt (stable). */
export function sortMessages<T extends SortableMessage>(rows: T[]): T[] {
  return [...rows].sort(compareMessages);
}
