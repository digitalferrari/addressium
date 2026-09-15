/**
 * The one-shot load hook every screen in the console uses.
 *
 * Extracted verbatim from `App.tsx` when the screens were split into modules.
 * It runs its function on every deps change and has no way to skip — screens
 * that need a conditional read resolve to `null` inside `fn` instead.
 */
import { useEffect, useState } from "react";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    fn()
      .then((data) => live && setState({ data, loading: false }))
      .catch((e) => live && setState({ error: String(e), loading: false }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
