/**
 * addressium admin console (#4). Cognito Hosted-UI login, org switcher, and the
 * RBAC-aware operator screens: dashboard, click-map report + AI analysis (#32),
 * subscriber-site branding (#31), per-list presentation toggles (#33),
 * subscribers, and AI-provider settings. Server-side RBAC is the boundary; the
 * console mirrors capabilities only to hide/disable controls.
 */
import { useEffect, useMemo, useState } from "react";
import { completeLoginIfPresent, decodeClaims, getTokens, login, logout } from "./auth.js";
import { grantFromClaims, can, type Grant } from "./rbac.js";
import { VisualEditor } from "./VisualEditor.js";
import { api, type Branding, type CampaignReport, type EmailBlock, type ListPresentation, type ScheduleWhen, type SendScheduleState, type SetupState, type Template, type TemplateMode, type UsageRecord } from "./api.js";

type View = "dashboard" | "setup" | "templates" | "compose" | "report" | "usage" | "schedules" | "branding" | "presentation" | "subscribers" | "settings";

export function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    completeLoginIfPresent()
      .catch(() => undefined)
      .finally(() => {
        setAuthed(getTokens() !== null);
        setReady(true);
      });
  }, []);

  if (!ready) return <div className="center muted">Loading…</div>;
  if (!authed) {
    return (
      <div className="center">
        <div className="card" style={{ textAlign: "center" }}>
          <div className="brand">addressium</div>
          <p className="muted">Operator console</p>
          <button className="btn" onClick={() => void login()}>
            Sign in with Cognito
          </button>
        </div>
      </div>
    );
  }
  return <Console />;
}

