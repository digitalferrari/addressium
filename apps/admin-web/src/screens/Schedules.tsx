/**
 * Schedules — start, pause, archive. Exported for `Schedules.test.tsx` (#248,
 * file #263): whether a sent one-off still reads ACTIVE is a property of this
 * component's rendering, not of `api.ts`.
 */
import { useEffect, useState } from "react";
import { relativeTime } from "../time.js";
import { can, type Grant } from "../rbac.js";
import { api, type SendScheduleState } from "../api.js";

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
  if (r.cron) return `${r.cron}${r.timezone ? ` (${r.timezone})` : ""}`;
  return "—";
}

export function Schedules({ org, grant }: { org: string; grant: Grant | null }) {
  const [rows, setRows] = useState<SendScheduleState[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const canManage = can(grant, "campaigns:schedule", org);

  const load = () => {
    setError("");
    api.schedules(org).then(setRows).catch((e) => setError(String(e)));
  };
  useEffect(() => {
    setRows(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

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

  const badge = (s: SendScheduleState["status"]) => {
    const color =
      s === "active" ? "#1b7a3d" : s === "paused" ? "#7a4d00" : "#555";
    const bg = s === "active" ? "#d7f0df" : s === "paused" ? "#ffe8a3" : "#e2e2e2";
    return (
      <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, color, background: bg }}>
        {s.toUpperCase()}
      </span>
    );
  };

  return (
    <div>
      <h1 className="h1">Schedules · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Start, pause or archive scheduled sends. Nothing is ever deleted — a paused series
        stops its next edition and can be resumed; archive puts it away for good while keeping history.
      </p>
      {error && <p className="err">{error}</p>}
      {rows === null && !error && <div className="card muted">Loading…</div>}
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
                  <td className="t-strong">{r.scheduleId}</td>
                  <td>{r.kind === "recurring" ? "series" : "one-off"}</td>
                  <td className="muted">{scheduleWhen(r)}</td>
                  <td>{badge(r.status)}</td>
                  <td>
                    {canManage ? (
                      <span style={{ display: "flex", gap: 6 }}>
                        <button className="btn ghost" disabled={r.status === "active" || !!busy} onClick={() => act(r.scheduleId, "start")}>Start</button>
                        <button className="btn ghost" disabled={r.status !== "active" || !!busy} onClick={() => act(r.scheduleId, "pause")}>Pause</button>
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
