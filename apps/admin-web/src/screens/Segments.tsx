import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { isValidId } from "../ids.js";
import { api, EMPTY_EXPLICIT, isExplicitPredicate, type SegmentMember } from "../api.js";
import {
  ENTITLEMENT_VALUES,
  MAX_CONDITIONS,
  fromPredicate,
  newRow,
  predicateProblem,
  rowProblem,
  toPredicate,
  type Row,
  type RowKind,
} from "./segment-predicate.js";

/** Labels for the condition kinds, in the order the picker offers them. */
const KIND_LABELS: { kind: RowKind; label: string }[] = [
  { kind: "list", label: "Subscribed to list" },
  { kind: "entitlement", label: "Entitlement" },
  { kind: "attribute", label: "Attribute" },
];

export function Segments({ org }: { org: string }) {
  const [rev, setRev] = useState(0);
  const segments = useAsync(() => api.segments(org), [org, rev]);
  const lists = useAsync(() => api.lists(org), [org]);
  const [segmentId, setSegmentId] = useState("");
  const [name, setName] = useState("");
  const [predicate, setPredicate] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  /** Which kind the editor is building — a rule, or a hand-listed cohort (#203). */
  const [kind, setKind] = useState<"rule" | "explicit">("rule");
  /** Builder state: the structured path. `raw` is the escape hatch (#282). */
  const [rows, setRows] = useState<Row[]>([newRow("list")]);
  const [raw, setRaw] = useState(false);

  const edit = (s: { segmentId: string; name: string; predicate: unknown }) => {
    setSegmentId(s.segmentId); setName(s.name);
    setKind(isExplicitPredicate(s.predicate) ? "explicit" : "rule");
    setPredicate(JSON.stringify(s.predicate, null, 2)); setMsg("");
    // A predicate the builder cannot represent faithfully opens RAW rather than
    // being flattened into rows that would drop the parts it has no control for
    // — saving that back would silently rewrite the operator's audience.
    const parsed = isExplicitPredicate(s.predicate) ? null : fromPredicate(s.predicate);
    if (parsed) { setRows(parsed.rows); setRaw(false); }
    else { setRaw(!isExplicitPredicate(s.predicate)); }
  };
  const reset = () => {
    setSegmentId(""); setName(""); setPredicate(""); setMsg(""); setKind("rule");
    setRows([newRow("list")]); setRaw(false);
  };

  const problem = predicateProblem(rows);

  const save = async () => {
    setMsg(""); setBusy(true);
    let parsed: unknown;
    if (kind === "explicit") {
      // A new cohort starts EMPTY and gains members one address at a time. It
      // deliberately cannot be authored as raw JSON: members are subscriber ids,
      // and hand-typing an id nobody can read is how you mail the wrong person.
      const current = (segments.data ?? []).find((s) => s.segmentId === segmentId.trim())?.predicate;
      parsed = isExplicitPredicate(current) ? current : EMPTY_EXPLICIT;
    } else if (raw) {
      try { parsed = JSON.parse(predicate); }
      catch { setMsg("Predicate is not valid JSON."); setBusy(false); return; }
    } else {
      parsed = toPredicate(rows);
    }
    try {
      const saved = await api.saveSegment(org, segmentId.trim(), name.trim(), parsed);
      setMsg(`Saved "${saved.segmentId}".`);
      setRev((n) => n + 1);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };
  const valid =
    isValidId(segmentId.trim()) &&
    !!name.trim() &&
    (kind === "explicit" || (raw ? !!predicate.trim() : !problem));

  return (
    <div>
      <div className="pagehead"><div><h1>Segments</h1><p>Saved predicates over lists, entitlements and subscriber attributes.</p></div></div>
      <p className="muted">
        Reusable audience filters that target within a list. Build the rule from conditions —
        the shipped v1 engine ranges over one list, so a “Subscribed to list” condition is the
        base of every <code>ALL</code> rule.
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
          raw ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
                <label style={{ margin: 0 }} htmlFor="segment-predicate-json">Predicate (JSON)</label>
                <button className="btn ghost" disabled={busy} onClick={() => setRaw(false)}>
                  Back to builder
                </button>
              </div>
              <textarea id="segment-predicate-json"
                value={predicate} onChange={(e) => setPredicate(e.target.value)} rows={10}
                placeholder={'{"match":"all","conditions":[{"field":"list","op":"in","value":"ledger"}]}'}
                style={{ width: "100%", fontFamily: "monospace" }} disabled={busy} />
              <p className="muted" style={{ margin: "6px 0 0" }}>
                The advanced editor accepts anything the save schema does. The server refuses a
                predicate this deployment’s engine cannot resolve, and says which.
              </p>
            </>
          ) : (
            <RuleBuilder
              rows={rows} setRows={setRows}
              lists={lists.data ?? null} listsError={lists.error} busy={busy}
              problem={problem} onRaw={() => {
                // Seed the raw editor from what the builder currently holds, so
                // switching is a continuation rather than a blank page.
                setPredicate(JSON.stringify(toPredicate(rows), null, 2));
                setRaw(true);
              }}
            />
          )
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
 * The structured predicate builder (#282 / ISSUES #256).
 *
 * It offers exactly the conditions both engines can resolve, and every rule it
 * builds matches ALL of them. What it leaves out, and why, is documented against
 * the engine code in `segment-predicate.ts` — engagement recency, subscription
 * status and `match: "any"` are each unresolvable, dead, or actively dangerous
 * on the shipped engine. All three remain reachable from the advanced editor,
 * where the API answers for itself.
 */
function RuleBuilder({
  rows, setRows, lists, listsError, busy, problem, onRaw,
}: {
  rows: Row[];
  setRows: (r: Row[]) => void;
  lists: { listId: string; name: string }[] | null;
  listsError?: string;
  busy: boolean;
  problem: string | null;
  onRaw: () => void;
}) {
  const update = (id: string, patch: Partial<Row>) =>
    setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted">
        Subscribers matching <strong>all</strong> of these conditions:
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
        {rows.map((row) => {
          const rp = rowProblem(row);
          return (
            <div key={row.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <select
                value={row.kind}
                aria-label="Condition type"
                disabled={busy}
                style={{ width: "auto" }}
                onChange={(e) => {
                  // Changing the kind clears the value: a list id left behind in
                  // an entitlement row would submit a condition nobody chose.
                  const kind = e.target.value as RowKind;
                  update(row.id, { kind, value: "", field: "", op: "eq" });
                }}
              >
                {KIND_LABELS.map((k) => (
                  <option key={k.kind} value={k.kind}>{k.label}</option>
                ))}
              </select>

              {row.kind === "attribute" && (
                <>
                  <input
                    value={row.field}
                    aria-label="Attribute name"
                    placeholder="attribute name"
                    disabled={busy}
                    style={{ width: 160 }}
                    onChange={(e) => update(row.id, { field: e.target.value })}
                  />
                  <select
                    value={row.op}
                    aria-label="Operator"
                    disabled={busy}
                    style={{ width: "auto" }}
                    onChange={(e) =>
                      update(row.id, { op: e.target.value as Row["op"] })
                    }
                  >
                    <option value="eq">is</option>
                    <option value="neq">is not</option>
                    <option value="exists">exists</option>
                  </select>
                </>
              )}

              {row.kind === "list" && (
                // The picker is the whole point: a list id typed from memory is
                // how a segment targets a list that does not exist.
                <select
                  value={row.value}
                  aria-label="List"
                  disabled={busy || !lists}
                  style={{ width: "auto", minWidth: 180 }}
                  onChange={(e) => update(row.id, { value: e.target.value })}
                >
                  <option value="">{lists ? "choose a list…" : "loading lists…"}</option>
                  {(lists ?? []).map((l) => (
                    <option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>
                  ))}
                </select>
              )}

              {row.kind === "entitlement" && (
                <select
                  value={row.value}
                  aria-label="Entitlement"
                  disabled={busy}
                  style={{ width: "auto" }}
                  onChange={(e) => update(row.id, { value: e.target.value })}
                >
                  <option value="">choose…</option>
                  {ENTITLEMENT_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              )}

              {row.kind === "attribute" && row.op !== "exists" && (
                <input
                  value={row.value}
                  aria-label="Value"
                  placeholder="value"
                  disabled={busy}
                  style={{ width: 160 }}
                  onChange={(e) => update(row.id, { value: e.target.value })}
                />
              )}

              <button
                className="btn ghost"
                aria-label="Remove condition"
                disabled={busy || rows.length === 1}
                onClick={() => setRows(rows.filter((r) => r.id !== row.id))}
              >
                Remove
              </button>
              {rp && <span className="err" style={{ alignSelf: "center" }}>{rp}</span>}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
        <button
          className="btn ghost"
          disabled={busy || rows.length >= MAX_CONDITIONS}
          onClick={() => setRows([...rows, newRow()])}
        >
          + Add condition
        </button>
        <button className="btn ghost" disabled={busy} onClick={onRaw}>
          Advanced (JSON)
        </button>
      </div>

      {listsError && (
        // Said plainly: without the lists the base condition cannot be chosen,
        // and an empty picker would otherwise read as "you have no lists".
        <p className="err" style={{ margin: "8px 0 0" }}>Could not load lists: {listsError}</p>
      )}
      {problem && <p className="muted" style={{ margin: "8px 0 0" }}>{problem}</p>}
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
