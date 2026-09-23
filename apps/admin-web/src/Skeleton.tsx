/**
 * Shimmer placeholders for loading states.
 *
 * Most screens used to render `<div className="muted">Loading…</div>`, which
 * collapses the layout to a single line of text and makes a console that is
 * merely waiting look broken. These occupy roughly the space the real content
 * will, so the page holds its shape while it loads.
 *
 * The `.skeleton` / `.sk-line` / `.sk-kpi` classes and the shimmer keyframes
 * already live in styles.css, including the `prefers-reduced-motion` override
 * that stills the animation.
 *
 * One `aria-busy` region with a single label per block, rather than a label on
 * every bar: a screen reader should hear "loading" once, not once per stripe.
 */

/** Rows of bars, for a table or list. */
export function SkeletonTable({ rows = 5, label = "Loading…" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="skeleton sk-line"
          // Taper the rows so the block reads as content rather than a grid,
          // and never let a bar collapse to nothing at high row counts.
          style={{ width: `${Math.max(45, 100 - i * 7)}%` }}
        />
      ))}
    </div>
  );
}

/** A block the height of a stat tile. */
export function SkeletonKpi({ label = "Loading…" }: { label?: string }) {
  return <div className="skeleton sk-kpi" role="status" aria-busy="true" aria-label={label} />;
}

/** A card-shaped placeholder: heading bar plus a few lines. */
export function SkeletonCard({ lines = 3, label = "Loading…" }: { lines?: number; label?: string }) {
  return (
    <div className="card" role="status" aria-busy="true" aria-label={label}>
      <div className="skeleton sk-line" style={{ width: "35%", height: 16 }} />
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton sk-line" style={{ width: `${Math.max(50, 92 - i * 12)}%` }} />
      ))}
    </div>
  );
}

/**
 * The default full-screen replacement for a bare "Loading…".
 *
 * Deliberately a card: every screen that used the old text rendered it where a
 * card was about to appear, so this keeps the page from reflowing when the real
 * content arrives.
 */
export function SkeletonScreen({ label = "Loading…" }: { label?: string }) {
  return <SkeletonCard lines={4} label={label} />;
}
