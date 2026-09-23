/**
 * Campaign click-map report (#32). Exported for `Report.test.tsx` (#253).
 */
import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { Kpi } from "../Kpi.js";
import { can, type Grant } from "../rbac.js";
import { api, type CampaignReport, type SeriesReport } from "../api.js";

export function Report({
  org,
  grant,
  initialCampaign,
}: {
  org: string;
  grant: Grant | null;
  /** Preselected when arriving from a link elsewhere (e.g. a Schedules row). */
  initialCampaign?: string;
}) {
  const campaigns = useAsync(() => api.campaigns(org), [org]);
  const series = useAsync(() => api.series(org), [org]);
  const [campaign, setCampaign] = useState(initialCampaign ?? "");
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [err, setErr] = useState("");
  // A recurring series is reported per EDITION, not as one campaign: each
  // firing has its own campaignId and its own counters, so a bad send is
  // visible instead of being averaged into the series total.
  const [seriesId, setSeriesId] = useState("");
  const [seriesReport, setSeriesReport] = useState<SeriesReport | null>(null);
  const [from, setFrom] = useState("");
  const [through, setThrough] = useState("");

  const loadSeries = async (id: string = seriesId) => {
    setErr(""); setSeriesReport(null);
    try {
      setSeriesReport(await api.seriesReport(org, id));
    } catch (e) {
      setErr(String(e));
    }
  };

  /**
   * Filter editions to the chosen window, client-side.
   *
   * The edition id is `<series>-<editionKey>` and the key is the firing
   * timestamp, so a lexical compare on the suffix IS a chronological one. The
   * route returns every edition; when a daily series has years of history this
   * should move server-side, but filtering what we already fetched is honest
   * for now and needs no API change.
   */
  const editionsInRange = (seriesReport?.editions ?? []).filter((e) => {
    if (!from && !through) return true;
    const key = e.campaignId.slice(seriesId.length + 1);
    if (from && key < from) return false;
    if (through && key > `${through}\uffff`) return false;
    return true;
  });

  /**
   * Rates over the window, computed from the SUMMED counters.
   *
   * Never an average of per-edition rates: that weights a 200-recipient test
   * send the same as a 20,000-recipient edition and quietly misreports the
   * month.
   */
  const rangeTotals = editionsInRange.reduce(
    (acc, e) => {
      for (const k of Object.keys(e.counters) as Array<keyof typeof e.counters>) {
        acc[k] = (acc[k] ?? 0) + (e.counters[k] ?? 0);
      }
      return acc;
    },
    {} as Record<string, number>,
  );
  const rate = (n: number) =>
    rangeTotals.delivered ? `${((n / rangeTotals.delivered) * 100).toFixed(1)}%` : "—";

  const load = async (id: string = campaign) => {
    setErr(""); setReport(null);
    try {
      setReport(await api.report(org, id));
    } catch (e) {
      setErr(String(e));
    }
  };

  // Arriving from a link means the operator already chose a campaign; making
  // them press Load again would be asking the same question twice. Keyed on the
  // id so navigating from one row to another re-reads rather than showing the
  // previous campaign's report under the new name.
  useEffect(() => {
    if (!initialCampaign) return;
    setCampaign(initialCampaign);
    void load(initialCampaign);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCampaign, org]);

  const maxClicks = report ? Math.max(1, ...report.clickMap.rows.map((r) => r.clicks)) : 1;
  return (
    <div>
      <h1 className="h1">Campaign report</h1>
      <div className="card row">
        {/* Labelled for the same reason as the series picker below: two
            unlabelled selects on one screen are indistinguishable to a screen
            reader, and to anything querying by role. */}
        <label htmlFor="campaign-picker" style={{ margin: 0 }}>Campaign</label>
        <select
          id="campaign-picker"
          value={campaign}
          onChange={(e) => setCampaign(e.target.value)}
        >
          <option value="">Choose a campaign…</option>
          {(campaigns.data ?? []).map((c) => (
            <option key={c.campaignId} value={c.campaignId}>{c.subject} ({c.campaignId})</option>
          ))}
        </select>
        <button className="btn" onClick={() => void load()} disabled={!campaign}>Load</button>
      </div>
      {err && <p className="err">{err}</p>}
      {report && (
        <>
          <div className="card">
            <div className="kpis">
              <Kpi n={report.counters.sent} l="sent" />
              {/* `delivered` is the denominator an operator actually reasons
                  about — "sent" is what SES accepted, not what arrived — and it
                  was computed, returned and then discarded here (#253). */}
              <Kpi n={report.counters.delivered} l="delivered" />
              <Kpi n={report.counters.opens} l={`opens (${pct(report.rates.openRate)})`} />
              <Kpi n={report.counters.clicks} l={`clicks (${pct(report.rates.clickRate)})`} />
              <Kpi n={report.counters.bounces} l={`bounces (${pct(report.rates.bounceRate)})`} />
              <Kpi n={report.counters.complaints} l={`complaints (${pct(report.rates.complaintRate)})`} />
              <Kpi n={report.counters.unsubscribes} l="unsubscribes" />
              {/* Kept next to the delivery counters rather than hidden behind a
                  zero check: `rejects` is SES refusing the message outright, and
                  `renderingFailures` means a merge tag did not resolve — the one
                  counter on this screen pointing at OUR bug rather than a
                  recipient's mailbox. A row that only appears when it is nonzero
                  is a row nobody knows to look for. */}
              <Kpi n={report.counters.rejects} l="rejects" />
              <Kpi n={report.counters.renderingFailures} l="rendering failures" />
              <Kpi n={report.counters.deliveryDelays} l="delivery delays" />
            </div>
          </div>
          <div className="card">
            <div className="muted" style={{ marginBottom: 8 }}>Click overlay — editorial links</div>
            <table>
              <thead><tr><th>Link</th><th>Clicks</th><th>Unique</th><th></th></tr></thead>
              <tbody>
                {report.clickMap.rows.map((r) => (
                  <tr key={r.linkId}>
                    <td>{r.label}</td>
                    <td>{r.clicks}</td>
                    <td>{r.unique}</td>
                    <td style={{ width: "40%" }}><div className="bar" style={{ width: `${(r.clicks / maxClicks) * 100}%` }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h2 style={{ marginTop: 28 }}>Recurring series</h2>
      <p className="muted" style={{ marginTop: -8 }}>
        {/* The distinction that matters: a series is not one campaign. Each
            firing is its own edition with its own counters, so a bad send shows
            up instead of being averaged away. */}
        Every edition of a series is reported separately. Pick a window to total
        them.
      </p>
      <div className="card row">
        <label htmlFor="series-picker" style={{ margin: 0 }}>Series</label>
        <select
          id="series-picker"
          value={seriesId}
          onChange={(e) => { setSeriesId(e.target.value); setSeriesReport(null); }}
        >
          <option value="">Choose a series…</option>
          {(series.data ?? []).map((s) => (
            <option key={s.seriesId} value={s.seriesId}>{s.name} ({s.seriesId})</option>
          ))}
        </select>
        <button className="btn" onClick={() => void loadSeries()} disabled={!seriesId}>Load editions</button>
      </div>

      {seriesReport && (
        <>
          <div className="card row" style={{ alignItems: "center", gap: 12 }}>
            {/* Explicitly associated: a bare <label> next to an <input> reads
                as unlabelled to a screen reader, and the two date fields are
                indistinguishable without it. */}
            <label htmlFor="series-from" style={{ margin: 0 }}>From</label>
            <input
              id="series-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <label htmlFor="series-through" style={{ margin: 0 }}>Through</label>
            <input
              id="series-through"
              type="date"
              value={through}
              onChange={(e) => setThrough(e.target.value)}
            />
            {(from || through) && (
              <button className="btn ghost" onClick={() => { setFrom(""); setThrough(""); }}>Clear</button>
            )}
            <span className="muted">
              {editionsInRange.length} of {seriesReport.editions.length} edition
              {seriesReport.editions.length === 1 ? "" : "s"}
            </span>
          </div>

          {editionsInRange.length === 0 ? (
            <div className="card muted">No editions in this window.</div>
          ) : (
            <>
              <div className="card">
                <div className="muted" style={{ marginBottom: 8 }}>
                  Totals for the window — rates are computed from the summed counters,
                  not averaged across editions.
                </div>
                <div className="kpis">
                  <Kpi n={rangeTotals.sent ?? 0} l="sent" />
                  <Kpi n={rangeTotals.delivered ?? 0} l="delivered" />
                  <Kpi n={rangeTotals.opens ?? 0} l={`opens (${rate(rangeTotals.opens ?? 0)})`} />
                  <Kpi n={rangeTotals.clicks ?? 0} l={`clicks (${rate(rangeTotals.clicks ?? 0)})`} />
                  <Kpi n={rangeTotals.bounces ?? 0} l={`bounces (${rate(rangeTotals.bounces ?? 0)})`} />
                  <Kpi n={rangeTotals.complaints ?? 0} l="complaints" />
                  <Kpi n={rangeTotals.unsubscribes ?? 0} l="unsubscribes" />
                </div>
              </div>

              <div className="card">
                <div className="muted" style={{ marginBottom: 8 }}>Editions, newest first</div>
                <table>
                  <thead>
                    <tr>
                      <th>Edition</th><th>Subject</th><th>Sent</th><th>Delivered</th>
                      <th>Opens</th><th>Clicks</th><th>Bounces</th><th>Unsubs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editionsInRange.map((e) => (
                      <tr key={e.campaignId}>
                        <td className="t-strong">{e.campaignId.slice(seriesId.length + 1) || e.campaignId}</td>
                        <td>{e.subject}</td>
                        <td className="num">{e.counters.sent}</td>
                        <td className="num">{e.counters.delivered}</td>
                        <td className="num">{e.counters.opens}</td>
                        <td className="num">{e.counters.clicks}</td>
                        <td className="num">{e.counters.bounces}</td>
                        <td className="num">{e.counters.unsubscribes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {!can(grant, "reports:view", org) && <p className="muted">Your role can't view reports.</p>}
    </div>
  );
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
