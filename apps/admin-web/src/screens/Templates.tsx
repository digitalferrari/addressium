import { useState } from "react";
import { useAsync } from "../useAsync.js";
import { isValidId } from "../ids.js";
import { VisualEditor } from "../VisualEditor.js";
import { api, type Template, type TemplateMode } from "../api.js";
import { SkeletonTable } from "../Skeleton.js";

export function Templates({ org }: { org: string }) {
  const { data, error, loading } = useAsync(() => api.templates(org), [org]);
  const [rev, setRev] = useState(0);
  const list = useAsync(() => api.templates(org), [org, rev]);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<TemplateMode>("raw_html");
  const [source, setSource] = useState("");
  const [adSlots, setAdSlots] = useState("");
  const [editorRevision, setEditorRevision] = useState(0);
  const [preview, setPreview] = useState<{ html: string; errors: string[] } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const compile = async () => {
    try {
      const { default: mjml2html } = await import("mjml-browser");
      const r = mjml2html(source);
      setPreview({ html: r.html, errors: r.errors.map((e) => e.formattedMessage ?? e.message) });
    } catch (e) {
      setPreview({ html: "", errors: [String(e)] });
    }
  };
  const edit = (t: Template) => {
    setTemplateId(t.templateId); setName(t.name); setMode(t.mode); setSource(t.source); setAdSlots((t.adSlots ?? []).join(", ")); setMsg(""); setPreview(null);
    // VisualEditor reads its seed only on mount, including when reloading the same template.
    setEditorRevision((n) => n + 1);
  };
  const reset = () => { setTemplateId(""); setName(""); setMode("raw_html"); setSource(""); setAdSlots(""); setMsg(""); setPreview(null); };

  const save = async () => {
    setMsg(""); setBusy(true);
    try {
      const slots = adSlots.split(",").map((slot) => slot.trim()).filter(Boolean);
      const saved = await api.saveTemplate({ orgId: org, templateId: templateId.trim(), name: name.trim(), mode, source, ...(slots.length > 0 ? { adSlots: slots } : {}) });
      setMsg(`Saved "${saved.templateId}" (v${saved.version}).`);
      setRev((n) => n + 1);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };
  // The id charset is enforced server-side (#196); gate here so the operator
  // is not handed a raw zod issue array after filling in a whole template.
  const valid = isValidId(templateId.trim()) && name.trim() && source.trim();
  const rows = list.data ?? data ?? [];

  return (
    <div>
      <div className="pagehead"><div><h1>Templates</h1><p>Three authoring modes — pick the right one for your team.</p></div></div>
      <p className="muted">
        Reusable message templates. <strong>Raw HTML</strong> is sanitized on save and rendered per
        recipient (merge tags escaped, links tokenized for click tracking). <strong>MJML</strong> and the
        <strong> visual builder</strong> compile to responsive HTML in your browser before scheduling.
      </p>
      <p className="muted">
        Compose loads a copy of a saved template. Saving changes here does not update a body
        already loaded in Compose or any scheduled campaign, including recurring sends.
      </p>
      {(loading || list.loading) && <SkeletonTable rows={4} />}
      {(error || list.error) && <p className="err">{error || list.error}</p>}
      {rows.length > 0 && (
        <div className="card">
          <table>
            <thead><tr><th>Template</th><th>Mode</th><th>Version</th><th></th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.templateId}>
                  <td className="t-strong">{t.name} <span className="muted">({t.templateId})</span></td>
                  <td>{t.mode}</td>
                  <td>v{t.version}</td>
                  <td><button className="btn ghost" onClick={() => edit(t)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>{templateId ? `Editing ${templateId}` : "New template"}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={templateId} onChange={(e) => setTemplateId(e.target.value)} placeholder="template id" style={{ flex: 1 }} disabled={busy} />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" style={{ flex: 2 }} disabled={busy} />
          <select value={mode} onChange={(e) => { setMode(e.target.value as TemplateMode); setPreview(null); }} disabled={busy}>
            <option value="raw_html">raw_html</option>
            <option value="mjml">mjml</option>
            <option value="visual">visual</option>
          </select>
        </div>
        {mode === "visual" ? (
          <div style={{ marginTop: 12 }}>
            <label>Visual builder — drag blocks; outputs MJML on “Apply to template”</label>
            <VisualEditor key={editorRevision} initialMjml={source} onApply={(m) => { setSource(m); setPreview(null); }} />
            {source.trim() && <p className="muted" style={{ margin: "6px 0 0" }}>MJML captured ({source.length} chars). Compile &amp; preview or Save below.</p>}
          </div>
        ) : (
          <>
            <label style={{ marginTop: 12 }}>{mode === "mjml" ? "MJML source" : "HTML source"} — {"{{merge}}"} tags and {"{{ad_top}}"} series slot markers allowed</label>
            <textarea value={source} onChange={(e) => { setSource(e.target.value); setPreview(null); }} rows={12}
              placeholder={mode === "mjml" ? "<mjml>…</mjml>" : "<h1>Hello {{first_name}}</h1>\n<div>{{ad_top}}</div>"}
              style={{ width: "100%", fontFamily: "monospace" }} />
          </>
        )}
        <label style={{ marginTop: 12 }}>Ad slot names <span className="muted">(comma-separated; place as {"{{ad_top}}"} in raw HTML/MJML, or use an ad block in Compose)</span><input value={adSlots} onChange={(e) => setAdSlots(e.target.value)} placeholder="ad_top, ad_footer" style={{ width: "100%" }} /></label>
        {(mode === "mjml" || mode === "visual") && (
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={compile} disabled={!source.trim()}>Compile &amp; preview</button>
            {preview && preview.errors.length > 0 && (
              <p className="err" style={{ margin: "6px 0 0" }}>{preview.errors.length} MJML issue(s): {preview.errors[0]}</p>
            )}
            {preview && (
              // `sandbox` with no allow-* tokens: the preview is operator-authored
              // HTML rendered inside the console's own origin, so without it a
              // pasted <script> runs with the session tokens in reach. Email
              // clients don't run scripts either, so this also makes the preview
              // a more honest one (#197).
              <iframe title="preview" sandbox="" srcDoc={preview.html} style={{ width: "100%", height: 320, marginTop: 8, border: "1px solid #ddd", background: "#fff" }} />
            )}
          </div>
        )}
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
          <button className="btn" disabled={!valid || busy} onClick={save}>{busy ? "Saving…" : "Save template"}</button>
          {templateId && <button className="btn ghost" onClick={reset} disabled={busy}>New</button>}
          {msg && <span className={msg.startsWith("Saved") ? "muted" : "err"}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}
