/**
 * Campaigns — the list (#281, file #254). Exported for `Campaigns.test.tsx`.
 *
 * Until this screen existed the only way to see a campaign was the report
 * screen's `<select>`, which reads `subject` and `campaignId` and throws away
 * the `status`, `type`, `listId`, `segmentId`, `sent` and `sendAt` that
 * `GET /orgs/{org}/campaigns` already returns. "What has this organization
 * sent, and what is about to go out" had no answer that did not involve
 * picking ids one at a time.
 *
 * NO NEW ROUTE. Both reads already exist and are gated identically
 * (`reports:view`): `GET /orgs/{org}/campaigns` (`campaignsListHandler`) and
 * `GET /orgs/{org}/schedules` (`schedulesListHandler`). This screen is the join
 * of the two, which is what the design's table actually is — see `joinRows`.
 */
import { useMemo, useState } from "react";
import { useAsync } from "../useAsync.js";
import { relativeTime } from "../time.js";
import { can, type Grant } from "../rbac.js";
import { api, type CampaignRow, type SendScheduleState } from "../api.js";

/**
 * The two state machines this screen shows at once.
 *
 * `Campaign.status` (draft → scheduled → sending → sent, or halted) says what
 * happened to the SEND. `SendScheduleState.status` (active/paused/archived)
 * says whether the schedule MAY FIRE — it is the source of truth the launch
 * handler and the sender both gate on. They are not the same fact and neither
 * subsumes the other: a `sent` one-off can sit on an `archived` lifecycle row,
 * and a series whose parent is forever `scheduled` is paused or not entirely
 * according to its lifecycle record. The design's table shows both columns for
 * that reason, and the Pause/Resume/Archive buttons act on the second one.
 */
export interface CampaignListRow {
  campaign: CampaignRow;
  /** The lifecycle record, when this campaign was scheduled through the console. */
  schedule?: SendScheduleState;
}

const CAMPAIGN_STATUS_COLOR: Record<string, string> = {
  sent: "#15803d",
  sending: "#2563eb",
  scheduled: "#b45309",
  halted: "#b91c1c",
  draft: "#6b7280",
};

/**
 * Newest first by send time; rows with no send time (drafts, and every
 * recurring parent) sort last.
 *
 * Deliberately a local copy of the Dashboard's comparator rather than an
 * import: `Dashboard.tsx` is pinned by #261's tests and is being edited
 * concurrently, and six lines duplicated is cheaper than two screens contending
 * over one module.
 */
function byMostRecentSend(a: CampaignListRow, b: CampaignListRow): number {
  const at = a.campaign.sendAt ? new Date(a.campaign.sendAt).getTime() : NaN;
  const bt = b.campaign.sendAt ? new Date(b.campaign.sendAt).getTime() : NaN;
  return (Number.isNaN(bt) ? -Infinity : bt) - (Number.isNaN(at) ? -Infinity : at);
}

/**
 * Join the campaign records to their lifecycle records on
 * `campaignId === scheduleId`.
 *
 * That identity is not a guess: `scheduleCampaignHandler` writes both records
 * from the same request and stamps the lifecycle one `scheduleId:
 * body.campaignId` on both the one-off and the recurring branch.
 *
 * LEFT outer, campaigns-driven. A campaign saved as a draft through
 * `POST /campaigns` has never been scheduled and so has no lifecycle row at
 * all; it still belongs in the list, with its actions rendered unavailable
 * rather than offered and broken. Driving from the campaign side also keeps
 * lifecycle rows that have no Campaign item — drip sub-campaigns, re-engagement
 * steps, series editions — out of the table, which is the same rule
 * `campaigns.list` already follows.
 */
export function joinRows(campaigns: CampaignRow[], schedules: SendScheduleState[]): CampaignListRow[] {
  const byId = new Map(schedules.map((s) => [s.scheduleId, s]));
  return campaigns
    .map((campaign) => {
      const schedule = byId.get(campaign.campaignId);
      return schedule ? { campaign, schedule } : { campaign };
    })
    .sort(byMostRecentSend);
}

