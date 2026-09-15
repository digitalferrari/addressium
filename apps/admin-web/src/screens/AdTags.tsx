/**
 * Ad tags (GitHub #279) — author the LiveIntent HTML that fills a
 * template's declared ad slots, stored on the recurring series so one fill
 * applies to every edition (`AdSlotFill.binding.kind === "series"`).
 *
 * WHAT THIS SCREEN DOES AND DOES NOT DO — read before changing the copy below.
 *
 * Authoring is real and complete: `POST /series` stores the fills, `GET
 * /orgs/:org/series` reads them back, the domain stamps each fill's binding to
 * this series and refuses a slot filled twice, and the round-trip is covered
 * (packages/domain/test/series.test.ts, packages/integration-tests/test/series-route.test.ts).
 *
 * Rendering is wired through `SendDescriptor.seriesId`: structured ad blocks
 * are overlaid at send time, while raw HTML/MJML templates use the documented
 * `{{slot_name}}` marker. Ad HTML is inserted before merge escaping and remains
 * untracked, as required for advertiser markup.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type CampaignSeries, type SaveSeriesBody, type Template } from "../api.js";
import { useAsync } from "../useAsync.js";

export function AdTags({ org }: { org: string }) {
  const series = useAsync(() => api.series(org), [org]);
  const templates = useAsync(() => api.templates(org), [org]);
  const [selectedId, setSelectedId] = useState("");
  const [reportId, setReportId] = useState("");
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [localSeries, setLocalSeries] = useState<CampaignSeries[] | undefined>();
  const [form, setForm] = useState<SaveSeriesBody>({ orgId: org, seriesId: "", name: "", cadence: "weekly", templateId: "", adSlotFills: [] });

  const rows = localSeries ?? series.data ?? [];
  const seriesReport = useAsync(
    () => reportId ? api.seriesReport(org, reportId) : Promise.resolve(null),
    [org, reportId],
  );
  const selected = rows.find((item) => item.seriesId === selectedId);
  const template = (templates.data ?? []).find((item) => item.templateId === form.templateId);
  const slots = useMemo(() => template?.adSlots ?? [...new Set(form.adSlotFills.map((fill) => fill.slot))], [template, form.adSlotFills]);
  // A fill whose slot the template has since stopped declaring gets no editor
  // row, so it is invisible and unremovable here while still being listed as a
  // chip on the series card. Naming them — and dropping them on save below, so
  // the save matches what the editor showed — is the honest resolution; keeping
  // them would re-save a fill the operator cannot see, read or delete.
  const orphans = useMemo(
    () => form.adSlotFills.map((fill) => fill.slot).filter((slot) => !slots.includes(slot)),
    [form.adSlotFills, slots],
  );

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
    // Only slots the template declares, and only those with content: an orphan
    // fill has no editor row, so re-saving one would persist HTML the operator
    // was never shown and cannot remove.
    const fills = form.adSlotFills
      .filter((fill) => slots.includes(fill.slot) && fill.html.trim())
      .map((fill) => ({ ...fill, html: fill.html, version: fill.version ?? 1 }));
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
    <div className="pagehead"><div><h1>Ad tags</h1><p>LiveIntent ad HTML, one fill per slot — held on the series rather than on a single campaign.</p></div><button className="btn" onClick={() => begin()}>＋ Add series</button></div>
    <div className="card" role="status" style={{ borderLeft: "3px solid #2d7a46" }}>
      <strong>Series fills are active.</strong>
      <p className="muted" style={{ marginBottom: 0 }}>Structured ad blocks are replaced by matching series fills at send time. In raw HTML or MJML, place the declared slot marker such as <code>{"{{ad_top}}"}</code>; the fill is inserted verbatim and is never tokenized or click-tracked.</p>
    </div>
    {message && <p className="muted">{message}</p>}
    {reportId && seriesReport.loading && <p className="muted">Loading series report…</p>}
    {reportId && seriesReport.error && <p className="err">Could not load series report: {seriesReport.error}</p>}
    {reportId && seriesReport.data && <div className="card">
      <div className="cardhead" style={{ margin: "-18px -18px 16px" }}><h2>Series reporting · {reportId}</h2></div>
      <div className="kpi-grid">
        <div><span className="muted">Sent</span><strong>{seriesReport.data.aggregate.sent}</strong></div>
        <div><span className="muted">Delivered</span><strong>{seriesReport.data.aggregate.delivered}</strong></div>
        <div><span className="muted">Unique opens</span><strong>{seriesReport.data.aggregate.opens}</strong></div>
        <div><span className="muted">Unique clicks</span><strong>{seriesReport.data.aggregate.clicks}</strong></div>
      </div>
      <p className="muted">{seriesReport.data.editions.length} edition{seriesReport.data.editions.length === 1 ? "" : "s"} included. Rates use the aggregate sent count.</p>
      <button className="btn ghost" onClick={() => setReportId("")}>Close report</button>
    </div>}
    {editing && <div className="card">
      <div className="cardhead" style={{ margin: "-18px -18px 16px" }}><h2>{selected ? "Edit series ad tags" : "Create series ad tags"}</h2></div>
      <div style={{ display: "flex", gap: 12 }}><label style={{ flex: 1 }}>Series id<input value={form.seriesId} disabled={!!selected} onChange={(e) => setForm({ ...form, seriesId: e.target.value })} placeholder="weekly-news" /></label><label style={{ flex: 2 }}>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Weekly news" /></label></div>
      <div style={{ display: "flex", gap: 12 }}><label style={{ flex: 1 }}>Template<select value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value, adSlotFills: [] })}>{(templates.data ?? []).map((item: Template) => <option key={item.templateId} value={item.templateId}>{item.name} ({item.templateId})</option>)}</select></label><label style={{ flex: 1 }}>Cadence<select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value as SaveSeriesBody["cadence"] })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="monthly">Monthly</option></select></label></div>
      {slots.length === 0 ? <p className="muted">This template declares no ad slots. Add slot names in Templates first, then return here.</p> : slots.map((slot) => <label key={slot}>{slot}<textarea rows={4} value={fillFor(slot)} onChange={(e) => setFill(slot, e.target.value)} placeholder="Paste the LiveIntent HTML snippet" style={{ width: "100%", fontFamily: "monospace" }} /></label>)}
      <p className="muted">A blank slot is saved as no fill at all. Ad HTML is stored verbatim — it is never tokenized, click-tracked or rewritten, which is why it is also never checked for you.</p>
      {orphans.length > 0 && <p className="muted">Stored fills for slots this template no longer declares: {orphans.map((slot) => <code key={slot} style={{ marginRight: 8 }}>{slot}</code>)} — saving now drops them.</p>}
      <div style={{ display: "flex", gap: 8 }}><button className="btn" onClick={() => void save()}>Save ad tags</button><button className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
    </div>}
    {series.loading && <p className="muted">Loading series…</p>}
    {series.error && <p className="err">Could not load recurring series: {series.error}</p>}
    {!series.loading && !series.error && rows.length === 0 && !editing && <div className="card muted">No recurring series yet. Create one here, then bind its template’s declared slots.</div>}
    {rows.map((item) => <div className="card" key={item.seriesId}><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><div><h2 style={{ marginTop: 0 }}>{item.name}</h2><p className="muted">{item.seriesId} · {item.cadence} · template <code>{item.templateId}</code></p></div><div style={{ display: "flex", gap: 8 }}><button className="btn ghost" onClick={() => setReportId(item.seriesId)}>Report</button><button className="btn ghost" onClick={() => begin(item)}>Edit</button></div></div><p>{item.adSlotFills.length ? item.adSlotFills.map((fill) => <code key={fill.slot} style={{ marginRight: 8 }}>{fill.slot}</code>) : <span className="muted">No filled slots</span>}</p></div>)}
  </div>;
}
