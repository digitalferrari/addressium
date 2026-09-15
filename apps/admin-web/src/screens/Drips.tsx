import { useState } from "react";
import { useAsync } from "../useAsync.js";
import { isValidId } from "../ids.js";
import { api, type DripStepDef } from "../api.js";

interface DraftStep { stepId: string; waitSeconds: string; listId: string; templateId: string; subject: string }

export function Drips({ org }: { org: string }) {
  const [rev, setRev] = useState(0);
  const sequences = useAsync(() => api.dripSequences(org), [org, rev]);
  const lists = useAsync(() => api.lists(org), [org]);
  const templates = useAsync(() => api.templates(org), [org]);
  const [sequenceId, setSequenceId] = useState("");
  const [name, setName] = useState("");
  const [triggerKind, setTriggerKind] = useState<"signup" | "manual">("signup");
  const [triggerListId, setTriggerListId] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>([{ stepId: "", waitSeconds: "0", listId: "", templateId: "", subject: "" }]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const setStep = (i: number, patch: Partial<DraftStep>) =>
    setSteps((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addStep = () => setSteps((ss) => [...ss, { stepId: "", waitSeconds: "0", listId: "", templateId: "", subject: "" }]);
  const removeStep = (i: number) => setSteps((ss) => ss.filter((_, j) => j !== i));

  const save = async () => {
    setMsg(""); setBusy(true);
    try {
      const stepDefs: DripStepDef[] = steps.map((s) => ({
        stepId: s.stepId.trim(),
        waitSeconds: Number(s.waitSeconds) || 0,
        listId: s.listId,
        templateId: s.templateId,
        subject: s.subject,
      }));
      const trigger = triggerKind === "signup"
        ? { kind: "signup" as const, listId: triggerListId }
        : { kind: "manual" as const };
      const saved = await api.saveDripSequence({ orgId: org, sequenceId: sequenceId.trim(), name: name.trim(), trigger, steps: stepDefs });
      setMsg(`Saved "${saved.sequenceId}".`);
      setRev((n) => n + 1);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const stepsValid = steps.length > 0 && steps.every((s) => isValidId(s.stepId.trim()) && s.listId && s.templateId && s.subject.trim());
  const valid = isValidId(sequenceId.trim()) && name.trim() && stepsValid && (triggerKind === "manual" || !!triggerListId);

  return (
    <div>
      <h1 className="h1">Drip sequences · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Automated multi-step sends triggered on signup or manually. Drip steps render the selected
        template; use raw_html templates (server-side MJML compile isn't available).
      </p>
      {sequences.loading && <div className="card muted">Loading…</div>}
      {sequences.error && <p className="err">{sequences.error}</p>}
      {sequences.data && sequences.data.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Sequence</th><th>Trigger</th><th>Steps</th></tr></thead>
            <tbody>
              {sequences.data.map((s) => (
                <tr key={s.sequenceId}>
                  <td className="t-strong">{s.name} <span className="muted">({s.sequenceId})</span></td>
                  <td>{s.trigger.kind === "signup" ? `signup → ${s.trigger.listId}` : "manual"}</td>
                  <td>{s.steps.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>New sequence</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={sequenceId} onChange={(e) => setSequenceId(e.target.value)} placeholder="sequence id" style={{ flex: 1 }} disabled={busy} />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" style={{ flex: 2 }} disabled={busy} />
        </div>
        <label style={{ marginTop: 12 }}>Trigger</label>
        <div style={{ display: "flex", gap: 16 }}>
          {(["signup", "manual"] as const).map((k) => (
            <label key={k} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="radio" name="triggerKind" checked={triggerKind === k} onChange={() => setTriggerKind(k)} /> {k}
            </label>
          ))}
        </div>
        {triggerKind === "signup" && (
          <div style={{ marginTop: 8 }}>
            <label>Signup list</label>
            <select value={triggerListId} onChange={(e) => setTriggerListId(e.target.value)} style={{ width: "100%" }}>
              <option value="">Choose a list…</option>
              {(lists.data ?? []).map((l) => (<option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>))}
            </select>
          </div>
        )}
        <div style={{ marginTop: 16 }}>
          <div className="muted" style={{ marginBottom: 8 }}>Steps</div>
          {steps.map((s, i) => (
            <div key={i} style={{ borderTop: i ? "1px solid #eee" : "none", paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="muted">Step {i + 1}</span>
                {steps.length > 1 && <button className="btn ghost" onClick={() => removeStep(i)}>Remove</button>}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input value={s.stepId} onChange={(e) => setStep(i, { stepId: e.target.value })} placeholder="step id" style={{ flex: 1 }} />
                <input type="number" value={s.waitSeconds} onChange={(e) => setStep(i, { waitSeconds: e.target.value })} placeholder="wait seconds" style={{ flex: 1 }} />
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <select value={s.listId} onChange={(e) => setStep(i, { listId: e.target.value })} style={{ flex: 1 }}>
                  <option value="">List…</option>
                  {(lists.data ?? []).map((l) => (<option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>))}
                </select>
                <select value={s.templateId} onChange={(e) => setStep(i, { templateId: e.target.value })} style={{ flex: 1 }}>
                  <option value="">Template…</option>
                  {(templates.data ?? []).map((t) => (<option key={t.templateId} value={t.templateId}>{t.name} ({t.templateId})</option>))}
                </select>
              </div>
              <input value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} placeholder="Subject" style={{ width: "100%", marginTop: 6 }} />
            </div>
          ))}
          <button className="btn ghost" style={{ marginTop: 10 }} onClick={addStep}>+ Step</button>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
          <button className="btn" disabled={!valid || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save sequence"}</button>
          {msg && <span className={msg.startsWith("Saved") ? "muted" : "err"}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}