/**
 * One-off or recurring series — read from the LIFECYCLE record, not from
 * `campaign.type`.
 *
 * `CampaignRow.type` cannot express a series and will say "one_off" for one.
 * `saveCampaignSchema.type` is `one_off | series_edition`, and
 * `recordScheduledCampaign` writes `type: existing?.type ?? "one_off"` from
 * BOTH branches of the schedule route — the recurring branch passes no override,
 * because a recurring parent is neither: its EDITIONS are the `series_edition`s
 * and they have no Campaign item by design. So the parent of a daily series is
 * stored as `one_off`, and rendering that field at face value labels every
 * series wrong. `schedule.kind` is written as `"recurring"` by the same request
 * and is the only truthful source.
 *
 * With no lifecycle row there is nothing truthful to say. A campaign becomes a
 * one-off or a series only when it is SCHEDULED — that is the request that
 * writes the lifecycle record — so an unscheduled draft has not chosen yet and
 * the cell says "unscheduled" rather than guessing "one-off" from a stored
 * field that defaults to it.
 */
function campaignKind(r: CampaignListRow): "one-off" | "series" | "unscheduled" {
  if (r.schedule) return r.schedule.kind === "recurring" ? "series" : "one-off";
  return "unscheduled";
}

/**
 * When this campaign fires: a one-off's send time, a series' cron.
 *
 * A recurring parent has NO `schedule.sendAt` — `recordScheduledCampaign`
 * explicitly deletes it, because a series has no single send time — so the cron
 * on the lifecycle record is the only timing a series row has. Rendering "—"
 * for the kind of row that fires most often is exactly the bug #248 fixed on
 * the Schedules screen.
 *
 * Absolute plus relative, in the BROWSER's zone rather than the org's sending
 * zone: an operator deciding whether to pause is reading their own clock.
 */
function campaignWhen(r: CampaignListRow, now?: number): string {
  const sendAt = r.campaign.sendAt ?? r.schedule?.sendAt;
  if (sendAt) {
    const at = new Date(sendAt);
    // A stored value that does not parse must not reach the operator as
    // "Invalid Date", which reads as a state of the send rather than a bad row.
    if (Number.isNaN(at.getTime())) return "—";
    const rel = relativeTime(sendAt, now);
    return `${at.toLocaleString()}${rel ? ` (${rel})` : ""}`;
  }
  const cron = r.schedule?.cron;
  if (cron) return `${cron}${r.schedule?.timezone ? ` (${r.schedule.timezone})` : ""}`;
  return "—";
}

/**
 * Who this campaign goes to, as the ids the API actually returns.
 *
 * The design's Audience column shows a recipient COUNT (96,204). Nothing on
 * this route returns one, and no other route computes an audience size for a
 * campaign — so a number here would be invented. The list and segment ids are
 * the real answer to "who does this go to", and the column is headed to say so.
 */
function audience(c: CampaignRow): string {
  const parts = [c.listId, c.segmentId].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

const FILTERS = ["All sends", "Series", "One-off", "Scheduled", "Paused"] as const;
type Filter = (typeof FILTERS)[number];

/**
 * The design's filter chips, each defined against a field that exists.
 *
 * "Ongoing" in the prototype is a series, and "Paused" is a lifecycle state —
 * so the last two chips filter on different records, which is only possible
 * because the rows are joined.
 */
function matchesFilter(r: CampaignListRow, filter: Filter): boolean {
  switch (filter) {
    case "Series": return campaignKind(r) === "series";
    case "One-off": return campaignKind(r) === "one-off";
    case "Scheduled": return r.campaign.status === "scheduled";
    case "Paused": return r.schedule?.status === "paused";
    default: return true;
  }
}

function StatusPill({ status }: { status: string }) {
  return (
    <span style={{ color: CAMPAIGN_STATUS_COLOR[status] ?? "#6b7280", fontWeight: 600 }}>{status}</span>
  );
}

function LifecyclePill({ status }: { status: SendScheduleState["status"] }) {
  const color = status === "active" ? "#1b7a3d" : status === "paused" ? "#7a4d00" : "#555";
  const bg = status === "active" ? "#d7f0df" : status === "paused" ? "#ffe8a3" : "#e2e2e2";
  return (
    <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, color, background: bg }}>
      {status.toUpperCase()}
    </span>
  );
}

