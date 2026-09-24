/**
 * The one-shot load hook every screen in the console uses.
 *
 * Extracted verbatim from `App.tsx` when the screens were split into modules.
 * It runs its function on every deps change and has no way to skip — screens
 * that need a conditional read resolve to `null` inside `fn` instead.
 *
 * THE DEPS-CHANGE PATH STILL CLEARS `data`, deliberately, and must keep doing
 * so. Several screens depend on that clearing to avoid rendering the PREVIOUS
 * org's rows under the new org's header while the new read is in flight — see
 * the `!batches.data` comment in ImportMapper, the per-cell staleness note in
 * Campaigns' Schedule column, and the `localFeeds` reset in Feeds. A refresh is
 * the opposite case and is handled separately.
 *
 * `refetch` is the operator-driven re-read behind the Refresh control. It is
 * NOT the deps path: it keeps the current `data` on screen and leaves `loading`
 * false, so a screen that keys its skeleton on `loading` shows the rows it
 * already has plus an in-flight indication, never a placeholder over correct
 * data. It reports through `refreshing` instead.
 *
 * Post-mutation reloads deliberately do NOT go through `refetch` — they keep
 * bumping their own `rev`/`revision`/`reloadKey` deps, because `refetch`'s
 * single-flight guard would silently drop a reload that follows a write.
 */
import { beginRequest, endRequest } from "./pending.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface Async<T> {
  data?: T;
  error?: string;
  loading: boolean;
  /** True only during a `refetch`. The deps path reports through `loading`. */
  refreshing: boolean;
  /**
   * Re-read without blanking the screen. Resolves `true` when fresh data was
   * stored, `false` when the read failed, was superseded by a deps change or
   * unmount, or was dropped because one was already in flight. It never
   * rejects, so a caller may `await` it without a try/catch.
   */
  refetch: () => Promise<boolean>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean; refreshing: boolean }>({
    loading: true,
    refreshing: false,
  });

  // `fn` is a fresh closure on every render; the ref is what lets the stable
  // `refetch` identity still call the CURRENT one (the latest `org`, query,
  // cursor and so on) rather than the one from the render that created it.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Bumped on every deps change and on unmount. A refresh that was in flight
  // across either compares generations and drops its result, so a slow refresh
  // of org A can never land on top of org B's freshly loaded rows.
  const generation = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    // A deps change supersedes any refresh: release the guard so the new
    // screen's Refresh button is usable immediately.
    inFlight.current = false;
    setState({ loading: true, refreshing: false });
    // Counted globally so the top-edge bar can show the app is waiting even
    // when this particular screen's result is superseded (#294).
    beginRequest();
    let settled = false;
    const done = () => { if (!settled) { settled = true; endRequest(); } };
    fnRef
      .current()
      .then((data) => {
        done();
        if (generation.current === mine) setState({ data, loading: false, refreshing: false });
      })
      .catch((e) => {
        done();
        if (generation.current === mine) setState({ error: String(e), loading: false, refreshing: false });
      });
    return () => {
      generation.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const refetch = useCallback(async (): Promise<boolean> => {
    // Single flight: a second click while a read is out must not spawn an
    // overlapping request whose response could land out of order.
    if (inFlight.current) return false;
    inFlight.current = true;
    const mine = generation.current;
    setState((s) => ({ ...s, refreshing: true }));
    try {
      const data = await fnRef.current();
      if (generation.current !== mine) return false;
      // A successful refresh clears a stale error: the screen is now correct.
      setState({ data, loading: false, refreshing: false });
      return true;
    } catch (e) {
      if (generation.current !== mine) return false;
      // The rows stay. A failed refresh costs the operator freshness, not the
      // data they were already looking at.
      setState((s) => ({ ...s, error: String(e), refreshing: false }));
      return false;
    } finally {
      if (generation.current === mine) inFlight.current = false;
    }
  }, []);

  // A new object identity on every render would retrigger any effect that has
  // the whole result in its deps, so the identity only changes with the state.
  return useMemo(() => ({ ...state, refetch }), [state, refetch]);
}
