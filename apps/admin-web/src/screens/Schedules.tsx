/**
 * Schedules — start, pause, archive. Exported for `Schedules.test.tsx` (#248,
 * #263): whether a sent one-off still reads ACTIVE is a property of this
 * component's rendering, not of `api.ts`.
 */
import { useEffect, useRef, useState } from "react";
import { relativeTime } from "../time.js";
import { can, type Grant } from "../rbac.js";
import { api, scheduleHasSent, type SendScheduleState } from "../api.js";
import { describeSchedule } from "@addressium/domain";
import { SkeletonTable } from "../Skeleton.js";
import { RefreshButton } from "../RefreshButton.js";

/**
 * When a row fires: a one-off's send time, a series' cron (#248).
 *
 * The cell used to read `{r.cron ? … : "—"}`, so every one-off showed "—" —
 * the one kind of row whose timing is urgent was the one with no timing on it.
 */
function scheduleWhen(r: SendScheduleState, now?: number): string {
  if (r.sendAt) {
    const at = new Date(r.sendAt);
    // Deliberately the BROWSER's zone, not `r.timezone` — the operator deciding
    // whether to hit Pause is reading their own clock, and converting into the
    // org's sending zone would hand them a number they then have to convert
    // back. `r.timezone` is stored for parity with `campaign.schedule` (the two
    // records are written from one instant and one zone); nothing renders it
    // here, and the relative form below is what makes the ambiguity harmless.
    // A malformed stored value must not reach the operator as "Invalid Date".
    if (Number.isNaN(at.getTime())) return "—";
    const relative = relativeTime(r.sendAt, now);
    return `${at.toLocaleString()}${relative ? ` (${relative})` : ""}`;
  }
  if (r.cron) {
    const desc = describeSchedule(r.cron, r.timezone);
    return `${desc} (${r.cron})`;
  }
  return "—";
}

