import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { Kpi } from "../Kpi.js";
import { api } from "../api.js";

export function ImportSubscribers({ org }: { org: string }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const [listId, setListId] = useState("");
  const [csv, setCsv] = useState("");
  const [status, setStatus] = useState<"pending" | "confirmed">("pending");
  const [report, setReport] = useState<{ imported: number; skipped: number; suppressed: number; dryRun: boolean } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (lists.data && lists.data.length > 0 && !listId) setListId(lists.data[0]!.listId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists.data]);

  const run = async (dryRun: boolean) => {
    setMsg(""); setReport(null); setBusy(true);
    try {
      setReport(await api.importCsv(org, listId, csv, dryRun, status));
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };
  const valid = !!listId && csv.trim() !== "";

  return (
    <div>
      <h1 className="h1">Import subscribers · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Paste CSV to bulk-add subscribers to a list. Run a dry run first to preview counts.
      </p>
      {lists.data && lists.data.length === 0 && (
        <div className="card muted">No newsletters yet — create a list first.</div>
      )}
      <div className="card">
        <label>List</label>
        <select value={listId} onChange={(e) => setListId(e.target.value)} style={{ width: "100%" }}>
          {(lists.data ?? []).map((l) => (
            <option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>
          ))}
        </select>
        <label style={{ marginTop: 12 }}>Initial status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value as "pending" | "confirmed")} style={{ width: "100%" }}>
          <option value="pending">pending</option>
          <option value="confirmed">confirmed</option>
        </select>
        <label style={{ marginTop: 12 }}>CSV</label>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={10}
          placeholder={"email,first_name\nreader@example.com,Alex"}
          style={{ width: "100%", fontFamily: "monospace" }} disabled={busy} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
          <button className="btn ghost" disabled={!valid || busy} onClick={() => void run(true)}>Dry run</button>
          <button className="btn" disabled={!valid || busy} onClick={() => void run(false)}>{busy ? "Working…" : "Import"}</button>
          {msg && <span className="err">{msg}</span>}
        </div>
      </div>
      {report && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>{report.dryRun ? "Dry run — no changes applied" : "Import complete"}</div>
          <div className="kpis">
            <Kpi n={report.imported} l="imported" />
            <Kpi n={report.skipped} l="skipped" />
            <Kpi n={report.suppressed} l="suppressed" />
          </div>
        </div>
      )}
    </div>
  );
}
