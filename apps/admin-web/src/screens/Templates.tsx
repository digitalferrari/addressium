import { useState } from "react";
import { useAsync } from "../useAsync.js";
import { isValidId } from "../ids.js";
import { VisualEditor } from "../VisualEditor.js";
import { api, type Template, type TemplateMode } from "../api.js";

export function Templates({ org }: { org: string }) {
  const { data, error, loading } = useAsync(() => api.templates(org), [org]);
  const [rev, setRev] = useState(0);
  const list = useAsync(() => api.templates(org), [org, rev]);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<TemplateMode>("raw_html");
  const [source, setSource] = useState("");
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
    setTemplateId(t.templateId); setName(t.name); setMode(t.mode); setSource(t.source); setMsg(""); setPreview(null);
  };
  const reset = () => { setTemplateId(""); setName(""); setMode("raw_html"); setSource(""); setMsg(""); setPreview(null); };

  const save = async () => {
    setMsg(""); setBusy(true);
    try {
      const saved = await api.saveTemplate({ orgId: org, templateId: templateId.trim(), name: name.trim(), mode, source });
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
      <h1 className="h1">Templates · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Reusable message templates. <strong>Raw HTML</strong> is sanitized on save and rendered per
        recipient (merge tags escaped, links tokenized for click tracking). <strong>MJML</strong> and the
        <strong> visual builder</strong> compile to responsive HTML in your browser before scheduling.
      </p>
      {(loading || list.loading) && <div className="card muted">Loading…</div>}
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
            <VisualEditor initialMjml={source} onApply={(m) => { setSource(m); setPreview(null); }} />
            {source.trim() && <p className="muted" style={{ margin: "6px 0 0" }}>MJML captured ({source.length} chars). Compile &amp; preview or Save below.</p>}
          </div>
        ) : (
          <>
            <label style={{ marginTop: 12 }}>{mode === "mjml" ? "MJML source" : "HTML source"} — {"{{merge}}"} tags allowed</label>
            <textarea value={source} onChange={(e) => { setSource(e.target.value); setPreview(null); }} rows={12}
              placeholder={mode === "mjml" ? "<mjml>…</mjml>" : "<h1>Hello {{first_name}}</h1>\n<a href=\"https://…\">Read more</a>"}
              style={{ width: "100%", fontFamily: "monospace" }} />
          </>
        )}
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