export function Schedules({
  org,
  grant,
  onViewReport,
}: {
  org: string;
  grant: Grant | null;
  /** Open a campaign report. Omitted in tests and anywhere without a view switch. */
  onViewReport?: (campaignId: string) => void;
}) {
  const [rows, setRows] = useState<SendScheduleState[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const canManage = can(grant, "campaigns:schedule", org);
  /**
   * Bumped on every org change. A refresh still in flight across one compares
   * generations and drops its result, so a slow read of org A can never land
   * its rows under org B's header. The `useAsync` screens get this from the
   * hook; this screen holds its own state and has to do it itself.
   */
  const generation = useRef(0);

  const load = () => {
    setError("");
    const mine = generation.current;
    api.schedules(org)
      .then((r) => { if (generation.current === mine) setRows(r); })
      .catch((e) => { if (generation.current === mine) setError(String(e)); });
  };
  useEffect(() => {
    generation.current += 1;
    setRows(null);
    setRefreshing(false);
    load();
    return () => { generation.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  /**
   * The operator-driven re-read. Unlike the mount path it does NOT clear
   * `rows`: the table an operator is looking at stays on screen, and a failed
   * refresh costs them freshness rather than the rows themselves. Single
   * flight, so a second press cannot spawn an overlapping read.
   *
   * This screen is deliberately not on `useAsync` — it keeps the manual state
   * it already had rather than being converted as part of adding a button.
   */
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    const mine = generation.current;
    try {
      const fresh = await api.schedules(org);
      if (generation.current === mine) setRows(fresh);
    } catch (e) {
      if (generation.current === mine) setError(String(e));
    } finally {
      if (generation.current === mine) setRefreshing(false);
    }
  };

  const act = async (scheduleId: string, action: "start" | "pause" | "archive") => {
    setBusy(`${scheduleId}:${action}`);
    setError("");
    try {
      await api.scheduleLifecycle(org, scheduleId, action);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  /**
   * COMPLETED is its own colour, not the grey `archived` shares (#263). Both
   * are terminal, but they answer different questions: archived is "the
   * operator put it away", completed is "it sent". Rendering them alike would
   * leave the one state an operator most wants to spot — the send that already
   * went out — indistinguishable from one they filed themselves.
   */
  const badge = (s: SendScheduleState["status"]) => {
    const color =
      s === "active" ? "#1b7a3d" : s === "paused" ? "#7a4d00" : s === "completed" ? "#2a4b8d" : "#555";
    const bg =
      s === "active" ? "#d7f0df" : s === "paused" ? "#ffe8a3" : s === "completed" ? "#dde5f6" : "#e2e2e2";
    return (
      <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, color, background: bg }}>
        {s.toUpperCase()}
      </span>
    );
  };

  return (
    <div>
      <div className="pagehead">
        {/* The h1 text is unchanged — existing tests query it. */}
        <div><h1 className="h1">Schedules · {org || "—"}</h1></div>
        <RefreshButton refreshing={refreshing} disabled={rows === null} onClick={() => void refresh()} />
      </div>
      <p className="muted" style={{ marginTop: -8 }}>
        Start, pause or archive scheduled sends. Nothing is ever deleted — a paused series
        stops its next edition and can be resumed; archive puts it away for good while keeping history.
      </p>
      {error && <p className="err">{error}</p>}
      {rows === null && !error && <SkeletonTable rows={5} />}
      {rows && rows.length === 0 && (
        <div className="card muted">No scheduled sends yet. Schedule a campaign or recurring series to see it here.</div>
      )}
      {rows && rows.length > 0 && (
        <div className="card">
          <table>
            <thead>
              {/* "When", not "Cadence" (#248): the column now holds a one-off's
                  send time as well as a series' cadence, and only one of those
                  is a cadence. It is also the header the design prototype
                  uses for the same column. */}
              <tr><th>Schedule</th><th>Kind</th><th>When</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.scheduleId}>
                  {/* The schedule id IS the campaign id — both scheduling paths
                      in the API write `scheduleId: body.campaignId` — so the
                      row can link straight to its report without another read. */}
                  <td className="t-strong">
                    {onViewReport ? (
                      <button
                        type="button"
                        className="btn btn-ghost ghost flink"
                        style={{ padding: 0, font: "inherit", fontWeight: "inherit" }}
                        onClick={() => onViewReport(r.scheduleId)}
                        title={`View the report for ${r.scheduleId}`}
                      >
                        {r.scheduleId}
                      </button>
                    ) : (
                      r.scheduleId
                    )}
                  </td>
                  <td>{r.kind === "recurring" ? "series" : "one-off"}</td>
                  <td className="muted">{scheduleWhen(r)}</td>
                  <td>{badge(r.status)}</td>
                  <td>
                    {canManage ? (
                      <span style={{ display: "flex", gap: 6 }}>
                        {/* A one-off that has sent can only be archived (#263).
                            `transitionSchedule` rejects start and pause on it
                            with an InvalidInputError, so leaving Start live
                            offered a restart the server was always going to
                            refuse — and worse, implied the send had not gone
                            out. `scheduleHasSent`, not `status === "completed"`:
                            an archived-mid-send one-off finishes with full
                            ranges and keeps `archived`. Archive stays enabled —
                            it is the one transition the domain still allows,
                            and it is how a fired one-off leaves the list an
                            operator scans for what is still pending. */}
                        <button className="btn ghost" disabled={r.status === "active" || scheduleHasSent(r) || !!busy} onClick={() => act(r.scheduleId, "start")}>Start</button>
                        <button className="btn ghost" disabled={r.status !== "active" || scheduleHasSent(r) || !!busy} onClick={() => act(r.scheduleId, "pause")}>Pause</button>
                        <button className="btn ghost" disabled={r.status === "archived" || !!busy} onClick={() => act(r.scheduleId, "archive")}>Archive</button>
                      </span>
                    ) : (
                      <span className="muted">read-only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
