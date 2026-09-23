import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { api, type ColumnMapping, type ImportPreview, type ImportUploadTicket, type MappedImportReport, type MappingPlan, type NewListDefaults } from "../api.js";
import { SkeletonScreen, SkeletonTable } from "../Skeleton.js";

const INLINE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * On-the-fly CSV field mapper (#216) — the Constant Contact / Mailchimp flow.
 *
 * Uploaded files never have the columns we want. Every source column resolves to
 * exactly one of: the email address, an attribute, an audience, one of the three
 * Pinpoint row-level safety signals, or an explicit discard. Nothing is dropped
 * silently.
 */
export function ImportMapper({ org }: { org: string }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const [csv, setCsv] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<ImportUploadTicket | null>(null);
  const [fileName, setFileName] = useState("");
  const [basis, setBasis] = useState<"explicit" | "implicit">("implicit");
  const [status, setStatus] = useState<"pending" | "confirmed">("pending");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [plan, setPlan] = useState<MappingPlan | null>(null);
  const [report, setReport] = useState<MappedImportReport | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState("");
  const [mappingName, setMappingName] = useState("");
  const [defaults, setDefaults] = useState<NewListDefaults>({ fromAddress: "", complianceFooter: "", physicalAddress: "" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const readFile = (f: File) => {
    setFile(f);
    setUpload(null);
    setPreview(null);
    setPlan(null);
    setFileName(f.name);
    if (f.size > INLINE_IMPORT_MAX_BYTES) {
      // Do not read a migration-sized file into a React string. The async path
      // uploads it directly to S3, and the server previews it from there.
      setCsv("");
      return;
    }
    const r = new FileReader();
    r.onload = () => setCsv(String(r.result ?? ""));
    r.readAsText(f);
  };

  const doPreview = async () => {
    setBusy(true); setMsg(""); setReport(null);
    try {
      let p: ImportPreview;
      if (file && file.size > INLINE_IMPORT_MAX_BYTES) {
        const ticket = upload ?? await api.uploadImportFile(org, file);
        setUpload(ticket);
        p = await api.importUploadPreview(org, ticket.batchId, basis);
      } else {
        p = await api.importPreview(org, csv, basis);
      }
      setPreview(p);
      setPlan(p.suggested);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const setColumn = (header: string, m: ColumnMapping) =>
    setPlan((p) => (p ? { columns: { ...p.columns, [header]: m } } : p));

  /** Any column the plan asks us to create a list for needs compliance fields. */
  const createsList = !!plan && Object.values(plan.columns).some(
    (m) => m.kind === "audience" && "createNamed" in m.list,
  );

  const run = async (dryRun: boolean) => {
    if (!plan) return;
    setBusy(true); setMsg("");
    try {
      if (upload) {
        if (dryRun) {
          setMsg("Dry run is available before upload for small files; this uploaded file is ready to queue.");
          return;
        }
        const r = await api.importAsync(org, {
          batchId: upload.batchId,
          plan,
          sourceFile: fileName || undefined,
          ...(status ? { status } : {}),
          ...(createsList ? { newListDefaults: defaults } : {}),
        });
        setMsg(`Import queued (${r.batchId}).`);
        setHistoryRefresh(r.batchId);
      } else {
        const r = await api.importMapped(org, {
          csv, plan, sourceFile: fileName || undefined, dryRun, status,
          ...(createsList ? { newListDefaults: defaults } : {}),
        });
        setReport(r);
        setHistoryRefresh(r.batchId ?? String(Date.now()));
        setMsg(dryRun ? "Dry run complete — nothing was written." : "Import complete.");
      }
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const OUTCOMES = ["email", "externalId", "attribute", "audience", "discard"] as const;
  const kindOf = (m: ColumnMapping): string =>
    m.kind === "optOut" || m.kind === "endpointStatus" || m.kind === "channel" ? m.kind : m.kind;

  return (
    <div>
      <h2>Import subscribers</h2>
      <p className="muted">
        Map each column to a field, create a new one, or discard it. Discarded columns are counted
        in the report — nothing is dropped silently.
      </p>

      <div className="card">
        <input type="file" accept=".csv,.jsonl,.gz,text/csv,application/gzip,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
        {file && file.size > INLINE_IMPORT_MAX_BYTES && (
          <div className="muted" style={{ marginTop: 8 }}>
            This is a large file ({Math.round(file.size / 1024 / 1024)} MB). It will upload directly to secure storage, preview there, and run as a background job.
          </div>
        )}
        <label>
          Consent basis for audience columns
          <select value={basis} onChange={(e) => setBasis(e.target.value as "explicit" | "implicit")}>
            <option value="implicit">Implicit — an existing relationship</option>
            <option value="explicit">Explicit — the file carries double opt-in evidence</option>
          </select>
        </label>
        <label>
          Initial subscription status
          <select value={status} onChange={(e) => setStatus(e.target.value as "pending" | "confirmed")}>
            <option value="pending">Pending confirmation</option>
            <option value="confirmed">Confirmed (explicit consent only)</option>
          </select>
        </label>
        <div className="muted">
          Implicit can only ever create <strong>pending</strong> subscriptions; the subscriber still
          has to confirm.
        </div>
        <button className="btn" disabled={(!csv && !file) || busy} onClick={doPreview}>Preview mapping</button>
      </div>

      {preview && plan && (
        <>
          <div className="muted" style={{ margin: "8px 0" }}>
            {preview.headers.length} columns, {preview.rowCount} rows.
          </div>

          {preview.saved.length > 0 && (
            <div className="card">
              <strong>Saved mappings for this file shape</strong>
              <div className="muted">
                Matched on the header set, ignoring order — a reshuffled re-export still matches.
              </div>
              {preview.saved.map((m) => (
                <button key={m.mappingId} className="btn ghost" style={{ marginRight: 8 }} onClick={() => setPlan(m.plan)}>
                  Use “{m.name}”
                </button>
              ))}
            </div>
          )}

          {createsList && (
            <div className="card">
              <strong>New lists need compliance fields</strong>
              <div className="muted">
                A list with no physical address or footer is a CAN-SPAM violation, so these are
                required rather than defaulted.
              </div>
              <label>From address<input value={defaults.fromAddress} onChange={(e) => setDefaults({ ...defaults, fromAddress: e.target.value })} /></label>
              <label>Compliance footer<input value={defaults.complianceFooter} onChange={(e) => setDefaults({ ...defaults, complianceFooter: e.target.value })} /></label>
              <label>Physical address<input value={defaults.physicalAddress} onChange={(e) => setDefaults({ ...defaults, physicalAddress: e.target.value })} /></label>
            </div>
          )}

          <table className="table">
            <thead>
              <tr><th>Column</th><th>Sample</th><th>Maps to</th><th>Target</th></tr>
            </thead>
            <tbody>
              {preview.headers.map((h) => {
                const m = plan.columns[h]!;
                const sample = preview.sample.map((r) => r[h]).filter((v) => v && v.trim() !== "")[0] ?? "";
                return (
                  <tr key={h}>
                    <td><code>{h}</code></td>
                    <td className="muted">{sample.slice(0, 28)}</td>
                    <td>
                      <select
                        value={OUTCOMES.includes(kindOf(m) as never) ? kindOf(m) : "discard"}
                        onChange={(e) => {
                          const k = e.target.value;
                          if (k === "email") setColumn(h, { kind: "email" });
                          else if (k === "externalId") setColumn(h, { kind: "externalId" });
                          else if (k === "attribute") setColumn(h, { kind: "attribute", key: h.split(".").pop() ?? h });
                          else if (k === "audience")
                            setColumn(h, { kind: "audience", list: { createNamed: h.split(".").pop() ?? h }, consentBasis: basis });
                          else setColumn(h, { kind: "discard" });
                        }}
                      >
                        <option value="email">Email address</option>
                        <option value="externalId">External customer ID</option>
                        <option value="attribute">Attribute</option>
                        <option value="audience">Audience</option>
                        <option value="discard">Discard</option>
                      </select>
                      {(m.kind === "optOut" || m.kind === "endpointStatus" || m.kind === "channel") && (
                        <div className="muted">detected: {m.kind} (safety signal)</div>
                      )}
                    </td>
                    <td>
                      {m.kind === "attribute" && (
                        <input value={m.key} onChange={(e) => setColumn(h, { kind: "attribute", key: e.target.value })} />
                      )}
                      {m.kind === "audience" && (
                        <select
                          value={"existingId" in m.list ? m.list.existingId : "__new__"}
                          onChange={(e) =>
                            setColumn(h, {
                              kind: "audience",
                              consentBasis: basis,
                              list: e.target.value === "__new__"
                                ? { createNamed: h.split(".").pop() ?? h }
                                : { existingId: e.target.value },
                            })
                          }
                        >
                          <option value="__new__">Create “{h.split(".").pop()}”</option>
                          {(lists.data ?? []).map((l) => (
                            <option key={l.listId} value={l.listId}>{l.name}</option>
                          ))}
                        </select>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="card">
            <label>
              Save this mapping as
              <input value={mappingName} onChange={(e) => setMappingName(e.target.value)} placeholder="Monthly Pinpoint export" />
            </label>
            <button
              className="btn ghost"
              disabled={busy || !mappingName.trim()}
              onClick={async () => {
                try {
                  await api.saveMapping(org, mappingName, preview.fingerprint, plan);
                  setMsg(`Saved “${mappingName}” — it will be offered next time this file shape appears.`);
                } catch (e) { setMsg((e as Error).message); }
              }}
            >
              Save mapping
            </button>
          </div>

          <button className="btn ghost" disabled={busy || !!upload} onClick={() => run(true)}>Dry run</button>
          <button className="btn" disabled={busy} onClick={() => run(false)} style={{ marginLeft: 8 }}>
            Import
          </button>
        </>
      )}

      {msg && <div style={{ marginTop: 12 }}>{msg}</div>}

      {report && (
        <div className="card" style={{ marginTop: 12 }}>
          <div>Created {report.created} · updated {report.updated} · duplicates {report.duplicates}</div>
          <div>Subscriptions {report.subscriptionsCreated} · declines recorded {report.declinesRecorded}</div>
          <div>
            Not mailable {report.nonMailable} <span className="muted">(opted out or inactive — kept as records)</span>
          </div>
          <div>Suppressed, skipped {report.suppressed} · discarded cells {report.discardedCells}</div>
          {report.listsCreated.length > 0 && <div>Lists created: {report.listsCreated.join(", ")}</div>}
          {report.errors.length > 0 && (
            <details>
              <summary>{report.errors.length} row error(s)</summary>
              <ul>{report.errors.slice(0, 50).map((e, i) => <li key={i}>{e}</li>)}</ul>
            </details>
          )}
          {report.batchId && <div className="muted">Batch <code>{report.batchId}</code></div>}
        </div>
      )}

      <ImportHistory org={org} refresh={historyRefresh} />
    </div>
  );
}

/**
 * Import history (#223).
 *
 * Every run was already stamped on the subscriptions it wrote, but there was no
 * way to ask what a given run had done — which is the only question anyone asks
 * about an import, and always after discovering the file was wrong. Rows load on
 * demand: a batch can hold hundreds of thousands, and nobody wants all of them
 * just to see that the run existed.
 */
function ImportHistory({ org, refresh }: { org: string; refresh: string }) {
  /**
   * `tick` re-runs the list. A queued job (#242) finishes minutes after the 202,
   * so a table loaded once shows `running` for ever and an operator cannot tell
   * a job still working from one that died — the exact question an import raises.
   */
  const [tick, setTick] = useState(0);
  const batches = useAsync(() => api.importBatches(org), [org, refresh, tick]);
  const [openId, setOpenId] = useState("");
  const anyRunning = (batches.data ?? []).some((b) => b.status === "running");

  // Polls only while something is actually running, and stops the moment
  // nothing is — an idle history screen makes no requests.
  useEffect(() => {
    if (!anyRunning) return;
    const t = setTimeout(() => setTick((n) => n + 1), 5000);
    return () => clearTimeout(t);
  }, [anyRunning, tick]);

  const detail = useAsync(
    () => (openId ? api.importBatch(org, openId) : Promise.resolve(null)),
    [org, openId],
  );

  // `!batches.data` matters: useAsync drops `data` on every deps change, so
  // without it each 5-second poll would blank the whole table and redraw it —
  // a flicker on exactly the screen an operator is watching a job from.
  if (batches.loading && !batches.data) return <SkeletonScreen label="Loading import history…" />;
  if (batches.error && !batches.data) return <div className="error">{batches.error}</div>;
  const rows = batches.data ?? [];
  if (rows.length === 0) {
    return <div className="muted" style={{ marginTop: 16 }}>No imports recorded yet.</div>;
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Import history</h3>
      <table className="table">
        <thead>
          <tr><th>Started</th><th>File</th><th>Status</th><th>Basis</th><th>Created</th><th>Updated</th><th>Memberships</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.batchId}>
              <td>{new Date(b.startedAt).toLocaleString()}</td>
              <td>{b.sourceFile ?? <span className="muted">—</span>}</td>
              <td>{b.status ?? "completed"}{b.error && <div className="err">{b.error}</div>}</td>
              {/* Blank means the file mixed bases, not that consent is unknown. */}
              <td>{b.consentBasis ?? <span className="muted">mixed</span>}</td>
              <td>{b.created}</td>
              <td>{b.updated}</td>
              <td>{b.rowCount}</td>
              <td>
                <button className="btn ghost" onClick={() => setOpenId(openId === b.batchId ? "" : b.batchId)}>
                  {openId === b.batchId ? "Hide rows" : "Show rows"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {openId && (
        <div className="card">
          {detail.loading && <SkeletonTable rows={4} label="Loading rows…" />}
          {detail.error && <div className="error">{detail.error}</div>}
          {detail.data && (
            <>
              <strong>{detail.data.rows.length} membership(s) written by this run</strong>
              <table className="table">
                <thead><tr><th>Subscriber</th><th>List</th></tr></thead>
                <tbody>
                  {detail.data.rows.slice(0, 200).map((r) => (
                    <tr key={`${r.subscriberId}#${r.listId}`}>
                      <td><code>{r.subscriberId}</code></td>
                      <td><code>{r.listId}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.data.rows.length > 200 && (
                <div className="muted">Showing the first 200 of {detail.data.rows.length}.</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
