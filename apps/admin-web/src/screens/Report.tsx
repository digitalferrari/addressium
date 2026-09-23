/**
 * Campaign click-map report (#32). Exported for `Report.test.tsx` (#253).
 */
import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { Kpi } from "../Kpi.js";
import { can, type Grant } from "../rbac.js";
import { api, type CampaignReport } from "../api.js";

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
  const [campaign, setCampaign] = useState(initialCampaign ?? "");
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [err, setErr] = useState("");

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
        <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
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
      {!can(grant, "reports:view", org) && <p className="muted">Your role can't view reports.</p>}
    </div>
  );
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
