/**
 * Scheduling policy (docs/ARCHITECTURE.md §4.6).
 *
 * One-off sends are ALWAYS placed at least `MIN_ONEOFF_LEAD_MS` into the future
 * — even "send now" — so there is a window to hit cancel before anything goes
 * out. A requested time further out is honored as-is.
 */

/** Minimum lead time for a one-off send: 5 minutes. */
export const MIN_ONEOFF_LEAD_MS = 5 * 60 * 1000;

export function effectiveOneOffTime(
  now: Date,
  requestedAt?: Date,
  minLeadMs: number = MIN_ONEOFF_LEAD_MS,
): Date {
  const floor = new Date(now.getTime() + minLeadMs);
  if (requestedAt && requestedAt.getTime() > floor.getTime()) return requestedAt;
  return floor;
}
