/**
 * Data requests — the whole-org bulk export and the per-subject DSAR.
 *
 * Both are rendered by `App.tsx` as siblings under the `privacy` view.
 */
import { useState } from "react";
import { api } from "../api.js";

/**
 * Bulk export (#224) — the "you can leave" half of the promise.
 *
 * Distinct from the per-subject DSAR below: this is the whole org, in the shape
 * the import mapper can read back, so leaving is a round trip rather than a
 * download nobody can use.
 */
export function BulkExport({ org }: { org: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [includeUnsubscribed, setIncludeUnsubscribed] = useState(true);

  const download = async (format: "csv" | "jsonl") => {
    setBusy(true);
    setMsg("");
    try {
      const link = await api.exportData(org, format, includeUnsubscribed);
      // The file is already in S3; this URL is pre-authorized, so a plain
      // navigation works and the bytes never pass through the browser's memory
      // the way a blob would.
      const a = document.createElement("a");
      a.href = link.url;
      a.download = `addressium-${org}-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      const kb = Math.max(1, Math.round(link.bytes / 1024));
      setMsg(
        `Exported ${kb.toLocaleString()} KB. The download link expires at ` +
          `${new Date(link.expiresAt).toLocaleTimeString()} — it grants the whole file to anyone ` +
          `holding it, so don't paste it anywhere.`,
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Export everything</h3>
      <p className="muted">
        Subscribers, subscriptions, suppression state and consent provenance. The CSV imports back
        through the field mapper, so this is a way out, not just a file.
      </p>
      <label>
        <input
          type="checkbox"
          checked={includeUnsubscribed}
          onChange={(e) => setIncludeUnsubscribed(e.target.checked)}
        />{" "}
        Include unsubscribed rows
        <div className="muted">
          Leave on when migrating: an opt-out you fail to carry across is one you will mail again.
        </div>
      </label>
      <div style={{ marginTop: 8 }}>
        <button className="btn" disabled={busy} onClick={() => download("csv")}>Export CSV</button>
        <button className="btn ghost" disabled={busy} style={{ marginLeft: 8 }} onClick={() => download("jsonl")}>
          Export JSONL
        </button>
        {msg && <span style={{ marginLeft: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}

export function Privacy({ org }: { org: string }) {
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ found?: boolean; data?: unknown; erased?: boolean } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (action: "export" | "erase") => {
    setMsg(""); setResult(null); setBusy(true);
    try { setResult(await api.privacy(org, action, email.trim())); }
    catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h1 className="h1">Data requests · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Handle DSAR export and erasure requests. Erase requires the <code>subscribers:delete</code> role and will 403 otherwise.
      </p>
      <div className="card">
        <label>Subject email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" style={{ width: "100%" }} disabled={busy} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
          <button className="btn" disabled={!email.trim() || busy} onClick={() => void run("export")}>Export</button>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I understand this is irreversible
        </label>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
          <button className="btn" disabled={!email.trim() || !confirm || busy} onClick={() => void run("erase")}>Erase</button>
          {msg && <span className="err">{msg}</span>}
        </div>
      </div>
      {result && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>Result</div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
