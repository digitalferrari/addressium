/**
 * A thin indeterminate bar across the top of the window while any request is in
 * flight (#294).
 *
 * Skeletons say which block is waiting. This says the APP is waiting at all,
 * which is what someone checks when a screen looks frozen — and a placeholder
 * that never moves reads as broken rather than busy.
 *
 * Deliberately not a percentage: the requests behind it have no measurable
 * progress, and a fake bar that crawls to 90% and stops is a worse lie than an
 * honest looping one.
 */
import { useEffect, useState } from "react";
import { subscribePending } from "./pending.js";

export function TopProgress() {
  const [pending, setPending] = useState(0);
  useEffect(() => subscribePending(setPending), []);

  // Rendered ONLY while busy rather than hidden with opacity: a permanently
  // present element at the top of the document is one more thing for a screen
  // reader to announce, and one more thing to mis-stack over a modal.
  if (pending === 0) return null;

  return (
    <div
      className="topprogress"
      // Announced once, not on every tick. `aria-busy` on a bar that does not
      // exist when idle is enough; a live region here would narrate every
      // request a screen makes.
      role="progressbar"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="topprogress-bar" />
    </div>
  );
}
