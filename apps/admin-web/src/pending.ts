/**
 * How many server requests are in flight right now.
 *
 * Drives the thin indeterminate bar at the top of the window. A skeleton tells
 * you which BLOCK is waiting; this tells you the app is waiting at all — which
 * is the thing a user checks when a screen looks frozen, and the reason a
 * static placeholder reads as broken rather than busy.
 *
 * A counter rather than a boolean: screens commonly run several `useAsync`
 * calls at once, and the bar must not disappear when the first of them lands.
 */
let pending = 0;
const listeners = new Set<(n: number) => void>();

function emit(): void {
  for (const l of listeners) l(pending);
}

export function beginRequest(): void {
  pending += 1;
  emit();
}

export function endRequest(): void {
  // Floored at zero: a double-end (a refetch superseded mid-flight, say) must
  // not drive the count negative and leave the bar stuck on forever.
  pending = Math.max(0, pending - 1);
  emit();
}

export function subscribePending(l: (n: number) => void): () => void {
  listeners.add(l);
  l(pending);
  return () => listeners.delete(l);
}

/** Test seam — reset between cases. */
export function resetPending(): void {
  pending = 0;
  emit();
}