export function Campaigns({ org, grant }: { org: string; grant: Grant | null }) {
  const [filter, setFilter] = useState<Filter>("All sends");
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  // Bumped by a lifecycle action so the schedules read re-runs: pausing a
  // series changes the lifecycle row, and leaving the table showing the
  // pre-click state is how an operator presses Pause twice.
  const [reloadKey, setReloadKey] = useState(0);
  // Two reads, not N+1. They are independent — neither's result feeds the
  // other's request — so they are separate `useAsync`es and the join happens
  // below once both have landed. Only the schedules read is keyed on
  // `reloadKey`: a lifecycle action cannot change a Campaign record, so
  // re-reading the campaign list after one would be a wasted call.
  const campaigns = useAsync(() => api.campaigns(org), [org]);
  const schedules = useAsync(() => api.schedules(org), [org, reloadKey]);
  const canSchedule = can(grant, "campaigns:schedule", org);

  const rows = useMemo(
    () => joinRows(campaigns.data ?? [], schedules.data ?? []),
    [campaigns.data, schedules.data],
  );
  const shown = useMemo(() => rows.filter((r) => matchesFilter(r, filter)), [rows, filter]);

  const act = async (scheduleId: string, action: "start" | "pause" | "archive") => {
    setBusy(`${scheduleId}:${action}`);
    setActionError("");
    try {
      await api.scheduleLifecycle(org, scheduleId, action);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy("");
    }
  };

  // The FIRST load only. A lifecycle action re-reads the schedules, and
  // `useAsync` both flips `loading` back on AND clears `data` for it — so
  // keying the skeleton on `schedules.loading` would throw a spinner over a
  // table that is already on screen and still correct, every time Pause is
  // pressed. `reloadKey > 0` is what separates a reload from the initial read;
  // mid-reload staleness is handled per-cell instead (see the Schedule column).
  const loading = campaigns.loading || (schedules.loading && reloadKey === 0);

  return (
    <div>
      <h1 className="h1">Campaigns · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        One-offs and recurring series. Reporting is per campaign, on the Campaign report screen.
        Start, pause and archive act on the schedule's lifecycle record — nothing is ever deleted.
      </p>

      {campaigns.error && <p className="err">{campaigns.error}</p>}
      {/* Reported separately and NOT fatal: the campaign list is the screen, and
          a schedules read that fails should cost the operator the lifecycle
          column and the action buttons, not the whole table. */}
      {schedules.error && (
        <p className="err">
          Schedules could not be loaded, so lifecycle state and actions are unavailable: {schedules.error}
        </p>
      )}
      {actionError && <p className="err">{actionError}</p>}

      <div className="card row" style={{ gap: 8 }}>
        {FILTERS.map((f) => (
          <button
            key={f}
            className={f === filter ? "btn" : "btn ghost"}
            aria-pressed={f === filter}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {loading && <div className="card"><div className="skeleton sk-kpi" aria-label="Loading…" /></div>}

      {!loading && campaigns.data && rows.length === 0 && (
        <div className="card muted">
          This organization has no campaigns yet. Compose one to see it here.
        </div>
      )}

      {!loading && rows.length > 0 && shown.length === 0 && (
        <div className="card muted">
          {/* "Nothing matches" is a claim about the org's campaigns. With the
              schedules read failed, the Series/One-off/Paused chips are
              filtering on a record that could not be loaded, so an empty
              result is a failure to read and not an answer. */}
          {schedules.error && filter !== "Scheduled"
            ? `Cannot tell which campaigns match “${filter}” — the schedules read failed.`
            : `No campaign matches “${filter}”.`}
        </div>
      )}

      {shown.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Type</th>
                <th>Status</th>
                <th>Schedule</th>
                {/* "List · segment", not the design's recipient count: no route
                    returns an audience size for a campaign. */}
                <th>Audience (list · segment)</th>
                {/* "Sent", not the design's Open % / Click %: those live on
                    `GET …/campaigns/{id}/report`, one call per campaign, and
                    that route has no bulk form. Two permanently empty columns,
                    or an N+1 on every paint, are both worse than the counter
                    this route does return. */}
                <th>Sent</th>
                <th>When</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const kind = campaignKind(r);
                const s = r.schedule;
                return (
                  <tr key={r.campaign.campaignId}>
                    <td className="t-strong">
                      {r.campaign.subject} <span className="muted">({r.campaign.campaignId})</span>
                    </td>
                    <td>{kind}</td>
                    <td><StatusPill status={r.campaign.status} /></td>
                    <td>
                      {/* `useAsync` clears `data` on every deps change, so a
                          lifecycle action — which bumps `reloadKey` — leaves
                          `schedules.data` undefined for the length of the
                          re-read. Without this guard every scheduled row would
                          flash "not scheduled" and lose its buttons mid-pause:
                          a false statement about a record that plainly exists,
                          made at the exact moment the operator is watching. */}
                      {s ? <LifecyclePill status={s.status} />
                        : schedules.loading ? <span className="muted">…</span>
                        // A schedules read that FAILED means this row's
                        // lifecycle state is unknown, not absent. Falling
                        // through to "not scheduled" would tell the operator
                        // every scheduled campaign in the org is unscheduled —
                        // the same false statement as the reload flash, on the
                        // path the banner above already admits is degraded.
                        : schedules.error ? <span className="muted" title="Schedules could not be read.">unknown</span>
                        : <span className="muted">not scheduled</span>}
                    </td>
                    <td className="muted">{audience(r.campaign)}</td>
                    <td>
                      {/* A recurring PARENT never accumulates: every edition
                          sends under a `<base>-<editionKey>` id that by design
                          has no Campaign item, so the parent's counter stays at
                          zero forever. Printing "0" next to a daily series that
                          has mailed for months reads as a broken counter, which
                          is precisely the #221 symptom this must not imitate. */}
                      {kind === "series" ? (
                        <span className="muted" title="Editions send under their own ids; the series parent has no aggregate counter.">
                          per edition
                        </span>
                      ) : (
                        r.campaign.sent
                      )}
                    </td>
                    <td className="muted">{campaignWhen(r)}</td>
                    <td>
                      {!s ? (
                        // Mid-reload the row's schedule is merely unread, not
                        // absent — see the Schedule cell above.
                        schedules.loading ? <span className="muted">…</span> : (
                          // No lifecycle record: this campaign has never been
                          // scheduled, so there is no schedule to start, pause
                          // or archive. An enabled button here would post a
                          // `scheduleId` the route has no record for.
                          <span className="muted">—</span>
                        )
                      ) : !canSchedule ? (
                        <span className="muted">read-only</span>
                      ) : (
                        <span style={{ display: "flex", gap: 6 }}>
                          <button className="btn ghost" disabled={s.status === "active" || !!busy} onClick={() => void act(s.scheduleId, "start")}>Start</button>
                          <button className="btn ghost" disabled={s.status !== "active" || !!busy} onClick={() => void act(s.scheduleId, "pause")}>Pause</button>
                          <button className="btn ghost" disabled={s.status === "archived" || !!busy} onClick={() => void act(s.scheduleId, "archive")}>Archive</button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="muted" style={{ marginBottom: 6 }}>What this table does not show</div>
        <p className="muted" style={{ margin: 0 }}>
          Open and click rates are per campaign and live on the report screen — there is no bulk
          rates route, so they are not columns here. Audience is the list and segment a campaign
          targets, not a recipient count: nothing computes one. A recurring series aggregates no
          counters across its editions; each edition reports on its own.
        </p>
      </div>
    </div>
  );
}
