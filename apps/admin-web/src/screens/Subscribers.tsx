/**
 * Subscribers, the per-subscriber detail panel, and the SES suppression import.
 *
 * `Subscribers` is exported for `SuppressionImport.test.tsx` (#251) — whether
 * the import panel is rendered at all is an RBAC decision made in this
 * component.
 */
import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { can, type Grant } from "../rbac.js";
import { api, type SubscriberDetail, type SuppressionCheckResult, type SuppressionImportReport } from "../api.js";

export function Subscribers({ org, grant }: { org: string; grant: Grant | null }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [rev, setRev] = useState(0);
  /** Cursor stack — one entry per page visited, so Back is exact rather than re-derived. */
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const cursor = pages[pages.length - 1];
  const subs = useAsync(() => api.subscribers(org, query || undefined, cursor), [org, query, cursor, rev]);
  const supps = useAsync(() => api.suppressions(org), [org, rev]);
  const [email, setEmail] = useState("");
  /** Empty stays manual/org-scoped exactly as before #247; bounce/complaint lands global (§4.13). */
  const [reason, setReason] = useState<"" | "bounce" | "complaint">("");
  const [msg, setMsg] = useState("");
  /** The subscriber whose detail panel is open (#205). */
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<SuppressionImportReport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const reload = () => setRev((n) => n + 1);

  const suppress = async () => {
    setMsg("");
    try { await api.suppress(org, email, reason || undefined); setMsg(`Suppressed ${email}`); reload(); }
    catch (e) { setMsg(String(e)); }
  };
  const unsubscribeAll = async (sub: string, subEmail: string) => {
    setMsg("");
    try { await api.adminUnsubscribe(org, sub, subEmail); setMsg(`Unsubscribed ${subEmail} from all lists`); reload(); }
    catch (e) { setMsg(String(e)); }
  };
  const lift = async (liftEmail: string) => {
    setMsg("");
    try { await api.unsuppress(org, liftEmail); setMsg(`Lifted suppression for ${liftEmail}`); reload(); }
    catch (e) { setMsg(String(e)); }
  };
  const runSuppressionImport = async (dryRun: boolean) => {
    setImportBusy(true); setMsg(""); setImportReport(null);
    try {
      setImportReport(await api.importSuppression(org, dryRun));
      if (!dryRun) reload();
    } catch (e) { setMsg(String(e)); } finally { setImportBusy(false); }
  };

  return (
    <div>
      <div className="pagehead"><div><h1>Subscribers</h1><p>The addressium subscriber record is the primary identity. Search, inspect, unsubscribe or suppress.</p></div></div>
      {msg && <p className="muted">{msg}</p>}

      <div className="card">
        <div className="row">
          <input placeholder="Email starts with…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { setQuery(q.trim()); setPages([undefined]); } }} style={{ flex: 1 }} />
          <button className="btn" onClick={() => { setQuery(q.trim()); setPages([undefined]); }}>Search</button>
          {query && <button className="btn ghost" onClick={() => { setQ(""); setQuery(""); setPages([undefined]); }}>Clear</button>}
        </div>
        {/* Said out loud rather than left to be discovered. A substring match
            cannot use any index, and answering one meant loading the whole org
            into memory (#182) — so the search is a prefix, and the box says so. */}
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
          Matches the START of an address. Results are paged.
        </p>
        {subs.loading && <p className="muted">Loading…</p>}
        {subs.error && <p className="err">{subs.error}</p>}
        {subs.data && subs.data.rows.length === 0 && <p className="muted">No subscribers match.</p>}
        {subs.data && subs.data.rows.length > 0 && (
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Email</th><th>Status</th><th>Entitlement</th><th>Last engaged</th><th></th></tr></thead>
            <tbody>
              {subs.data.rows.map((s) => (
                <tr key={s.sub}>
                  <td className="t-strong">{s.email}</td>
                  <td>{s.status}</td>
                  <td>{s.entitlement}</td>
                  <td className="muted">{s.lastEngagedAt ? new Date(s.lastEngagedAt).toLocaleString() : "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn ghost" onClick={() => setOpenSub(openSub === s.sub ? null : s.sub)}>
                      {openSub === s.sub ? "Close" : "Open"}
                    </button>{" "}
                    <button className="btn ghost" onClick={() => void unsubscribeAll(s.sub, s.email)}>Unsubscribe all</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {subs.data && (pages.length > 1 || subs.data.cursor) && (
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button className="btn ghost" disabled={pages.length === 1}
              onClick={() => setPages(pages.slice(0, -1))}>Previous</button>
            <button className="btn ghost" disabled={!subs.data.cursor}
              onClick={() => setPages([...pages, subs.data!.cursor])}>Next</button>
            <span className="muted">Page {pages.length}</span>
          </div>
        )}
      </div>

      {openSub && <SubscriberPanel org={org} sub={openSub} onChanged={reload} />}

      <div className="card">
        <label>Manually suppress an address (does not delete)</label>
        <div className="row">
          <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select value={reason} onChange={(e) => setReason(e.target.value as "" | "bounce" | "complaint")}>
            <option value="">Manual (this org only)</option>
            <option value="bounce">Bounce (account-wide, mirrored to SES)</option>
            <option value="complaint">Complaint (account-wide, mirrored to SES)</option>
          </select>
          <button className="btn" onClick={() => void suppress()} disabled={!email}>Suppress</button>
        </div>
      </div>

      {/* The route was built, routed and IAM-granted with nothing calling it
          (#251). Gated on `suppression:manage` to match the server: these
          entries are global, written in bulk, and have no bulk way back, so the
          route is developer_admin-only and a button that 403s for everyone else
          would be worse than no button. */}
      {can(grant, "suppression:manage", org) && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>Import the SES account suppression list</div>
          <p className="muted" style={{ marginTop: 0 }}>
            Run this <strong>before</strong> importing subscribers. A subscriber base can be
            re-exported from the old provider at any time; &ldquo;this address hard-bounced two
            years ago&rdquo; exists only on the SES account list. Skip it and the first campaign
            after a migration mails every one of those addresses — straight into the bounce rate
            the deliverability halt exists to catch.
          </p>
          <div className="row">
            <button className="btn ghost" disabled={importBusy} onClick={() => void runSuppressionImport(true)}>
              {importBusy ? "Reading…" : "Dry run"}
            </button>
            <button className="btn" disabled={importBusy} onClick={() => void runSuppressionImport(false)}>
              Import
            </button>
          </div>
          {importReport && (
            <div style={{ marginTop: 8 }}>
              <p className="muted" style={{ margin: 0 }}>
                {importReport.dryRun ? "Dry run — nothing was written. " : ""}
                Read {importReport.read}, {importReport.dryRun ? "would write" : "wrote"}{" "}
                {importReport.written}
                {importReport.malformed > 0 ? `, ${importReport.malformed} with no usable address` : ""}.
              </p>
              {/* Listed, not counted. The alternative reading of "4 skipped" is
                  "4 addresses we will now mail", and that is the one that
                  matters — an unmapped reason is never written. */}
              {importReport.unmapped.length > 0 && (
                <>
                  <p className="err" style={{ marginBottom: 4 }}>
                    {importReport.unmapped.length} entr
                    {importReport.unmapped.length === 1 ? "y" : "ies"} carry a reason we do not map
                    and were NOT suppressed — these addresses stay mailable.
                  </p>
                  <table>
                    <thead><tr><th>Email</th><th>Reason</th></tr></thead>
                    <tbody>
                      {importReport.unmapped.map((u) => (
                        <tr key={u.email}>
                          <td className="t-strong">{u.email}</td>
                          <td className="muted">{u.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>Suppression list</div>
        {supps.loading && <p className="muted">Loading…</p>}
        {supps.error && <p className="err">{supps.error}</p>}
        {supps.data && supps.data.length === 0 && <p className="muted">No suppressed addresses.</p>}
        {supps.data && supps.data.length > 0 && (
          <table>
            <thead><tr><th>Email</th><th>Source</th><th>Scope</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {supps.data.map((s) => (
                <tr key={`${s.email}:${s.scope}`}>
                  <td className="t-strong">{s.email}</td>
                  <td>{s.source}</td>
                  <td>{s.scope}</td>
                  <td className="muted">{new Date(s.addedAt).toLocaleString()}</td>
                  <td>
                    {s.scope === "org"
                      ? <button className="btn ghost" onClick={() => void lift(s.email)}>Lift</button>
                      : <span className="muted">global</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * Subscriber detail: attributes, per-list opt-ins, segments (#205).
 *
 * The list view carries five fields. This is everything else — most importantly
 * the ATTRIBUTES, which are the merge-tag values every personalised send renders
 * from, and the PER-LIST status, which previously could only be changed
 * all-lists-at-once by "Unsubscribe all".
 */
function SubscriberPanel({ org, sub, onChanged }: { org: string; sub: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<SubscriberDetail | null>(null);
  const [rows, setRows] = useState<Array<{ k: string; v: string }>>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  /** Local + live (SES) suppression status for this one address (#247). */
  const [check, setCheck] = useState<SuppressionCheckResult | null>(null);
  const [checkMsg, setCheckMsg] = useState("");
  const [reason, setReason] = useState<"" | "bounce" | "complaint">("");

  const load = (d: SubscriberDetail) => {
    setDetail(d);
    setRows(Object.entries(d.attributes).map(([k, v]) => ({ k, v })));
  };

  useEffect(() => {
    let live = true;
    setDetail(null); setMsg("");
    api.subscriber(org, sub).then((d) => live && load(d)).catch((e) => live && setMsg(String(e)));
    return () => { live = false; };
  }, [org, sub]);

  // Runs against `detail.email` (not `sub`) so a re-fetched detail — e.g. after
  // suppressing — re-checks under the same effect rather than needing a second
  // trigger wired in by hand.
  useEffect(() => {
    let live = true;
    setCheck(null); setCheckMsg("");
    if (!detail) return;
    api.suppressionCheck(org, detail.email).then((c) => live && setCheck(c)).catch((e) => live && setCheckMsg(String(e)));
    return () => { live = false; };
  }, [org, detail?.email]);

  const suppressThis = async () => {
    if (!detail) return;
    setBusy(true); setCheckMsg("");
    try {
      await api.suppress(org, detail.email, reason || undefined);
      load(await api.subscriber(org, sub));
      onChanged();
    } catch (e) { setCheckMsg(String(e)); }
    finally { setBusy(false); }
  };

  const saveAttributes = async () => {
    setBusy(true); setMsg("");
    // Blank keys are dropped rather than rejected: an operator adds a row, then
    // decides against it, and a validation error for a row they never filled in
    // is noise. A duplicate key would silently win — flag it instead.
    const kept = rows.filter((r) => r.k.trim());
    const keys = kept.map((r) => r.k.trim());
    if (new Set(keys).size !== keys.length) {
      setMsg("Two attributes share a name — one would silently overwrite the other.");
      setBusy(false);
      return;
    }
    try {
      load(await api.setSubscriberAttributes(org, sub, Object.fromEntries(kept.map((r) => [r.k.trim(), r.v]))));
      setMsg("Attributes saved.");
      onChanged();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const setStatus = async (listId: string, status: "pending" | "confirmed" | "unsubscribed") => {
    // Manual confirmation bypasses double opt-in, so it is confirmed out loud
    // here AND demanded again by the server — a client-only check is not a
    // safeguard, it is a speed bump.
    if (status === "confirmed") {
      const ok = window.confirm(
        `Manually confirming ${detail?.email} on "${listId}" bypasses double opt-in.\n\n` +
          "The subscription will be recorded with basis \"manual_admin\" naming you, not as a real opt-in, " +
          "and the action is written to the audit log.\n\nContinue?",
      );
      if (!ok) return;
    }
    setBusy(true); setMsg("");
    try {
      load(await api.setSubscriptionStatus(org, sub, listId, status, status === "confirmed"));
      setMsg(`"${listId}" set to ${status}.`);
      onChanged();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  if (!detail) {
    return <div className="card muted">{msg ? <span className="err">{msg}</span> : "Loading subscriber…"}</div>;
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{detail.email}</strong>
        <span className="muted">
          {detail.entitlement}
          {detail.lastEngagedAt ? ` · last engaged ${new Date(detail.lastEngagedAt).toLocaleDateString()}` : ""}
        </span>
      </div>
      {detail.suppressed && (
        // The single most useful line on this panel: every opt-in below is moot
        // while this is true, and an operator who cannot see it reads the next
        // send as broken.
        <p className="err" style={{ margin: "6px 0 0" }}>
          Suppressed — no send will reach this address, whatever the opt-ins below say.
          Lift it from the suppression list to change that.
        </p>
      )}
      {msg && <p className={msg.includes("saved") || msg.includes("set to") ? "muted" : "err"} style={{ margin: "6px 0 0" }}>{msg}</p>}

      <div style={{ marginTop: 16 }}>
        <strong>Suppression</strong>{" "}
        <span className="muted">local record, plus a live check against the SES account list (#247)</span>
        {checkMsg && <p className="err" style={{ margin: "6px 0 0" }}>{checkMsg}</p>}
        {!check && !checkMsg && <p className="muted" style={{ margin: "6px 0 0" }}>Checking…</p>}
        {check && (
          <div style={{ margin: "6px 0 0" }}>
            <p style={{ margin: 0 }}>
              Local: {check.local.length === 0
                ? <span className="muted">not suppressed here</span>
                : check.local.map((e) => `${e.source} (${e.scope})`).join(", ")}
            </p>
            <p style={{ margin: 0 }}>
              SES account list:{" "}
              {check.liveError
                ? <span className="err">could not check ({check.liveError})</span>
                : check.live === undefined
                  ? <span className="muted">not checked</span>
                  : check.live === null
                    ? <span className="muted">clear</span>
                    : <span className="err">suppressed — {check.live.reason}{check.live.at ? ` on ${new Date(check.live.at).toLocaleDateString()}` : ""}</span>}
            </p>
          </div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <select value={reason} onChange={(e) => setReason(e.target.value as "" | "bounce" | "complaint")} disabled={busy}>
            <option value="">Manual (this org only)</option>
            <option value="bounce">Bounce (account-wide, mirrored to SES)</option>
            <option value="complaint">Complaint (account-wide, mirrored to SES)</option>
          </select>
          <button className="btn ghost" disabled={busy} onClick={() => void suppressThis()}>Suppress this address</button>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <strong>Attributes</strong>{" "}
        <span className="muted">merge-tag values, e.g. {"{{first_name}}"}</span>
        <table style={{ marginTop: 6 }}>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={{ width: "35%" }}>
                  <input value={r.k} placeholder="first_name" disabled={busy} style={{ width: "100%" }}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                </td>
                <td>
                  <input value={r.v} placeholder="Ada" disabled={busy} style={{ width: "100%" }}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                </td>
                <td style={{ width: 1 }}>
                  <button className="btn ghost" disabled={busy}
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn ghost" disabled={busy} onClick={() => setRows([...rows, { k: "", v: "" }])}>
            Add attribute
          </button>
          <button className="btn" disabled={busy} onClick={() => void saveAttributes()}>
            {busy ? "Saving…" : "Save attributes"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <strong>Lists</strong>
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>Newsletter</th><th>Status</th><th>Consent</th><th></th></tr></thead>
          <tbody>
            {detail.lists.map((l) => (
              <tr key={l.listId}>
                <td>{l.name} <span className="muted">({l.listId})</span></td>
                <td className={l.status === "confirmed" ? "t-strong" : "muted"}>{l.status ?? "not subscribed"}</td>
                <td className="muted">
                  {/* Absent provenance is shown as unknown, never as consent. */}
                  {l.consent?.basis === "manual_admin"
                    ? `by ${l.consent.actor ?? "an admin"}`
                    : (l.consent?.basis ?? (l.status ? "unknown" : "—"))}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {l.status !== "confirmed" && (
                    <button className="btn ghost" disabled={busy} onClick={() => void setStatus(l.listId, "confirmed")}>
                      Confirm
                    </button>
                  )}{" "}
                  {l.status !== "unsubscribed" && l.status !== undefined && (
                    <button className="btn ghost" disabled={busy} onClick={() => void setStatus(l.listId, "unsubscribed")}>
                      Unsubscribe
                    </button>
                  )}{" "}
                  {l.status === undefined && (
                    <button className="btn ghost" disabled={busy} onClick={() => void setStatus(l.listId, "pending")}>
                      Invite (pending)
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 16 }}>
        <strong>Segments</strong>{" "}
        <span className="muted">
          {/* Explicit cohorts only — see subscriberDetail: evaluating every rule
              in the org per detail view would be slow and would show an answer
              that changes without anyone editing anything. */}
          explicit cohorts (#203); rule-based segments are evaluated at send time
        </span>
        {detail.segments.length === 0 ? (
          <p className="muted" style={{ margin: "6px 0 0" }}>Not in any explicit cohort.</p>
        ) : (
          <p style={{ margin: "6px 0 0" }}>
            {detail.segments.map((s) => `${s.name} (${s.segmentId})`).join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}