function Console() {
  const claims = useMemo(() => {
    const t = getTokens();
    return t ? decodeClaims(t.idToken) : {};
  }, []);
  const grant: Grant | null = useMemo(() => grantFromClaims(claims), [claims]);
  const orgs = useMemo(() => {
    const raw = (claims["custom:orgs"] ?? "").trim();
    return raw === "*" ? [] : raw.split(",").map((o) => o.trim()).filter(Boolean);
  }, [claims]);

  const [org, setOrg] = useState(orgs[0] ?? "");
  const [view, setView] = useState<View>("dashboard");
  const [orgEnv, setOrgEnv] = useState<"prod" | "dev" | null>(null);
  useEffect(() => {
    setOrgEnv(null);
    if (!org) return;
    let live = true;
    api.orgMeta(org).then((m) => live && setOrgEnv(m.environment)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [org]);

  const NavItem = ({ id, label, cap }: { id: View; label: string; cap?: Parameters<typeof can>[1] }) =>
    cap && !can(grant, cap, org) ? null : (
      <button className={view === id ? "active" : ""} onClick={() => setView(id)}>
        {label}
      </button>
    );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">addressium</div>
        <label>Organization</label>
        {orgs.length > 0 ? (
          <select value={org} onChange={(e) => setOrg(e.target.value)} style={{ width: "100%" }}>
            {orgs.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="org id" style={{ width: "100%" }} />
        )}
        {orgEnv === "dev" && (
          <div
            style={{
              marginTop: 8,
              padding: "2px 8px",
              display: "inline-block",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
              color: "#7a4d00",
              background: "#ffe8a3",
            }}
            title="Test organization — same workflows as production, excluded from cost rollups"
          >
            DEV
          </div>
        )}
        <nav className="nav" style={{ marginTop: 16 }}>
          <NavItem id="dashboard" label="Dashboard" />
          <NavItem id="setup" label="Setup" />
          <NavItem id="templates" label="Templates" cap="campaigns:manage" />
          <NavItem id="compose" label="Compose & schedule" cap="campaigns:schedule" />
          <NavItem id="report" label="Campaign report" cap="reports:view" />
          <NavItem id="schedules" label="Schedules" cap="campaigns:schedule" />
          <NavItem id="usage" label="Usage & cost" cap="reports:view" />
          <NavItem id="subscribers" label="Subscribers" cap="subscribers:manage" />
          <NavItem id="branding" label="Branding" cap="branding:manage" />
          <NavItem id="presentation" label="Presentation" cap="branding:manage" />
          <NavItem id="settings" label="AI settings" cap="identity:manage" />
        </nav>
        <div style={{ marginTop: 24 }} className="muted">
          {claims["custom:role"] ?? "unknown role"}
        </div>
        <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => { logout(); location.reload(); }}>
          Sign out
        </button>
      </aside>
      <main className="main">
        {view === "dashboard" && <Dashboard org={org} onGoToSetup={() => setView("setup")} />}
        {view === "setup" && <Setup org={org} />}
        {view === "templates" && <Templates org={org} />}
        {view === "compose" && <Compose org={org} onScheduled={() => setView("schedules")} />}
        {view === "report" && <Report org={org} grant={grant} />}
        {view === "schedules" && <Schedules org={org} grant={grant} />}
        {view === "usage" && <Usage org={org} />}
        {view === "subscribers" && <Subscribers org={org} />}
        {view === "branding" && <BrandingEditor org={org} />}
        {view === "presentation" && <PresentationEditor org={org} />}
        {view === "settings" && <AiSettings org={org} />}
      </main>
    </div>
  );
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    fn()
      .then((data) => live && setState({ data, loading: false }))
      .catch((e) => live && setState({ error: String(e), loading: false }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function Dashboard({ org, onGoToSetup }: { org: string; onGoToSetup: () => void }) {
  const { data, error, loading } = useAsync(() => api.lists(org), [org]);
  const setup = useAsync(() => api.setup(org), [org]);
  return (
    <div>
      <h1 className="h1">Dashboard · {org || "—"}</h1>
      {setup.data && !setup.data.complete && (
        <div className="card" style={{ borderLeft: "3px solid #d99" }}>
          <div className="t-strong">Finish setting up this organization</div>
          <p className="muted" style={{ margin: "4px 0 8px" }}>
            {setup.data.requiredDone} of {setup.data.requiredTotal} required steps done — you can't send safely until they're complete.
          </p>
          <button className="btn" onClick={onGoToSetup}>Go to Setup</button>
        </div>
      )}
      <div className="card">
        <div className="muted">Newsletters</div>
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="err">{error}</p>}
        {data && <p className="kpi"><span className="n">{data.length}</span> <span className="l">lists</span></p>}
      </div>
    </div>
  );
}

function Setup({ org }: { org: string }) {
  const { data, error, loading } = useAsync(() => api.setup(org), [org]);
  return (
    <div>
      <h1 className="h1">Setup · {org || "—"}</h1>
      {loading && <div className="card muted">Loading…</div>}
      {error && <p className="err">{error}</p>}
      {data && (
        <>
          <div className="card">
            <div className="muted">
              {data.complete
                ? "All required steps complete — this organization is ready to send."
                : `${data.requiredDone} of ${data.requiredTotal} required steps complete.`}
            </div>
          </div>
          <div className="card">
            <table>
              <thead><tr><th></th><th>Step</th><th></th><th>How</th></tr></thead>
              <tbody>
                {data.steps.map((s) => (
                  <tr key={s.id}>
                    <td style={{ width: 24 }}>{s.done ? "✓" : "○"}</td>
                    <td className="t-strong">{s.label}</td>
                    <td className="muted">{s.required ? "required" : "recommended"}</td>
                    <td className="muted">{s.done ? "—" : s.hint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Report({ org, grant }: { org: string; grant: Grant | null }) {
  const [campaign, setCampaign] = useState("");
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [err, setErr] = useState("");
  const [ai, setAi] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setErr(""); setReport(null); setAi("");
    try {
      setReport(await api.report(org, campaign));
    } catch (e) {
      setErr(String(e));
    }
  };
  const analyze = async () => {
    setBusy(true); setErr("");
    try {
      const r = await api.analyze(org, campaign);
      setAi(`${r.vendor}/${r.model}\n\n${r.analysis}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const maxClicks = report ? Math.max(1, ...report.clickMap.rows.map((r) => r.clicks)) : 1;
  return (
    <div>
      <h1 className="h1">Campaign report</h1>
      <div className="card row">
        <input placeholder="campaign id" value={campaign} onChange={(e) => setCampaign(e.target.value)} />
        <button className="btn" onClick={() => void load()} disabled={!campaign}>Load</button>
        {report && (
          <button className="btn ghost" onClick={() => void analyze()} disabled={busy}>
            {busy ? "Analyzing…" : "Analyze with AI"}
          </button>
        )}
      </div>
      {err && <p className="err">{err}</p>}
      {report && (
        <>
          <div className="card">
            <div className="kpis">
              <Kpi n={report.counters.sent} l="sent" />
              <Kpi n={report.counters.opens} l={`opens (${pct(report.rates.openRate)})`} />
              <Kpi n={report.counters.clicks} l={`clicks (${pct(report.rates.clickRate)})`} />
              <Kpi n={report.counters.bounces} l={`bounces (${pct(report.rates.bounceRate)})`} />
              <Kpi n={report.counters.complaints} l={`complaints (${pct(report.rates.complaintRate)})`} />
            </div>
          </div>
          <div className="card">
            <div className="muted" style={{ marginBottom: 8 }}>Click overlay — editorial links</div>
            <table>
              <thead><tr><th>Link</th><th>Clicks</th><th>Unique</th><th></th></tr></thead>
              <tbody>
                {report.clickMap.rows.map((r) => (
                  <tr key={r.linkId}>
                    <td>{r.label}</td>
                    <td>{r.clicks}</td>
                    <td>{r.unique}</td>
                    <td style={{ width: "40%" }}><div className="bar" style={{ width: `${(r.clicks / maxClicks) * 100}%` }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.abResults && (
            <div className="card">
              <div className="muted">A/B ({report.abResults.metric}) — A {report.abResults.aScore} vs B {report.abResults.bScore}
                {report.abResults.winner ? ` · winner ${report.abResults.winner}` : ""}</div>
            </div>
          )}
        </>
      )}
      {ai && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>AI analysis</div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{ai}</pre>
        </div>
      )}
      {!can(grant, "reports:view", org) && <p className="muted">Your role can't view reports.</p>}
    </div>
  );
}

function Kpi({ n, l }: { n: number; l: string }) {
  return <div className="kpi"><div className="n">{n}</div><div className="l">{l}</div></div>;
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const usd = (n: number) => `$${n.toFixed(2)}`;
const gb = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(2)} GB`;

function Usage({ org }: { org: string }) {
  const { data, error, loading } = useAsync(() => api.usage(org), [org]);
  const rows = useMemo(() => {
    const list: UsageRecord[] = Array.isArray(data) ? data : data ? [data] : [];
    return [...list].sort((a, b) => b.period.localeCompare(a.period));
  }, [data]);
  const latest = rows[0];
  return (
    <div>
      <h1 className="h1">Usage &amp; cost · {org || "—"}</h1>
      {loading && <div className="card muted">Loading…</div>}
      {error && <p className="err">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <div className="card muted">No usage recorded yet. Metering populates once the scheduled job has run for a period.</div>
      )}
      {latest && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>Latest period · {latest.period}</div>
          <div className="kpis">
            <Kpi n={Number(usd(latest.cost.total).slice(1))} l="total $" />
            <Kpi n={latest.emailsSent} l="emails sent" />
            <Kpi n={Number(gb(latest.athenaBytesScanned).split(" ")[0])} l="GB scanned (Athena)" />
            <Kpi n={latest.dedicatedIps} l="dedicated IPs" />
          </div>
        </div>
      )}
      {rows.length > 0 && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>Cost by period (email · storage · dedicated IP · Athena scan)</div>
          <table>
            <thead>
              <tr><th>Period</th><th>Email</th><th>Storage</th><th>Ded. IP</th><th>Athena</th><th>Total</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.period}>
                  <td>{r.period}</td>
                  <td>{usd(r.cost.email)}</td>
                  <td>{usd(r.cost.storage)}</td>
                  <td>{usd(r.cost.dedicatedIp)}</td>
                  <td title={gb(r.athenaBytesScanned)}>{usd(r.cost.athena)}</td>
                  <td className="t-strong">{usd(r.cost.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Templates({ org }: { org: string }) {
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
  const valid = templateId.trim() && name.trim() && source.trim();
  const rows = list.data ?? data ?? [];

  return (
    <div>
      <h1 className="h1">Templates · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Reusable message templates. <strong>Raw HTML</strong> is sanitized on save and rendered per
        recipient (merge tags escaped, links tokenized for click tracking). MJML source is stored now;
        MJML compile + the GrapesJS visual builder land next.
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
              <iframe title="preview" srcDoc={preview.html} style={{ width: "100%", height: 320, marginTop: 8, border: "1px solid #ddd", background: "#fff" }} />
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

interface DraftBlock { kind: "text" | "editorial"; html: string; label: string; url: string }

function Compose({ org, onScheduled }: { org: string; onScheduled: () => void }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const templates = useAsync(() => api.templates(org), [org]);
  const [listId, setListId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyMode, setBodyMode] = useState<"blocks" | "html" | "mjml">("blocks");
  const [html, setHtml] = useState("");
  const [mjml, setMjml] = useState("");
  const [blocks, setBlocks] = useState<DraftBlock[]>([{ kind: "text", html: "", label: "", url: "" }]);
  const [when, setWhen] = useState<"now" | "at" | "recurring">("now");
  const [at, setAt] = useState("");
  const [cron, setCron] = useState("cron(0 13 * * ? *)");
  const [timezone, setTimezone] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (lists.data && lists.data.length > 0 && !listId) setListId(lists.data[0]!.listId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists.data]);

  const setBlock = (i: number, patch: Partial<DraftBlock>) =>
    setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const addBlock = (kind: "text" | "editorial") =>
    setBlocks((bs) => [...bs, { kind, html: "", label: "", url: "" }]);
  const removeBlock = (i: number) => setBlocks((bs) => bs.filter((_, j) => j !== i));

  const blocksValid = blocks.length > 0 && blocks.every((b) =>
    b.kind === "text" ? b.html.trim() !== "" : b.label.trim() !== "" && /^https?:\/\//.test(b.url.trim()),
  );
  const bodyValid = bodyMode === "blocks" ? blocksValid : bodyMode === "html" ? html.trim() !== "" : mjml.trim() !== "";
  const valid =
    !!listId && campaignId.trim() !== "" && subject.trim() !== "" && bodyValid &&
    (when !== "at" || at !== "") && (when !== "recurring" || cron.trim() !== "");

  const htmlTemplates = (templates.data ?? []).filter((t) => t.mode === "raw_html");
  const mjmlTemplates = (templates.data ?? []).filter((t) => t.mode === "mjml" || t.mode === "visual");

  const submit = async () => {
    setMsg(""); setBusy(true);
    try {
      const whenPayload: ScheduleWhen =
        when === "now" ? { type: "now" }
        : when === "at" ? { type: "at", at: new Date(at).toISOString() }
        : { type: "recurring", cron: cron.trim(), ...(timezone.trim() ? { timezone: timezone.trim() } : {}) };
      let template;
      if (bodyMode === "html") {
        template = { html };
      } else if (bodyMode === "mjml") {
        const { default: mjml2html } = await import("mjml-browser");
        const compiled = mjml2html(mjml);
        if (compiled.errors.length > 0) {
          setMsg(`MJML has ${compiled.errors.length} issue(s): ${compiled.errors[0]?.formattedMessage ?? compiled.errors[0]?.message}`);
          setBusy(false);
          return;
        }
        template = { mjmlHtml: compiled.html };
      } else {
        template = {
          blocks: blocks.map((b): EmailBlock =>
            b.kind === "text" ? { kind: "text", html: b.html } : { kind: "editorial", label: b.label, url: b.url.trim() },
          ),
        };
      }
      const res = await api.scheduleCampaign({ orgId: org, campaignId: campaignId.trim(), listId, subject, template, when: whenPayload });
      setMsg(`Scheduled "${res.scheduleId}" (${res.status}${res.at ? ` · ${new Date(res.at).toLocaleString()}` : ""}${res.timezone ? ` · ${res.timezone}` : ""}).`);
      onScheduled();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="h1">Compose &amp; schedule · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Build a send and schedule it now, at a time, or on a recurring cron. It appears under
        Schedules where you can pause or archive it.
      </p>
      {lists.data && lists.data.length === 0 && (
        <div className="card muted">No newsletters yet — create a list first.</div>
      )}
      <div className="card">
        <label>Newsletter</label>
        <select value={listId} onChange={(e) => setListId(e.target.value)} style={{ width: "100%" }}>
          {(lists.data ?? []).map((l) => (
            <option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>
          ))}
        </select>
        <label style={{ marginTop: 12 }}>Campaign id</label>
        <input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="e.g. daily-2026-07-21" style={{ width: "100%" }} />
        <label style={{ marginTop: 12 }}>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line" style={{ width: "100%" }} />
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span className="muted">Body</span>
          <span style={{ display: "flex", gap: 12 }}>
            {(["blocks", "html", "mjml"] as const).map((m) => (
              <label key={m} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="radio" name="bodyMode" checked={bodyMode === m} onChange={() => setBodyMode(m)} />
                {m === "blocks" ? "Blocks" : m === "html" ? "Raw HTML" : "MJML"}
              </label>
            ))}
          </span>
        </div>
        {bodyMode === "mjml" ? (
          <div>
            {mjmlTemplates.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <label>Load a saved MJML template</label>
                <select defaultValue="" onChange={(e) => {
                  const t = mjmlTemplates.find((x) => x.templateId === e.target.value);
                  if (t) setMjml(t.source);
                }} style={{ width: "100%" }}>
                  <option value="" disabled>Choose a template…</option>
                  {mjmlTemplates.map((t) => (<option key={t.templateId} value={t.templateId}>{t.name} ({t.templateId})</option>))}
                </select>
              </div>
            )}
            <textarea value={mjml} onChange={(e) => setMjml(e.target.value)} rows={12}
              placeholder={"<mjml><mj-body><mj-section><mj-column>\n  <mj-text>Hi {{first_name}} <a href=\"https://…\">read</a></mj-text>\n</mj-column></mj-section></mj-body></mjml>"}
              style={{ width: "100%", fontFamily: "monospace" }} />
            <p className="muted" style={{ margin: "6px 0 0" }}>
              Compiled to responsive HTML in your browser on schedule; merge tags escaped and links tokenized server-side.
            </p>
          </div>
        ) : bodyMode === "html" ? (
          <div>
            {htmlTemplates.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <label>Load a saved HTML template</label>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const t = htmlTemplates.find((x) => x.templateId === e.target.value);
                    if (t) setHtml(t.source);
                  }}
                  style={{ width: "100%" }}
                >
                  <option value="" disabled>Choose a template…</option>
                  {htmlTemplates.map((t) => (
                    <option key={t.templateId} value={t.templateId}>{t.name} ({t.templateId})</option>
                  ))}
                </select>
              </div>
            )}
            <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={12}
              placeholder={"<h1>Hello {{first_name}}</h1>\n<a href=\"https://…\">Read more</a>"}
              style={{ width: "100%", fontFamily: "monospace" }} />
            <p className="muted" style={{ margin: "6px 0 0" }}>
              Sanitized on schedule. Merge tags are escaped; every {"<a>"} is tokenized per recipient and tracked.
            </p>
          </div>
        ) : (
          <>
        {blocks.map((b, i) => (
          <div key={i} style={{ borderTop: i ? "1px solid #eee" : "none", paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="muted">{b.kind === "text" ? "Text block" : "Editorial link"}</span>
              {blocks.length > 1 && (
                <button className="btn ghost" onClick={() => removeBlock(i)}>Remove</button>
              )}
            </div>
            {b.kind === "text" ? (
              <textarea value={b.html} onChange={(e) => setBlock(i, { html: e.target.value })}
                placeholder="HTML — {{first_name}} merge tags allowed" rows={3} style={{ width: "100%" }} />
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <input value={b.label} onChange={(e) => setBlock(i, { label: e.target.value })} placeholder="Link label" style={{ flex: 1 }} />
                <input value={b.url} onChange={(e) => setBlock(i, { url: e.target.value })} placeholder="https://…" style={{ flex: 2 }} />
              </div>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="btn ghost" onClick={() => addBlock("text")}>+ Text</button>
          <button className="btn ghost" onClick={() => addBlock("editorial")}>+ Editorial link</button>
        </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>When</div>
        <div style={{ display: "flex", gap: 16 }}>
          {(["now", "at", "recurring"] as const).map((w) => (
            <label key={w} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="radio" name="when" checked={when === w} onChange={() => setWhen(w)} />
              {w === "now" ? "Send now" : w === "at" ? "At a time" : "Recurring"}
            </label>
          ))}
        </div>
        {when === "at" && (
          <div style={{ marginTop: 10 }}>
            <label>Send at (your local time; a 5-minute floor always applies)</label>
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} style={{ width: "100%" }} />
          </div>
        )}
        {when === "recurring" && (
          <div style={{ marginTop: 10 }}>
            <label>Cron expression</label>
            <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="cron(0 13 * * ? *)" style={{ width: "100%" }} />
            <label style={{ marginTop: 8 }}>Timezone (blank → org default)</label>
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Denver" style={{ width: "100%" }} />
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn" disabled={!valid || busy} onClick={submit}>
          {busy ? "Scheduling…" : "Schedule"}
        </button>
        {msg && <span className={msg.startsWith("Scheduled") ? "muted" : "err"}>{msg}</span>}
      </div>
    </div>
  );
}

function Schedules({ org, grant }: { org: string; grant: Grant | null }) {
  const [rows, setRows] = useState<SendScheduleState[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const canManage = can(grant, "campaigns:schedule", org);

  const load = () => {
    setError("");
    api.schedules(org).then(setRows).catch((e) => setError(String(e)));
  };
  useEffect(() => {
    setRows(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  const act = async (scheduleId: string, action: "start" | "pause" | "archive") => {
    setBusy(`${scheduleId}:${action}`);
    setError("");
    try {
      await api.scheduleLifecycle(org, scheduleId, action);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const badge = (s: SendScheduleState["status"]) => {
    const color =
      s === "active" ? "#1b7a3d" : s === "paused" ? "#7a4d00" : "#555";
    const bg = s === "active" ? "#d7f0df" : s === "paused" ? "#ffe8a3" : "#e2e2e2";
    return (
      <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, color, background: bg }}>
        {s.toUpperCase()}
      </span>
    );
  };

  return (
    <div>
      <h1 className="h1">Schedules · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Start, pause or archive scheduled sends. Nothing is ever deleted — a paused series
        stops its next edition and can be resumed; archive puts it away for good while keeping history.
      </p>
      {error && <p className="err">{error}</p>}
      {rows === null && !error && <div className="card muted">Loading…</div>}
      {rows && rows.length === 0 && (
        <div className="card muted">No scheduled sends yet. Schedule a campaign or recurring series to see it here.</div>
      )}
      {rows && rows.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr><th>Schedule</th><th>Kind</th><th>Cadence</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.scheduleId}>
                  <td className="t-strong">{r.scheduleId}</td>
                  <td>{r.kind === "recurring" ? "series" : "one-off"}</td>
                  <td className="muted">{r.cron ? `${r.cron}${r.timezone ? ` (${r.timezone})` : ""}` : "—"}</td>
                  <td>{badge(r.status)}</td>
                  <td>
                    {canManage ? (
                      <span style={{ display: "flex", gap: 6 }}>
                        <button className="btn ghost" disabled={r.status === "active" || !!busy} onClick={() => act(r.scheduleId, "start")}>Start</button>
                        <button className="btn ghost" disabled={r.status !== "active" || !!busy} onClick={() => act(r.scheduleId, "pause")}>Pause</button>
                        <button className="btn ghost" disabled={r.status === "archived" || !!busy} onClick={() => act(r.scheduleId, "archive")}>Archive</button>
                      </span>
                    ) : (
                      <span className="muted">read-only</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Subscribers({ org }: { org: string }) {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const suppress = async () => {
    setMsg("");
    try { await api.suppress(org, email); setMsg(`Suppressed ${email}`); }
    catch (e) { setMsg(String(e)); }
  };
  return (
    <div>
      <h1 className="h1">Subscribers</h1>
      <div className="card">
        <label>Manually suppress an address (does not delete)</label>
        <div className="row">
          <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn" onClick={() => void suppress()} disabled={!email}>Suppress</button>
        </div>
        {msg && <p className="muted">{msg}</p>}
      </div>
    </div>
  );
}

const DEFAULT_BRANDING: Branding = {
  primaryColor: "#4f8cff",
  secondaryColor: "#8a5cff",
  background: { type: "solid", color: "#0e1116" },
};

/** Persona-driven starting points (#53) — mirrors domain BRANDING_PRESETS. */
const BRANDING_PRESETS: { id: string; name: string; persona: string; branding: Branding }[] = [
  { id: "broadsheet", name: "Broadsheet", persona: "Editor", branding: { primaryColor: "#8a2f24", secondaryColor: "#7c5a2c", background: { type: "solid", color: "#f7f3ea" } } },
  { id: "marquee", name: "Marquee", persona: "Ad Director", branding: { primaryColor: "#e5484d", secondaryColor: "#6d3fc4", background: { type: "gradient", from: "#ffffff", to: "#fdecec", angle: 135 } } },
  { id: "contrast", name: "Contrast", persona: "A11y", branding: { primaryColor: "#0b57d0", secondaryColor: "#5b2d9c", background: { type: "solid", color: "#ffffff" } } },
  { id: "light", name: "Light", persona: "", branding: { primaryColor: "#2f56d4", secondaryColor: "#6d3fc4", background: { type: "solid", color: "#f4f6fa" } } },
  { id: "dark", name: "Dark", persona: "", branding: { primaryColor: "#6b8bf5", secondaryColor: "#b18cf0", background: { type: "solid", color: "#0c1220" } } },
];

function BrandingEditor({ org }: { org: string }) {
  const [b, setB] = useState<Branding>(DEFAULT_BRANDING);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api.getBranding(org).then((r) => r && setB(r)).catch(() => undefined);
  }, [org]);
  const save = async () => {
    setMsg("");
    try { await api.setBranding(org, b); setMsg("Saved"); } catch (e) { setMsg(String(e)); }
  };
  const bg = b.background;
  return (
    <div>
      <h1 className="h1">Subscriber-site branding</h1>
      <div className="card">
        <label>Start from a preset</label>
        <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {BRANDING_PRESETS.map((p) => (
            <button key={p.id} className="btn" title={p.persona || undefined}
              onClick={() => setB({ ...b, ...p.branding })}>
              {p.persona ? `${p.name} · ${p.persona}` : p.name}
            </button>
          ))}
        </div>
        <label>Logo URL</label>
        <input style={{ width: "100%" }} value={b.logoUrl ?? ""} onChange={(e) => setB({ ...b, logoUrl: e.target.value })} />
        <div className="row" style={{ marginTop: 8 }}>
          <div>
            <label>Primary</label>
            <input type="color" value={b.primaryColor} onChange={(e) => setB({ ...b, primaryColor: e.target.value })} />
          </div>
          <div>
            <label>Secondary</label>
            <input type="color" value={b.secondaryColor} onChange={(e) => setB({ ...b, secondaryColor: e.target.value })} />
          </div>
          <div>
            <label>Background</label>
            <select value={bg.type} onChange={(e) =>
              setB({ ...b, background: e.target.value === "gradient"
                ? { type: "gradient", from: "#0e1116", to: "#171b22", angle: 135 }
                : { type: "solid", color: "#0e1116" } })}>
              <option value="solid">Solid</option>
              <option value="gradient">Gradient</option>
            </select>
          </div>
        </div>
        {bg.type === "solid" ? (
          <div><label>Color</label><input type="color" value={bg.color} onChange={(e) => setB({ ...b, background: { type: "solid", color: e.target.value } })} /></div>
        ) : (
          <div className="row">
            <div><label>From</label><input type="color" value={bg.from} onChange={(e) => setB({ ...b, background: { ...bg, from: e.target.value } })} /></div>
            <div><label>To</label><input type="color" value={bg.to} onChange={(e) => setB({ ...b, background: { ...bg, to: e.target.value } })} /></div>
            <div><label>Angle</label><input type="number" value={bg.angle} onChange={(e) => setB({ ...b, background: { ...bg, angle: Number(e.target.value) } })} /></div>
          </div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void save()}>Save branding</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      </div>
      <div className="card" style={{
        background: bg.type === "solid" ? bg.color : `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})`,
      }}>
        <div className="muted">Preview</div>
        {b.logoUrl && <img src={b.logoUrl} alt="logo" style={{ maxHeight: 40 }} />}
        <div style={{ color: b.primaryColor, fontWeight: 700, fontSize: 20 }}>Primary heading</div>
        <div style={{ color: b.secondaryColor }}>Secondary accent</div>
      </div>
    </div>
  );
}

const DEFAULT_PRESENTATION: ListPresentation = {
  showFrequency: true, showSendTime: true, showDescription: true, showReaderCount: false, showFreePaidCount: false,
  frequencyLabel: "Daily", sendTimeLabel: "Weekday mornings",
};

function PresentationEditor({ org }: { org: string }) {
  const [listId, setListId] = useState("");
  const [p, setP] = useState<ListPresentation>(DEFAULT_PRESENTATION);
  const [msg, setMsg] = useState("");
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
        <label>List id</label>
        <input value={listId} onChange={(e) => setListId(e.target.value)} placeholder="e.g. ledger" />
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

function AiSettings({ org }: { org: string }) {
  const [vendor, setVendor] = useState("anthropic");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState("");
  const save = async () => {
    setMsg("");
    try { await api.setAiConfig(org, vendor, model, apiKey); setApiKey(""); setMsg("Saved (key stored in Secrets Manager)"); }
    catch (e) { setMsg(String(e)); }
  };
  return (
    <div>
      <h1 className="h1">AI analytics provider</h1>
      <div className="card">
        <div className="row">
          <div>
            <label>Vendor</label>
            <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </div>
          <div><label>Model</label><input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" /></div>
        </div>
        <label>API key (stored in AWS Secrets Manager, never echoed)</label>
        <input type="password" style={{ width: "100%" }} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void save()} disabled={!model || !apiKey}>Save provider</button>
          {msg && <span className="muted">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
