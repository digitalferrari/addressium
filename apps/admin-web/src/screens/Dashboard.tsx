/**
 * Dashboard and the system-health badge that sits above it.
 *
 * `Dashboard` is exported for `Dashboard.test.tsx` (#261); `HealthBadge` is
 * rendered by `App.tsx` as a sibling in the view switch, not from inside
 * `Dashboard`.
 */
import { useMemo } from "react";
import { useAsync } from "../useAsync.js";
import { relativeTime } from "../time.js";
import { api, type AlertConfig, type AlertRule, type CampaignReport, type CampaignRow, type SetupState } from "../api.js";

/**
 * A campaign's status rendered as a colour, not just a word (#261).
 *
 * `halted` is the one an operator must not scan past: it means a send crossed an
 * alert threshold and stopped mid-flight with part of the list mailed. Letting
 * it render in the same neutral grey as `sent` is how a halted edition sits
 * unnoticed on the landing page for a day.
 */
const CAMPAIGN_STATUS_COLOR: Record<string, string> = {
  sent: "#15803d",
  sending: "#2563eb",
  scheduled: "#b45309",
  halted: "#b91c1c",
  draft: "#6b7280",
};

/** Newest first by send time; campaigns with no schedule (drafts) sort last. */
function byMostRecentSend(a: CampaignRow, b: CampaignRow): number {
  const at = a.sendAt ? new Date(a.sendAt).getTime() : NaN;
  const bt = b.sendAt ? new Date(b.sendAt).getTime() : NaN;
  const av = Number.isNaN(at) ? -Infinity : at;
  const bv = Number.isNaN(bt) ? -Infinity : bt;
  return bv - av;
}

/**
 * What the Dashboard needs that takes more than one call (#261).
 *
 * The deliverability panel reports on the LATEST SENT edition, and which
 * campaign that is only becomes known once `campaigns` has resolved — so the
 * two reads are genuinely sequential and live in one `useAsync`. Splitting them
 * would mean a second `useAsync` firing `api.report(org, "")` on the first
 * render, because `useAsync` runs its function on every deps change and has no
 * way to skip.
 *
 * The report is caught separately: an org that has never sent, or a report route
 * that 4xx's for this caller, must cost the operator the deliverability panel
 * and nothing else. Blanking the campaign list over it would throw away the part
 * of the screen that did load.
 */
async function loadDashboardSending(org: string): Promise<{
  campaigns: CampaignRow[];
  latestSent?: CampaignRow;
  report?: CampaignReport;
  reportError?: string;
}> {
  const campaigns = await api.campaigns(org);
  // The route sorts by `campaignId.localeCompare` descending, which is id order
  // and not time order — ids are operator-chosen stems, so "latest" has to be
  // re-derived from `sendAt` here rather than trusted from the response.
  const latestSent = [...campaigns].filter((c) => c.status === "sent").sort(byMostRecentSend)[0];
  if (!latestSent) return { campaigns };
  try {
    return { campaigns, latestSent, report: await api.report(org, latestSent.campaignId) };
  } catch (e) {
    return { campaigns, latestSent, reportError: String(e) };
  }
}

/**
 * Dashboard (#261). The landing page of a sending tool used to be a count of
 * lists: it told an operator nothing about sending.
 *
 * What it now shows is bounded by what can be DERIVED from an endpoint that
 * exists. The prototype's `demo/index.html` dashboard has four parts, and it
 * flags two of them `Not yet built` itself: the rolling-30-day KPI strip
 * (`demo/index.html:525` — total subscribers, emails sent 30d, average open and
 * click rates, each with a "vs last month" delta) and the trend chart
 * (`:534`). Neither is built here, and not merely out of deference to the
 * prototype — nothing on the wire can produce those numbers. `GET
 * /orgs/{org}/subscribers` is a PAGE with a cursor and no total, so "total
 * subscribers" has no source; no endpoint aggregates across campaigns or over a
 * window, so a 30-day average and every delta would have to be invented. A
 * fabricated rate on a deliverability screen is worse than an absent one: it is
 * the number someone decides not to investigate a complaint rate over.
 *
 * The two panels the prototype does NOT flag are the two built here, because
 * both are per-campaign counters `campaignReport` already returns and
 * thresholds `GET /orgs/{org}/alerts` already returns.
 *
 * The health badge is rendered by `HealthBadge` as a sibling in the view switch,
 * not from inside this component.
 */
