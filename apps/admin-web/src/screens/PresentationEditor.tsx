import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { api, type ListPresentation } from "../api.js";

const DEFAULT_PRESENTATION: ListPresentation = {
  showFrequency: true, showSendTime: true, showDescription: true, showReaderCount: false, showFreePaidCount: false,
  frequencyLabel: "Daily", sendTimeLabel: "Weekday mornings",
};

export function PresentationEditor({ org }: { org: string }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const [listId, setListId] = useState("");
  const [p, setP] = useState<ListPresentation>(DEFAULT_PRESENTATION);
  const [msg, setMsg] = useState("");
  // Prefill with the selected list's *current* toggles so Save doesn't silently
  // clobber them with defaults (#143). The admin lists payload already carries
  // `presentation`; fall back to defaults for a list that has none set yet.
  useEffect(() => {
    if (!listId) {
      setP(DEFAULT_PRESENTATION);
      return;
    }
    const current = (lists.data ?? []).find((l) => l.listId === listId)?.presentation;
    setP({ ...DEFAULT_PRESENTATION, ...(current ?? {}) });
  }, [listId, lists.data]);
  const toggle = (k: keyof ListPresentation) => setP({ ...p, [k]: !p[k] });
  const save = async () => {
    setMsg("");
    try { await api.setPresentation(org, listId, p); setMsg("Saved"); } catch (e) { setMsg(String(e)); }
  };
  const Check = ({ k, label }: { k: keyof ListPresentation; label: string }) => (
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input type="checkbox" checked={Boolean(p[k])} onChange={() => toggle(k)} /> {label}
    </label>
  );
  return (
    <div>
      <h1 className="h1">Subscriber-site presentation</h1>
      <div className="card">
        <label>List</label>
        <select value={listId} onChange={(e) => setListId(e.target.value)} style={{ width: "100%" }}>
          <option value="">Choose a list…</option>
          {(lists.data ?? []).map((l) => (<option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>))}
        </select>
        <p className="muted" style={{ margin: "6px 0 0" }}>
          Saving overwrites this list's current toggles with the values shown.
        </p>
        <div style={{ marginTop: 12 }}>
          <Check k="showFrequency" label="Show frequency" />
          <Check k="showSendTime" label="Show send time" />
          <Check k="showDescription" label="Show description" />
          <Check k="showReaderCount" label="Show reader count" />
          <Check k="showFreePaidCount" label="Show free / paid count" />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div><label>Frequency label</label><input value={p.frequencyLabel ?? ""} onChange={(e) => setP({ ...p, frequencyLabel: e.target.value })} /></div>
          <div><label>Send-time label</label><input value={p.sendTimeLabel ?? ""} onChange={(e) => setP({ ...p, sendTimeLabel: e.target.value })} /></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void save()} disabled={!listId}>Save toggles</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
