import { useEffect, useState } from "react";
import { useAsync } from "../useAsync.js";
import { api, type ListPresentation } from "../api.js";

/**
 * What a list with no saved `presentation` already shows publicly. Mirrors
 * `UNCONFIGURED_PRESENTATION` in `@addressium/domain` (`publicListView` reads
 * it) — this app mirrors shared shapes rather than importing them, as
 * `ListPresentation` in api.ts and `ApiKeyScope` in ApiKeys.tsx do.
 *
 * It must stay equal to that constant — PresentationEditor.test.tsx imports the
 * real one and asserts it — because the two halves of this form need OPPOSITE
 * presence semantics and only this one can be object-keyed:
 *
 * - The five booleans are required in `ListPresentation`, so there is no
 *   per-field "unset" to preserve. Presence lives one level up: a list either
 *   has a `presentation` object or does not. `setListPresentation` replaces
 *   that object wholesale, so the only way Save-without-touching-anything can
 *   be a no-op is for the prefill to equal what an absent object renders as.
 *   The old defaults turned frequency and send-time ON, so an operator who
 *   opened this screen to flip one checkbox published two fields they never
 *   chose (#262, #286).
 * - The two labels ARE optional, so they keep per-field presence: absent stays
 *   absent, and `""` is a real value meaning "the operator cleared it".
 *
 * Presence-keying the booleans the way the labels are keyed would be the
 * mirror-image data loss — the same trap `markScheduleActive` in
 * packages/domain/src/schedule-state.ts documents, where keying on a field's
 * absence rather than on an independent fact erases live state. Here every
 * unchecked box would look "unset" and be dropped, so unchecking a box would
 * never save.
 */
const UNCONFIGURED_PRESENTATION: ListPresentation = {
  showFrequency: false, showSendTime: false, showDescription: true, showReaderCount: false, showFreePaidCount: false,
};

export function PresentationEditor({ org }: { org: string }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const [listId, setListId] = useState("");
  const [p, setP] = useState<ListPresentation>(UNCONFIGURED_PRESENTATION);
  const [msg, setMsg] = useState("");
  // Prefill with the selected list's *current* toggles so Save doesn't silently
  // clobber them with defaults (#143). The admin lists payload already carries
  // `presentation`; a list that has none set yet prefills with what it already
  // renders as, so opening the screen and saving changes nothing (#262, #286).
  // Optional labels stay absent until edited; examples belong in placeholders,
  // never in the state sent to the API.
  useEffect(() => {
    if (!listId) {
      setP(UNCONFIGURED_PRESENTATION);
      return;
    }
    const current = (lists.data ?? []).find((l) => l.listId === listId)?.presentation;
    setP({ ...UNCONFIGURED_PRESENTATION, ...(current ?? {}) });
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
          Saving replaces this list's toggles and labels with what is shown. A list you have not
          configured yet shows exactly what subscribers already see, so saving it unchanged
          changes nothing. Label examples are not saved unless you enter them.
        </p>
        <div style={{ marginTop: 12 }}>
          <Check k="showFrequency" label="Show frequency" />
          <Check k="showSendTime" label="Show send time" />
          <Check k="showDescription" label="Show description" />
          <Check k="showReaderCount" label="Show reader count" />
          <Check k="showFreePaidCount" label="Show free / paid count" />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div><label htmlFor="presentation-frequency-label">Frequency label</label><input id="presentation-frequency-label" placeholder="e.g. Daily" value={p.frequencyLabel ?? ""} onChange={(e) => setP({ ...p, frequencyLabel: e.target.value })} /></div>
          <div><label htmlFor="presentation-send-time-label">Send-time label</label><input id="presentation-send-time-label" placeholder="e.g. Weekday mornings" value={p.sendTimeLabel ?? ""} onChange={(e) => setP({ ...p, sendTimeLabel: e.target.value })} /></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void save()} disabled={!listId}>Save toggles</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
