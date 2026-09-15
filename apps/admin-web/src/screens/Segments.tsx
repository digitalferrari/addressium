import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { isValidId } from "../ids.js";
import { api, EMPTY_EXPLICIT, isExplicitPredicate, type SegmentMember } from "../api.js";

export function Segments({ org }: { org: string }) {
  const [rev, setRev] = useState(0);
  const segments = useAsync(() => api.segments(org), [org, rev]);
  const [segmentId, setSegmentId] = useState("");
  const [name, setName] = useState("");
  const [predicate, setPredicate] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  /** Which kind the editor is building — a rule, or a hand-listed cohort (#203). */
  const [kind, setKind] = useState<"rule" | "explicit">("rule");

  const edit = (s: { segmentId: string; name: string; predicate: unknown }) => {
    setSegmentId(s.segmentId); setName(s.name);
    setKind(isExplicitPredicate(s.predicate) ? "explicit" : "rule");
    setPredicate(JSON.stringify(s.predicate, null, 2)); setMsg("");
  };
  const reset = () => { setSegmentId(""); setName(""); setPredicate(""); setMsg(""); setKind("rule"); };

  const save = async () => {
    setMsg(""); setBusy(true);
    let parsed: unknown;
    if (kind === "explicit") {
      // A new cohort starts EMPTY and gains members one address at a time. It
      // deliberately cannot be authored as raw JSON: members are subscriber ids,
      // and hand-typing an id nobody can read is how you mail the wrong person.
      const current = (segments.data ?? []).find((s) => s.segmentId === segmentId.trim())?.predicate;
      parsed = isExplicitPredicate(current) ? current : EMPTY_EXPLICIT;
    } else {
      try { parsed = JSON.parse(predicate); }
      catch { setMsg("Predicate is not valid JSON."); setBusy(false); return; }
    }
    try {
      const saved = await api.saveSegment(org, segmentId.trim(), name.trim(), parsed);
      setMsg(`Saved "${saved.segmentId}".`);
      setRev((n) => n + 1);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };
  const valid =
    isValidId(segmentId.trim()) && name.trim() && (kind === "explicit" || predicate.trim());

  return (
    <div>
      <h1 className="h1">Segments · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Reusable audience filters that target within a list. The v1 engine requires a base
        <code> list</code> condition.
      </p>
      {segments.loading && <div className="card muted">Loading…</div>}
      {segments.error && <p className="err">{segments.error}</p>}
      {segments.data && segments.data.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Segment</th><th>Kind</th><th></th></tr></thead>
            <tbody>
              {segments.data.map((s) => (
                <tr key={s.segmentId}>
                  <td className="t-strong">{s.name} <span className="muted">({s.segmentId})</span></td>
                  <td className="muted">{isExplicitPredicate(s.predicate) ? "Explicit cohort" : "Rule"}</td>
                  <td><button className="btn ghost" onClick={() => edit(s)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>{segmentId ? `Editing ${segmentId}` : "New segment"}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={segmentId} onChange={(e) => setSegmentId(e.target.value)} placeholder="segment id" style={{ flex: 1 }} disabled={busy} />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" style={{ flex: 2 }} disabled={busy} />
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 12 }}>
          <label><input type="radio" checked={kind === "rule"} onChange={() => setKind("rule")} disabled={busy} /> Rule</label>
          <label><input type="radio" checked={kind === "explicit"} onChange={() => setKind("explicit")} disabled={busy} /> Explicit cohort</label>
        </div>
        {kind === "rule" ? (
          <>
            <label style={{ marginTop: 12 }}>Predicate (JSON)</label>
            <textarea value={predicate} onChange={(e) => setPredicate(e.target.value)} rows={10}
              placeholder={'{"match":"all","conditions":[{"field":"list","op":"in","value":"ledger"}]}'}
              style={{ width: "100%", fontFamily: "monospace" }} disabled={busy} />
            <p className="muted" style={{ margin: "6px 0 0" }}>
              A base <code>list</code> condition is required by the v1 engine.
            </p>
          </>
        ) : (
          <p className="muted" style={{ margin: "8px 0 0" }}>
            A hand-listed cohort — useful for a test send before touching a real list.
            Save it first, then add addresses below.
          </p>
        )}
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
          <button className="btn" disabled={!valid || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save segment"}</button>
          {segmentId && <button className="btn ghost" onClick={reset} disabled={busy}>New</button>}
          {msg && <span className={msg.startsWith("Saved") ? "muted" : "err"}>{msg}</span>}
        </div>
      </div>
      {/* Membership editing needs a saved segment to attach to, so it appears
          only once the segment exists and is of the explicit kind. */}
      {kind === "explicit" && isValidId(segmentId.trim()) &&
        (segments.data ?? []).some((s) => s.segmentId === segmentId.trim()) && (
          <SegmentMembers org={org} segmentId={segmentId.trim()} />
        )}
    </div>
  );
}

/**
 * The membership editor for an explicit cohort (#203).
 *
 * Addresses in, subscriber ids stored. An address that is not already a
 * subscriber is REJECTED by the server rather than created — every other path
 * that creates a subscriber records consent provenance, and one conjured from
 * this box would have none. The error says so; this screen just shows it.
 */
function SegmentMembers({ org, segmentId }: { org: string; segmentId: string }) {
  const [members, setMembers] = useState<SegmentMember[] | null>(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setMembers(null); setMsg("");
    api.segmentMembers(org, segmentId)
      .then((m) => live && setMembers(m))
      .catch((e) => live && setMsg(String(e)));
    return () => { live = false; };
  }, [org, segmentId]);

  const change = async (action: "add" | "remove", value: string) => {
    setBusy(true); setMsg("");
    try {
      setMembers(await api.segmentMember(org, segmentId, action, value));
      if (action === "add") setEmail("");
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const suppressed = (members ?? []).filter((m) => m.suppressed).length;

  return (
    <div className="card">
      <strong>Members of {segmentId}</strong>{" "}
      <span className="muted">
        {members ? `${members.length} address${members.length === 1 ? "" : "es"}` : "loading…"}
      </span>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="someone@example.com"
          style={{ flex: 1 }}
          disabled={busy}
        />
        <button className="btn" disabled={busy || !email.trim()} onClick={() => void change("add", email.trim())}>
          Add address
        </button>
      </div>
      {msg && <p className="err" style={{ margin: "8px 0 0" }}>{msg}</p>}
      {suppressed > 0 && (
        // Said plainly, because the alternative is an operator concluding the
        // send is broken when it is in fact obeying a suppression.
        <p className="muted" style={{ margin: "8px 0 0" }}>
          {suppressed} of these {suppressed === 1 ? "is" : "are"} suppressed and will not be mailed,
          even from this segment.
        </p>
      )}
      {members && members.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>Address</th><th>Status</th><th>Entitlement</th><th></th></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.subscriberId}>
                <td>{m.email}</td>
                <td className={m.suppressed ? "err" : "muted"}>{m.suppressed ? "suppressed" : m.status}</td>
                <td className="muted">{m.entitlement}</td>
                <td>
                  <button className="btn ghost" disabled={busy} onClick={() => void change("remove", m.email)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
