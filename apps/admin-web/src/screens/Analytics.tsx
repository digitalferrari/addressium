/**
 * Analytics — per-campaign counters, the per-link click table, and the funnel.
 *
 * Reads exactly one endpoint, `GET /orgs/{org}/campaigns/{campaign}/report`
 * (reports:view), which already returns counters, rates and the click map. No
 * new backend: the Links tab and the KPI row are that payload rendered, and the
 * funnel is arithmetic on counters the report already carries.
 *
 * ONE denominator, everywhere: `counters.sent`. The API's `deliverabilityRates`
 * divides by `sent` (reporting.ts), so a per-link CTR computed against
 * `delivered` — as the design prototype's mock numbers do — would silently
 * disagree with the KPI row printed directly above it. Every percentage on this
 * screen is "of sent" and the screen says so rather than leaving the reader to
 * guess which base a number used.
 *
 * `counters.opens` and `counters.clicks` are UNIQUE per subscriber (HotCounters
 * documents both, and `deriveCounters` builds them with a Set), so the "unique"
 * wording here is the data's own, not a label borrowed from the mock.
 *
 * The click-map overlay reads an authenticated decorated archive endpoint. Older
 * campaigns may still have only the Dynamo link map, so the explanatory fallback
 * remains intentional for those records.
 *
 * Arithmetic lives in exported pure helpers so it can be tested without a DOM
 * (`Analytics.test.tsx`), following `Report.tsx`'s export-for-test convention.
 */
import { useState } from "react";
import { useAsync } from "../useAsync.js";
import { Kpi } from "../Kpi.js";
import { can, type Grant } from "../rbac.js";
import { api, type AnalyticsTrends, type CampaignReport, type ClickMapRow } from "../api.js";
import { SkeletonTable } from "../Skeleton.js";

type Tab = "links" | "map" | "funnel";

/**
 * A percentage of `sent`, or `—` when nothing was sent.
 *
 * 0/0 is not 0%: a campaign that sent nothing has no open rate, and printing
 * "0.0%" invites an operator to read a send that never happened as a send
 * nobody opened.
 */
export function pctOf(n: number, denom: number): string {
  if (denom <= 0) return "—";
  return `${((n / denom) * 100).toFixed(1)}%`;
}

/** Bar width in percent, clamped to [0,100] — never NaN, never off the card. */
export function barWidth(n: number, denom: number): number {
  if (denom <= 0) return 0;
  return Math.max(0, Math.min(100, (n / denom) * 100));
}

export interface FunnelRow {
  label: string;
  value: number;
  /** Share of `sent`, as a percentage string, or `—` when nothing was sent. */
  share: string;
  width: number;
}

/**
 * The engagement funnel: sent → delivered → unique opens → unique clicks.
 *
 * Every stage is a share of `sent`, matching the KPI row and the API's own
 * rates. Opens and clicks are unique-per-subscriber counts, so they are not
 * strictly nested inside `delivered` — a funnel is the honest shape for them
 * anyway, but the widths are computed independently rather than by assuming
 * monotonic nesting the data does not guarantee.
 */
export function funnelRows(c: CampaignReport["counters"]): FunnelRow[] {
  const sent = c.sent;
  const row = (label: string, value: number): FunnelRow => ({
    label,
    value,
    share: pctOf(value, sent),
    width: barWidth(value, sent),
  });
  return [
    { label: "Sent", value: sent, share: sent > 0 ? "100.0%" : "—", width: sent > 0 ? 100 : 0 },
    row("Delivered", c.delivered),
    row("Unique opens", c.opens),
    row("Unique clicks", c.clicks),
  ];
}

/**
 * `sent − delivered − bounces − rejects`: how much of the send has not yet
 * resolved either way.
 *
 * Deliberately NOT presented as the delivery-delay count. SES emits more than
 * one event per message — a message delayed and then delivered counts in both —
 * so this residual can go negative on real data, which is why it is clamped at
 * zero and labelled a derivation. The real count is `counters.deliveryDelays`
 * and it is rendered from the counter itself on the Links tab.
 */
