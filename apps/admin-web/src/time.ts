/**
 * How far off `iso` is, in words — "in 4 min", "3 min ago" (#248).
 *
 * Every one-off sits at least five minutes out (§4.6) so it stays cancellable,
 * and this is the screen that cancel lives on. An absolute timestamp alone
 * makes the operator do clock arithmetic in the window they are racing; the
 * relative form is the part that is actually actionable, so the row shows both.
 *
 * Rendered, not ticking: this is computed at paint, so a row left open drifts.
 * It is re-rendered on every lifecycle action and on every load of the screen,
 * which are the moments the number is being read. A timer to keep it live would
 * buy accuracy no operator is looking at in between.
 *
 * Shared by the Schedules rows and the Dashboard's recent-campaign column.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const deltaMs = new Date(iso).getTime() - now;
  if (Number.isNaN(deltaMs)) return "";
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const mins = Math.round(deltaMs / 60000);
  if (Math.abs(mins) < 60) return fmt.format(mins, "minute");
  const hours = Math.round(deltaMs / 3600000);
  if (Math.abs(hours) < 24) return fmt.format(hours, "hour");
  return fmt.format(Math.round(deltaMs / 86400000), "day");
}
