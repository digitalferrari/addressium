import { useEffect, useMemo, useState } from "react";
import { api, type CampaignSeries, type SaveSeriesBody, type Template } from "../api.js";
import { useAsync } from "../useAsync.js";

export function AdTags({ org }: { org: string }) {
  const series = useAsync(() => api.series(org), [org]);
  const templates = useAsync(() => api.templates(org), [org]);
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [localSeries, setLocalSeries] = useState<CampaignSeries[] | undefined>();
  const [form, setForm] = useState<SaveSeriesBody>({ orgId: org, seriesId: "", name: "", cadence: "weekly", templateId: "", adSlotFills: [] });

  const rows = localSeries ?? series.data ?? [];
  const selected = rows.find((item) => item.seriesId === selectedId);
  const template = (templates.data ?? []).find((item) => item.templateId === form.templateId);
  const slots = useMemo(() => template?.adSlots ?? [...new Set(form.adSlotFills.map((fill) => fill.slot))], [template, form.adSlotFills]);

  useEffect(() => {
    if (!selected) return;
    setForm({ orgId: org, seriesId: selected.seriesId, name: selected.name, cadence: selected.cadence, templateId: selected.templateId, adSlotFills: selected.adSlotFills.map((fill) => ({ slot: fill.slot, html: fill.html, version: fill.version })) });
  }, [org, selected]);

  const begin = (item?: CampaignSeries) => {
    setMessage("");
    if (item) {
      setSelectedId(item.seriesId);
      setForm({ orgId: org, seriesId: item.seriesId, name: item.name, cadence: item.cadence, templateId: item.templateId, adSlotFills: item.adSlotFills.map((fill) => ({ slot: fill.slot, html: fill.html, version: fill.version })) });
    } else {
      const first = templates.data?.[0];
      setSelectedId("");
      setForm({ orgId: org, seriesId: "", name: "", cadence: "weekly", templateId: first?.templateId ?? "", adSlotFills: [] });
    }
    setEditing(true);
  };

  const save = async () => {
    setMessage("");
    if (!form.seriesId || !form.name || !form.templateId) return setMessage("Series id, name and template are required.");
    const fills = form.adSlotFills.filter((fill) => fill.html.trim()).map((fill) => ({ ...fill, html: fill.html, version: fill.version ?? 1 }));
    try {
      const saved = await api.saveSeries({ ...form, seriesId: form.seriesId.trim(), name: form.name.trim(), adSlotFills: fills });
      setSelectedId(saved.seriesId);
      setEditing(false);
      setMessage("Ad tags saved.");
      setLocalSeries([...rows.filter((item) => item.seriesId !== saved.seriesId), saved]);
    } catch (e) { setMessage((e as Error).message); }
  };

  const fillFor = (slot: string) => form.adSlotFills.find((fill) => fill.slot === slot)?.html ?? "";
  const setFill = (slot: string, html: string) => setForm((current) => ({ ...current, adSlotFills: [...current.adSlotFills.filter((fill) => fill.slot !== slot), { slot, html, version: current.adSlotFills.find((fill) => fill.slot === slot)?.version ?? 1 }] }));

  return <div>
    <div className="pagehead"><div><h1>Ad tags</h1><p>LiveIntent ad HTML per slot, inserted as-is — never tokenized or click-tracked.</p></div><button className="btn" onClick={() => begin()}>＋ Add series</button></div>
    {message && <p className="muted">{message}</p>}
    {editing && <div className="card">
      <div className="cardhead" style={{ margin: "-18px -18px 16px" }}><h2>{selected ? "Edit series ad tags" : "Create series ad tags"}</h2></div>
      <div style={{ display: "flex", gap: 12 }}><label style={{ flex: 1 }}>Series id<input value={form.seriesId} disabled={!!selected} onChange={(e) => setForm({ ...form, seriesId: e.target.value })} placeholder="weekly-news" /></label><label style={{ flex: 2 }}>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Weekly news" /></label></div>
      <div style={{ display: "flex", gap: 12 }}><label style={{ flex: 1 }}>Template<select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value, adSlotFills: [] })}>{(templates.data ?? []).map((item: Template) => <option key={item.templateId} value={item.templateId}>{item.name} ({item.templateId})</option>)}</select></label><label style={{ flex: 1 }}>Cadence<select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value as SaveSeriesBody["cadence"] })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="monthly">Monthly</option></select></label></div>
      {slots.length === 0 ? <p className="muted">This template declares no ad slots. Add slot names in Templates first, then return here.</p> : slots.map((slot) => <label key={slot}>{slot}<textarea rows={4} value={fillFor(slot)} onChange={(e) => setFill(slot, e.target.value)} placeholder="Paste the LiveIntent HTML snippet" style={{ width: "100%", fontFamily: "monospace" }} /></label>)}
      <p className="muted">Blank slots are left unfilled. Ad HTML is intentionally not click-tracked or rewritten.</p>
      <div style={{ display: "flex", gap: 8 }}><button className="btn" onClick={() => void save()}>Save ad tags</button><button className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
    </div>}
    {series.loading && <p className="muted">Loading series…</p>}
    {!series.loading && rows.length === 0 && !editing && <div className="card muted">No recurring series yet. Create one here, then bind its template’s declared slots.</div>}
    {rows.map((item) => <div className="card" key={item.seriesId}><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><div><h2 style={{ marginTop: 0 }}>{item.name}</h2><p className="muted">{item.seriesId} · {item.cadence} · template <code>{item.templateId}</code></p></div><button className="btn ghost" onClick={() => begin(item)}>Edit</button></div><p>{item.adSlotFills.length ? item.adSlotFills.map((fill) => <code key={fill.slot} style={{ marginRight: 8 }}>{fill.slot}</code>) : <span className="muted">No filled slots</span>}</p></div>)}
  </div>;
}
