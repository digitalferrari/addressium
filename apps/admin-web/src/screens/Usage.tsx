import { useMemo } from "react";
import { useAsync } from "../useAsync.js";
import { Kpi } from "../Kpi.js";
import { api, type UsageRecord } from "../api.js";

const usd = (n: number) => `$${n.toFixed(2)}`;
const gb = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(2)} GB`;

export function Usage({ org }: { org: string }) {
  const { data, error, loading } = useAsync(() => api.usage(org), [org]);
  const rows = useMemo(() => {
    const list: UsageRecord[] = Array.isArray(data) ? data : data ? [data] : [];
    return [...list].sort((a, b) => b.period.localeCompare(a.period));
  }, [data]);
  const latest = rows[0];
  return (
    <div>
      <h1 className="h1">Usage &amp; cost · {org || "—"}</h1>
      {loading && <div className="card muted">Loading…</div>}
      {error && <p className="err">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <div className="card muted">No usage recorded yet. Metering populates once the scheduled job has run for a period.</div>
      )}
      {latest && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>Latest period · {latest.period}</div>
          <div className="kpis">
            <Kpi n={Number(usd(latest.cost.total).slice(1))} l="total $" />
            <Kpi n={latest.emailsSent} l="emails sent" />
            <Kpi n={Number(gb(latest.athenaBytesScanned).split(" ")[0])} l="GB scanned (Athena)" />
            <Kpi n={latest.dedicatedIps} l="dedicated IPs" />
          </div>
        </div>
      )}
      {rows.length > 0 && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>Cost by period (email · storage · dedicated IP · Athena scan)</div>
          <table>
            <thead>
              <tr><th>Period</th><th>Email</th><th>Storage</th><th>Ded. IP</th><th>Athena</th><th>Total</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.period}>
                  <td>{r.period}</td>
                  <td>{usd(r.cost.email)}</td>
                  <td>{usd(r.cost.storage)}</td>
                  <td>{usd(r.cost.dedicatedIp)}</td>
                  <td title={gb(r.athenaBytesScanned)}>{usd(r.cost.athena)}</td>
                  <td className="t-strong">{usd(r.cost.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
