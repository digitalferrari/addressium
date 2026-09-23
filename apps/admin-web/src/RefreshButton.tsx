/**
 * The Refresh control on every data screen.
 *
 * One component so the affordance is identical everywhere: same classes as the
 * existing ghost buttons, same label, same disabled rule. An operator who
 * learns it on Campaigns knows it on Suppression.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never blanks the screen. The refresh it
 * triggers goes through `useAsync().refetch` (or, on Schedules, that screen's
 * own equivalent), which keeps the current rows while the new read is in
 * flight. A control that replaced a correct table with a shimmer every time it
 * was pressed would be worse than no control at all.
 *
 * Accessibility: the label itself changes to "Refreshing…", so the button's own
 * accessible name carries the state. That is announced when focus is on the
 * button — which is where it is, since the operator just pressed it — without a
 * live region chattering on every read the screen makes on its own.
 */
export function RefreshButton({
  refreshing,
  onClick,
  disabled,
  title = "Re-read this screen's data from the server",
}: {
  refreshing: boolean;
  onClick: () => void;
  /** Also disabled during the first load: there is nothing to refresh yet. */
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="btn ghost"
      onClick={onClick}
      disabled={refreshing || disabled}
      aria-busy={refreshing || undefined}
      title={title}
    >
      {refreshing ? "Refreshing…" : "Refresh"}
    </button>
  );
}