export function unresolved(c: CampaignReport["counters"]): number {
  return Math.max(0, c.sent - c.delivered - c.bounces - c.rejects);
}

/** Per-link CTR is a share of `sent`, same base as every other rate here. */
export function linkCtr(row: ClickMapRow, sent: number): string {
  return pctOf(row.clicks, sent);
}

export function Analytics({ org, grant }: { org: string; grant: Grant | null }) {
  const campaigns = useAsync(() => api.campaigns(org), [org]);
  const trends = useAsync(() => api.analyticsTrends(org, 30), [org]);
  const [campaign, setCampaign] = useState("");
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [tab, setTab] = useState<Tab>("links");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [archiveHtml, setArchiveHtml] = useState<string | null>(null);

  const load = async () => {
    setErr("");
    setReport(null);
    setArchiveHtml(null);
    setLoading(true);
    try {
      const next = await api.report(org, campaign);
      setReport(next);
      try {
        setArchiveHtml((await api.archive(org, campaign)).html);
      } catch {
        // Older sends may have the Dynamo archive/link map but predate the
        // generic S3 body. Keep the report useful and explain that state below.
        setArchiveHtml(null);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  if (!can(grant, "reports:view", org)) {
    return (
      <div>
        <div className="pagehead"><div><h1>Analytics</h1><p>Campaign counters, deliverability rates and the per-link click table.</p></div></div>
        <p className="muted">Your role can't view reports.</p>
      </div>
    );
  }

  const c = report?.counters;
  const rows = report?.clickMap.rows ?? [];

  return (
    <div>
      <div className="pagehead"><div><h1>Analytics</h1><p>Campaign counters, deliverability rates and the per-link click table.</p></div></div>
      <p className="muted">
        Per-campaign counters, deliverability rates and the per-link click table. Every percentage on this screen is a
        share of <b>sent</b>. Campaign opens and clicks are counted once per subscriber;
        per-link clicks count all recorded click events.
      </p>

      <div className="card row">
        <select aria-label="Campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
          <option value="">Choose a campaign…</option>
          {(campaigns.data ?? []).map((x) => (
            <option key={x.campaignId} value={x.campaignId}>
              {x.subject} ({x.campaignId})
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void load()} disabled={!campaign || loading}>
          {loading ? "Loading…" : "Load"}
        </button>
      </div>

      {campaigns.error && <p className="err">{campaigns.error}</p>}
      {err && <p className="err">{err}</p>}

      <TrendsPanel trends={trends.data} loading={trends.loading} error={trends.error} />

      {report && c && (
        <>
          <div className="card">
            {/* The shared tile, with the rate folded into the label — the same
                idiom `Report.tsx` uses, rather than a second KPI markup. */}
            <div className="kpis">
              <Kpi n={c.delivered} l={`delivered · ${pctOf(c.delivered, c.sent)} of sent`} />
              <Kpi n={c.opens} l={`unique opens · ${pctOf(c.opens, c.sent)}`} />
              <Kpi n={c.clicks} l={`unique clicks · ${pctOf(c.clicks, c.sent)} CTR`} />
              <Kpi
                n={c.unsubscribes + c.complaints}
                l={`unsub / complaint · ${pctOf(c.unsubscribes + c.complaints, c.sent)}`}
              />
            </div>
          </div>

          <div className="card row" role="tablist">
            <button
              className={tab === "links" ? "btn" : "btn ghost"}
              role="tab"
              aria-selected={tab === "links"}
              onClick={() => setTab("links")}
            >
              Links
            </button>
            <button
              className={tab === "map" ? "btn" : "btn ghost"}
              role="tab"
              aria-selected={tab === "map"}
              onClick={() => setTab("map")}
            >
              Click map
            </button>
            <button
              className={tab === "funnel" ? "btn" : "btn ghost"}
              role="tab"
              aria-selected={tab === "funnel"}
              onClick={() => setTab("funnel")}
            >
              Funnel
            </button>
          </div>

          {tab === "links" && <LinksTab report={report} />}
          {tab === "map" && <ClickMapTab rowCount={rows.length} archiveHtml={archiveHtml} />}
          {tab === "funnel" && <FunnelTab report={report} />}
        </>
      )}
    </div>
  );
}

export function TrendsPanel({ trends, loading, error }: { trends?: AnalyticsTrends | null; loading: boolean; error?: string }) {
  const points = trends?.points ?? [];
  const maxSent = Math.max(1, ...points.map((point) => point.sent));
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>30-day trends</strong>
          <div className="muted">Daily event totals across campaigns. Opens and clicks are unique subscribers per day.</div>
        </div>
        {trends && <span className="muted">{trends.from} → {trends.through}</span>}
      </div>
      {loading && <SkeletonTable rows={4} label="Loading trends…" />}
      {error && <p className="muted">Trends unavailable: {error}</p>}
      {!loading && !error && trends && (
        <>
          {trends.summary && <TrendSummary summary={trends.summary} />}
          {points.every((point) => point.sent === 0 && point.delivered === 0 && point.opens === 0 && point.clicks === 0 && point.bounces === 0 && point.complaints === 0) ?
            <p className="muted">No events in this window.</p> :
            <table>
            <thead><tr><th>Date</th><th>Sent</th><th>Delivered</th><th>Opens</th><th>Clicks</th><th /></tr></thead>
            <tbody>
              {points.filter((point) => point.sent || point.delivered || point.opens || point.clicks || point.bounces || point.complaints).map((point) => (
                <tr key={point.date}>
                  <td>{point.date}</td>
                  <td>{point.sent}</td>
                  <td>{point.delivered}</td>
                  <td>{point.opens} <span className="muted">({pctOf(point.opens, point.sent)})</span></td>
                  <td>{point.clicks} <span className="muted">({pctOf(point.clicks, point.sent)})</span></td>
                  <td style={{ width: "24%" }}><div className="bar" style={{ width: `${barWidth(point.sent, maxSent)}%` }} /></td>
                </tr>
              ))}
            </tbody>
            </table>}
        </>
      )}
    </div>
  );
}

function comparison(current: number, previous: number): string {
  if (previous <= 0) return "—";
  const delta = ((current - previous) / previous) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}% vs prior period`;
}

function TrendSummary({ summary }: { summary: NonNullable<AnalyticsTrends["summary"]> }) {
  return (
    <div className="kpis" style={{ margin: "14px 0" }}>
      <Kpi n={summary.subscriberCount} l="subscribers" />
      <Kpi n={summary.current.emailsSent} l={`emails sent · ${comparison(summary.current.emailsSent, summary.previous.emailsSent)}`} />
      <Kpi n={`${(summary.current.openRate * 100).toFixed(1)}%`} l={`average open rate · ${comparison(summary.current.openRate, summary.previous.openRate)}`} />
      <Kpi n={`${(summary.current.clickRate * 100).toFixed(1)}%`} l={`average click rate · ${comparison(summary.current.clickRate, summary.previous.clickRate)}`} />
    </div>
  );
}

function LinksTab({ report }: { report: CampaignReport }) {
  const c = report.counters;
  const rows = report.clickMap.rows;
  // Widths are relative to the busiest link, not to `sent` — a 3% CTR would
  // otherwise draw every bar as an invisible sliver.
  const maxClicks = Math.max(1, ...rows.map((r) => r.clicks));
  const maxEvent = Math.max(1, c.bounces, c.rejects, c.deliveryDelays, c.renderingFailures);

  return (
    <>
      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>
          Recorded links from the campaign archive. Clicks count events; Unique counts subscribers
          per link. Clicks / sent includes repeat clicks and can exceed 100%.
        </div>
        {rows.length === 0 ? (
          // An empty table would read as "zero clicks on every link". The
          // distinction that matters: no link map was recorded for this
          // campaign at all, which is not the same as nobody clicking.
          <p className="muted">
            No link map recorded for this campaign. The click table is built from the archived link map written at send
            time, so campaigns sent before that record existed — or sends with no trackable links — have nothing to show
            here.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Link</th>
                <th>Clicks</th>
                <th>Unique</th>
                <th>Clicks / sent</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.linkId}>
                  <td title={r.urlTemplate}>{r.label}</td>
                  <td>{r.clicks}</td>
                  <td>{r.unique}</td>
                  <td>{linkCtr(r, c.sent)}</td>
                  <td style={{ width: "30%" }}>
                    <div className="bar" style={{ width: `${barWidth(r.clicks, maxClicks)}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>
          Every other delivery event — its own counter each
        </div>
        <table>
          <tbody>
            {(
              [
                ["Bounces", c.bounces],
                ["Rejects", c.rejects],
                ["Delivery delays", c.deliveryDelays],
                ["Rendering failures", c.renderingFailures],
              ] as const
            ).map(([label, n]) => (
              <tr key={label}>
                <td style={{ width: 150 }}>{label}</td>
                <td style={{ width: 70 }}>{n}</td>
                <td>
                  <div className="bar" style={{ width: `${barWidth(n, maxEvent)}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          None of rejects, delivery delays or rendering failures suppresses anyone. A <b>reject</b> is SES accepting the
          message and then refusing to send it — nothing reached a receiver, so it is not a bounce. A{" "}
          <b>delivery delay</b> records a temporary delivery problem, such as a full mailbox or
          throttling; a later delivery may also be counted. A <b>rendering failure</b> records
          SES failing to render a template, for example because template data is missing.
        </p>
      </div>
    </>
  );
}

/**
 * The overlay tab. This is not a load failure and not a temporary empty state —
 * the archived body it would paint onto is never written, so the tab explains
 * the gap and points at the half that does ship.
 */
function ClickMapTab({ rowCount, archiveHtml }: { rowCount: number; archiveHtml: string | null }) {
  if (archiveHtml) {
    return <div className="card">
      <div className="muted" style={{ marginBottom: 8 }}>Click map · archived copy</div>
      <p className="muted">Click counts are attached to the links below. The preview is the generic campaign body; recipient-specific values and magic-link tokens are intentionally not shown.</p>
      <iframe title="Campaign click map" srcDoc={archiveHtml} style={{ width: "100%", minHeight: 520, border: "1px solid var(--border)", borderRadius: 8, background: "white" }} sandbox="" />
    </div>;
  }
  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 8 }}>
        Click map · archived copy
      </div>
      <p className="muted">
        <b>Archive preview unavailable for this campaign.</b> The click counts themselves are real and complete
        {rowCount > 0 ? ` — all ${rowCount} of them are on the Links tab.` : "; they appear on the Links tab once a campaign has a recorded link map."}
      </p>
      <p className="muted">
        New sends write a generic rendered body and the reporting service decorates it with click badges. This older
        campaign either predates that body or the archive read is temporarily unavailable, so the Links tab remains
        the authoritative click data.
      </p>
    </div>
  );
}

function FunnelTab({ report }: { report: CampaignReport }) {
  const c = report.counters;
  const rows = funnelRows(c);
  const stuck = unresolved(c);

  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 12 }}>
        Engagement funnel — each stage as a share of sent
      </div>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td style={{ width: 130 }}>{r.label}</td>
              <td style={{ width: 150 }}>
                {r.value} · {r.share}
              </td>
              <td>
                <div className="bar" style={{ width: `${r.width}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Unresolved estimate: <b>{stuck}</b> — derived as sent − delivered − bounces − rejects ({c.sent} − {c.delivered}{" "}
        − {c.bounces} − {c.rejects}), clamped at zero. This is a derivation, not a count: SES emits more than one event
        per message, so it is not the same figure as the <b>{c.deliveryDelays}</b> delivery delays counted on the Links
        tab.
      </p>
    </div>
  );
}