export function Dashboard({ org, onGoToSetup }: { org: string; onGoToSetup: () => void }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const setup = useAsync(() => api.setup(org), [org]);
  // Deliberately three independent reads rather than one `Promise.all`. Each
  // panel fails on its own: an org with no alert config must not blank the
  // campaign list, and a campaigns route the caller lacks `reports:view` for
  // must not hide the setup nag that tells them why the org cannot send.
  const alerts = useAsync(() => api.alertConfig(org), [org]);
  const sending = useAsync(() => loadDashboardSending(org), [org]);

  const recent = useMemo(
    () => [...(sending.data?.campaigns ?? [])].sort(byMostRecentSend).slice(0, 6),
    [sending.data],
  );

  return (
    <div>
      <h1 className="h1">Dashboard · {org || "—"}</h1>
      {setup.data && !setup.data.complete && (
        <div className="card" style={{ borderLeft: "3px solid #d99" }}>
          <div className="t-strong">Finish setting up this organization</div>
          <p className="muted" style={{ margin: "4px 0 8px" }}>
            {setup.data.requiredDone} of {setup.data.requiredTotal} required steps done — you can't send safely until they're complete.
          </p>
          <button className="btn" onClick={onGoToSetup}>Go to Setup</button>
        </div>
      )}

      <DeliverabilityPanel
        latest={sending.data?.latestSent}
        report={sending.data?.report}
        reportError={sending.data?.reportError}
        alerts={alerts}
        setup={setup.data}
        loading={sending.loading}
        error={sending.error}
      />

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>Recent campaigns</div>
        {sending.loading && <div className="skeleton sk-kpi" aria-label="Loading…" />}
        {sending.error && <p className="err">{sending.error}</p>}
        {sending.data && recent.length === 0 && (
          <p className="muted">This organization has not composed a campaign yet.</p>
        )}
        {recent.length > 0 && (
          <table>
            <thead><tr><th>Campaign</th><th>Status</th><th>Sent to</th><th>When</th></tr></thead>
            <tbody>
              {recent.map((c) => (
                <tr key={c.campaignId}>
                  <td className="t-strong">{c.subject} <span className="muted">({c.campaignId})</span></td>
                  <td style={{ color: CAMPAIGN_STATUS_COLOR[c.status] ?? "#6b7280", fontWeight: 600 }}>{c.status}</td>
                  {/* `sent` is SES acceptances for this campaign — the counter
                      the row carries. It is NOT an audience size: a draft has
                      never sent and shows 0, which is a fact about the send and
                      not a claim about how many subscribers the list has. */}
                  <td>{c.sent}</td>
                  <td>{campaignWhen(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="muted">Newsletters</div>
        {lists.loading && <div className="skeleton sk-kpi" style={{ width: 140, marginTop: 8 }} aria-label="Loading…" />}
        {lists.error && <p className="err">{lists.error}</p>}
        {lists.data && <p className="kpi"><span className="n">{lists.data.length}</span> <span className="l">lists</span></p>}
      </div>
    </div>
  );
}

/** A campaign's send time, absolute plus relative; a dash when it has none. */
function campaignWhen(c: CampaignRow): string {
  if (!c.sendAt) return "—";
  const at = new Date(c.sendAt);
  // A stored value that does not parse must not reach the operator as
  // "Invalid Date", which reads as a state of the send rather than a bad record.
  if (Number.isNaN(at.getTime())) return "—";
  const rel = relativeTime(c.sendAt);
  return `${at.toLocaleString()}${rel ? ` (${rel})` : ""}`;
}

/**
 * Deliverability for the latest SENT edition (#261).
 *
 * Rates are that one edition's own counters — NOT a 30-day aggregate, which
 * nothing computes — and the panel says so, because "0.6% bounces" means
 * different things over one send and over a month.
 *
 * Every rate is shown against the org's own halt threshold rather than against a
 * hard-coded industry figure, so the line an operator reads is the line that
 * will actually stop their next campaign.
 */
function DeliverabilityPanel({
  latest, report, reportError, alerts, setup, loading, error,
}: {
  latest?: CampaignRow;
  report?: CampaignReport;
  reportError?: string;
  alerts: { data?: AlertConfig | null; error?: string; loading: boolean };
  setup?: SetupState;
  loading: boolean;
  error?: string;
}) {
  const rule = (metric: AlertRule["metric"]) =>
    (alerts.data?.rules ?? []).find((r) => r.metric === metric);

  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 8 }}>Deliverability · latest edition</div>
      {loading && <div className="skeleton sk-kpi" aria-label="Loading…" />}
      {error && <p className="err">{error}</p>}
      {!loading && !error && !latest && (
        <p className="muted">
          No campaign has finished sending yet — there is nothing to report on.
        </p>
      )}
      {reportError && (
        // Distinct from "nothing sent yet": a campaign DID send and its counters
        // could not be read, which is a failure to investigate rather than a
        // quiet state of the org.
        <p className="err">Could not load the report for {latest?.campaignId}: {reportError}</p>
      )}
      {latest && report && (
        <>
          <div className="t-strong">{latest.subject} <span className="muted">({latest.campaignId})</span></div>
          <table>
            <thead><tr><th>Measure</th><th>Rate</th><th></th><th>Halt threshold</th></tr></thead>
            <tbody>
              <RateRow
                label="Delivered"
                // Computed here rather than read from `rates`: the report returns
                // open/click/bounce/complaint rates and no delivered rate, and
                // `delivered` (what arrived) is the denominator an operator
                // reasons about, not `sent` (what SES accepted) — see #253.
                rate={report.counters.sent > 0 ? report.counters.delivered / report.counters.sent : undefined}
                color="#15803d"
                // No `AlertRule` metric governs the delivered rate, so this row
                // has no threshold to be missing — "none set" would read as
                // configuration an operator could supply and had not.
                thresholdApplies={false}
              />
              <RateRow label="Bounces" rate={report.rates.bounceRate} color="#b45309" rule={rule("bounce_rate")} />
              <RateRow label="Complaints" rate={report.rates.complaintRate} color="#b91c1c" rule={rule("complaint_rate")} />
            </tbody>
          </table>
          <dl className="muted" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: "12px 0 0" }}>
            <dt>Auto-halt</dt>
            <dd style={{ margin: 0 }}>
              {/* `alertConfig` returning null means this org has NO thresholds —
                  nothing will stop a campaign that starts generating complaints.
                  Rendering that as zeros, or as a quiet blank, is how an
                  unprotected org looks identical to a protected one (#217). */}
              {alerts.loading ? "…"
                : alerts.error ? `Unknown — ${alerts.error}`
                : !alerts.data ? "Not armed — this organization has no thresholds."
                : alerts.data.rules.some((r) => r.enabled) ? "Armed"
                : "Not armed — every threshold is disabled."}
            </dd>
            <dt>Org setup</dt>
            <dd style={{ margin: 0 }}>
              {setup ? `${setup.requiredDone} / ${setup.requiredTotal} required` : "…"}
            </dd>
          </dl>
          <p className="muted" style={{ marginBottom: 0 }}>
            Rates are this edition's own counters, not a 30-day aggregate. Averages over
            a window, audience totals and the trend chart are not built — nothing on the
            API aggregates across campaigns, so there is no honest number to show.
            DKIM/SPF/DMARC state and the SES send quota are not readable at all.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * A rate at the precision the DECISION needs, unlike the shared `pct` (#261).
 *
 * `pct` is one decimal place, which is right for the open and click rates it
 * was written for. It is wrong here: a complaint halt threshold is 0.3% and its
 * warn is 0.1%, so one decimal place collapses the entire actionable range into
 * four values and renders a 0.03% complaint rate as "0.0%" — indistinguishable
 * from an org generating no complaints at all, on the panel whose job is to show
 * exactly that difference. Small values therefore keep three decimals.
 *
 * Deliberately NOT a change to `pct`, which the Report screen shares.
 */
function ratePct(x: number): string {
  const p = x * 100;
  return `${p !== 0 && p < 1 ? p.toFixed(3) : p.toFixed(1)}%`;
}

/**
 * One rate, its bar, and the threshold that would halt a send at it.
 *
 * The bar is scaled against the halt threshold, not against 100%: a 0.3%
 * complaint rate is a stop-everything number, and drawn on a 0-100 scale it is
 * an invisible sliver. With no threshold configured the bar is omitted rather
 * than drawn on an invented scale.
 *
 * `thresholdApplies: false` marks a row that no rule can ever govern — there is
 * no delivered-rate metric in `AlertRule`. That is a different statement from
 * "none set", which says an operator could configure one and has not.
 */
function RateRow({ label, rate, color, rule, thresholdApplies = true }: {
  label: string; rate?: number; color: string; rule?: AlertRule; thresholdApplies?: boolean;
}) {
  const halt = rule?.enabled ? rule.haltAt : undefined;
  return (
    <tr>
      <td className="t-strong">{label}</td>
      {/* An undefined rate is a campaign with a zero denominator — "not
          computable", which is not the same statement as "0%". */}
      <td>{rate === undefined ? <span className="muted">n/a</span> : ratePct(rate)}</td>
      <td style={{ width: "40%" }}>
        {rate !== undefined && halt !== undefined && halt > 0 && (
          <div className="bar" style={{ width: `${Math.min(100, (rate / halt) * 100)}%`, background: color }} />
        )}
      </td>
      <td className="muted">
        {!thresholdApplies ? "—" : halt === undefined ? "none set" : ratePct(halt)}
      </td>
    </tr>
  );
}

/**
 * System health (#229, compendium #29) — ONE derived verdict.
 *
 * Deliberately not a list of alarm names. A marketer reading
 * `SendDlqNotEmptyAlarm` in a campaign tool learns nothing they can act on, and
 * the detail belongs on the CloudWatch dashboard where the runbook lives. The
 * composition happens server-side so the SPA holds no CloudWatch permission.
 */
export function HealthBadge({ org }: { org: string }) {
  const h = useAsync(() => api.health(org), [org]);
  if (h.loading || h.error || !h.data) return null;

  const { status, alarmsInAlarm, reason } = h.data;
  // "unknown" is kept distinct from "degraded": a health check that cannot run
  // is not evidence that the system is unhealthy, and conflating them sends
  // someone to debug the mail pipeline over a missing IAM permission.
  const style: Record<string, { label: string; color: string; note: string }> = {
    ok: { label: "System OK", color: "#15803d", note: "No alarms firing." },
    degraded: {
      label: "Degraded",
      color: "#b45309",
      note: `${alarmsInAlarm} alarm${alarmsInAlarm === 1 ? "" : "s"} firing — see the CloudWatch dashboard.`,
    },
    unknown: { label: "Health unknown", color: "#6b7280", note: reason ?? "Could not read alarm state." },
  };
  const s = style[status] ?? style["unknown"]!;

  return (
    <div className="card" style={{ borderColor: s.color }}>
      <strong style={{ color: s.color }}>{s.label}</strong>
      <div className="muted">{s.note}</div>
    </div>
  );
}
