import { useMemo, useState } from "react";
import { api, type SuppressionEntry, type SuppressionCheckResult } from "../api.js";
import { useAsync } from "../useAsync.js";

export function Suppression({ org }: { org: string }) {
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [checkEmail, setCheckEmail] = useState("");
  const [check, setCheck] = useState<SuppressionCheckResult | null>(null);
  const [message, setMessage] = useState("");
  const [busyEmail, setBusyEmail] = useState("");
  const [importing, setImporting] = useState(false);
  const { data, error, loading } = useAsync(() => api.suppressions(org), [org, revision]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const entries: SuppressionEntry[] = data ?? [];
    return entries
      .filter((entry) => !needle || entry.email.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle))
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }, [data, query]);

  const checkAddress = async () => {
    const email = checkEmail.trim();
    if (!email) return;
    setMessage("");
    try { setCheck(await api.suppressionCheck(org, email)); }
    catch (e) { setMessage(String(e)); setCheck(null); }
  };

  const lift = async (email: string) => {
    setBusyEmail(email); setMessage("");
    try {
      await api.unsuppress(org, email);
      setMessage(`Suppression lifted for ${email}.`);
      setRevision((n) => n + 1);
      if (check?.email === email) setCheck(null);
    } catch (e) { setMessage(String(e)); }
    finally { setBusyEmail(""); }
  };

  const importSes = async (dryRun: boolean) => {
    setImporting(true); setMessage("");
    try {
      const report = await api.importSuppression(org, dryRun);
      setMessage(`${dryRun ? "Dry run" : "Import"} complete: ${report.read} read, ${report.written} ${dryRun ? "would be written" : "written"}.`);
      if (!dryRun) setRevision((n) => n + 1);
    } catch (e) { setMessage(String(e)); }
    finally { setImporting(false); }
  };

  return (
    <div>
      <div className="pagehead">
        <div>
          <h1>Suppression</h1>
          <p>Addresses that must not receive mail, with local and SES status kept visible.</p>
        </div>
        <div className="row">
          <button className="btn ghost" disabled={importing} onClick={() => void importSes(true)}>Preview SES import</button>
          <button className="btn" disabled={importing} onClick={() => void importSes(false)}>Import SES list</button>
        </div>
      </div>

      <div className="card">
        <div className="cardhead" style={{ margin: "-18px -18px 16px" }}><h2>Check an address</h2></div>
        <div className="row">
          <input aria-label="Suppression email" value={checkEmail} onChange={(e) => setCheckEmail(e.target.value)} placeholder="email@example.com" onKeyDown={(e) => { if (e.key === "Enter") void checkAddress(); }} style={{ flex: 1, minWidth: 240 }} />
          <button className="btn" disabled={!checkEmail.trim()} onClick={() => void checkAddress()}>Check status</button>
        </div>
        {check && <CheckResult result={check} onLift={lift} busyEmail={busyEmail} />}
      </div>

      {message && <p className="muted">{message}</p>}
      {error && <p className="err">{error}</p>}
      <div className="card">
        <div className="cardhead" style={{ margin: "-18px -18px 16px" }}>
          <h2>Suppressed addresses</h2>
          <input aria-label="Filter suppressions" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter email or source" />
        </div>
        {loading && <p className="muted">Loading suppression records…</p>}
        {!loading && rows.length === 0 && <p className="muted">{query ? "No suppression records match this filter." : "No local suppression records yet."}</p>}
        {rows.length > 0 && <table><thead><tr><th>Email</th><th>Source</th><th>Scope</th><th>Added</th><th /></tr></thead><tbody>
          {rows.map((entry) => <tr key={`${entry.email}:${entry.addedAt}`}><td>{entry.email}</td><td>{entry.source}</td><td>{entry.scope}</td><td>{new Date(entry.addedAt).toLocaleString()}</td><td><button className="btn ghost" disabled={busyEmail === entry.email} onClick={() => void lift(entry.email)}>Lift</button></td></tr>)}
        </tbody></table>}
      </div>
    </div>
  );
}

function CheckResult({ result, onLift, busyEmail }: { result: SuppressionCheckResult; onLift: (email: string) => Promise<void>; busyEmail: string }) {
  const hasLocal = result.local.length > 0;
  return <div className="card" style={{ margin: "16px 0 0", background: "var(--surface-2)" }}>
    <div className="row" style={{ justifyContent: "space-between" }}><strong>{result.email}</strong><span className={`pill ${hasLocal ? "p-warn" : "p-good"}`}>{hasLocal ? "Suppressed" : "Not locally suppressed"}</span></div>
    {hasLocal && <p className="muted">{result.local.map((entry) => `${entry.source} · ${entry.scope}`).join("; ")}</p>}
    {result.live && <p className="muted">SES: {result.live.reason}{result.live.at ? ` · ${new Date(result.live.at).toLocaleString()}` : ""}</p>}
    {result.live === null && <p className="muted">SES: clear</p>}
    {result.liveError && <p className="muted">SES check unavailable: {result.liveError}</p>}
    {hasLocal && <button className="btn ghost" disabled={busyEmail === result.email} onClick={() => void onLift(result.email)}>Lift local suppression</button>}
  </div>;
}
