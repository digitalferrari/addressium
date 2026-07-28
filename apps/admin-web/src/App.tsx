/**
 * addressium admin console (#4). Cognito Hosted-UI login, org switcher, and the
 * RBAC-aware operator screens: dashboard, click-map report + AI analysis (#32),
 * subscriber-site branding (#31), per-list presentation toggles (#33),
 * subscribers, and AI-provider settings. Server-side RBAC is the boundary; the
 * console mirrors capabilities only to hide/disable controls.
 */
import { useEffect, useMemo, useState } from "react";
import { completeLoginIfPresent, decodeClaims, getTokens, isExpired, login, logout } from "./auth.js";
import { grantFromClaims, can, type Grant } from "./rbac.js";
import { idProblem, isValidId, suggestId } from "./ids.js";
import { VisualEditor } from "./VisualEditor.js";
// Subpath import, NOT the package barrel: the barrel re-exports modules that
// import node:crypto, which the browser bundle cannot resolve. The cost model
// itself is pure arithmetic.
import {
  estimateSendCost,
  DEFAULT_COST_INPUT,
  type SendCostInput,
  type CostLine,
} from "@addressium/domain/cost";
import { api, EMPTY_EXPLICIT, isExplicitPredicate, type SegmentMember, type AlertRule, type Branding, type CreateOrgInput, type CreateOrgResult, type TeamMemberRow, type ColumnMapping, type ImportPreview, type MappedImportReport, type MappingPlan, type NewListDefaults, type CampaignReport, type DripStepDef, type EmailBlock, type ListPresentation, type ScheduleWhen, type SendScheduleState, type SetupState, type Template, type TemplateMode, type UsageRecord } from "./api.js";

type View = "dashboard" | "setup" | "templates" | "compose" | "report" | "usage" | "schedules" | "branding" | "presentation" | "subscribers" | "segments" | "import" | "privacy" | "drips" | "costs" | "deliverability" | "importmap" | "team" | "audit" | "newsletters" | "addorg";

export function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    completeLoginIfPresent()
      .catch(() => undefined)
      .finally(() => {
        // An expired token used to leave the app believing it was signed in,
        // so every call 401'd into a swallowed catch and the operator saw blank
        // panels with no prompt to re-authenticate (#197).
        setAuthed(!isExpired(getTokens()));
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
          <NavItem id="newsletters" label="Newsletters" cap="newsletters:close" />
          <NavItem id="templates" label="Templates" cap="campaigns:manage" />
          <NavItem id="compose" label="Compose & schedule" cap="campaigns:schedule" />
          <NavItem id="report" label="Campaign report" cap="reports:view" />
          <NavItem id="schedules" label="Schedules" cap="campaigns:schedule" />
          <NavItem id="drips" label="Drip sequences" cap="campaigns:manage" />
          <NavItem id="segments" label="Segments" cap="segments:manage" />
          <NavItem id="usage" label="Usage & cost" cap="reports:view" />
          <NavItem id="costs" label="Cost estimator" cap="reports:view" />
          <NavItem id="subscribers" label="Subscribers" cap="subscribers:manage" />
          <NavItem id="importmap" label="Import (mapper)" cap="subscribers:manage" />
          <NavItem id="import" label="Import (simple)" cap="subscribers:manage" />
          <NavItem id="privacy" label="Data requests" cap="subscribers:manage" />
          <NavItem id="branding" label="Branding" cap="branding:manage" />
          <NavItem id="presentation" label="Presentation" cap="branding:manage" />
          <NavItem id="team" label="Team & access" cap="team:manage" />
          <NavItem id="audit" label="Audit log" cap="team:manage" />
          <NavItem id="addorg" label="Add organization" cap="identity:manage" />
          <NavItem id="deliverability" label="Deliverability" cap="alerts:manage" />
        </nav>
        <div style={{ marginTop: 24 }} className="muted">
          {claims["custom:role"] ?? "unknown role"}
        </div>
        <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => { logout(); location.reload(); }}>
          Sign out
        </button>
      </aside>
      <main className="main">
        <div className="view" key={view}>
        {view === "dashboard" && (<><HealthBadge org={org} /><Dashboard org={org} onGoToSetup={() => setView("setup")} /></>)}
        {view === "setup" && <Setup org={org} />}
        {view === "newsletters" && <Newsletters org={org} />}
        {view === "templates" && <Templates org={org} />}
        {view === "compose" && <Compose org={org} onScheduled={() => setView("schedules")} />}
        {view === "report" && <Report org={org} grant={grant} />}
        {view === "schedules" && <Schedules org={org} grant={grant} />}
        {view === "usage" && <Usage org={org} />}
        {view === "costs" && <CostEstimator />}
        {view === "subscribers" && <Subscribers org={org} />}
        {view === "segments" && <Segments org={org} />}
        {view === "importmap" && <ImportMapper org={org} />}
        {view === "import" && <ImportSubscribers org={org} />}
        {view === "privacy" && (<><BulkExport org={org} /><Privacy org={org} /></>)}
        {view === "drips" && <Drips org={org} />}
        {view === "branding" && <BrandingEditor org={org} />}
        {view === "presentation" && <PresentationEditor org={org} />}
        {view === "team" && <Team org={org} />}
        {view === "audit" && <AuditLogView org={org} />}
        {view === "addorg" && <AddOrganization />}
        {view === "deliverability" && <Deliverability org={org} />}
        </div>
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
        {loading && <div className="skeleton sk-kpi" style={{ width: 140, marginTop: 8 }} aria-label="Loading…" />}
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
  const campaigns = useAsync(() => api.campaigns(org), [org]);
  const [campaign, setCampaign] = useState("");
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [err, setErr] = useState("");

  const load = async () => {
    setErr(""); setReport(null);
    try {
      setReport(await api.report(org, campaign));
    } catch (e) {
      setErr(String(e));
    }
  };

  const maxClicks = report ? Math.max(1, ...report.clickMap.rows.map((r) => r.clicks)) : 1;
  return (
    <div>
      <h1 className="h1">Campaign report</h1>
      <div className="card row">
        <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
          <option value="">Choose a campaign…</option>
          {(campaigns.data ?? []).map((c) => (
            <option key={c.campaignId} value={c.campaignId}>{c.subject} ({c.campaignId})</option>
          ))}
        </select>
        <button className="btn" onClick={() => void load()} disabled={!campaign}>Load</button>
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
        </>
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

interface DraftBlock { kind: "text" | "editorial"; html: string; label: string; url: string }

function Compose({ org, onScheduled }: { org: string; onScheduled: () => void }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const templates = useAsync(() => api.templates(org), [org]);
  const segments = useAsync(() => api.segments(org), [org]);
  const [listId, setListId] = useState("");
  const [segmentId, setSegmentId] = useState("");
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
    !!listId && isValidId(campaignId.trim()) && subject.trim() !== "" && bodyValid &&
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
      const res = await api.scheduleCampaign({ orgId: org, campaignId: campaignId.trim(), listId, subject, template, when: whenPayload, ...(segmentId ? { segmentId } : {}) });
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
        <label style={{ marginTop: 12 }}>Segment (optional — targets within the list)</label>
        <select value={segmentId} onChange={(e) => setSegmentId(e.target.value)} style={{ width: "100%" }}>
          <option value="">Whole list (no segment)</option>
          {(segments.data ?? []).map((s) => (
            <option key={s.segmentId} value={s.segmentId}>{s.name} ({s.segmentId})</option>
          ))}
        </select>
        {segmentId && (
          <p className="muted" style={{ margin: "6px 0 0" }}>
            Only members of this segment who are <strong>confirmed on {listId || "the list"}</strong> will
            be sent to — segment membership is not consent.
          </p>
        )}
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
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [rev, setRev] = useState(0);
  const subs = useAsync(() => api.subscribers(org, query || undefined), [org, query, rev]);
  const supps = useAsync(() => api.suppressions(org), [org, rev]);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const reload = () => setRev((n) => n + 1);

  const suppress = async () => {
    setMsg("");
    try { await api.suppress(org, email); setMsg(`Suppressed ${email}`); reload(); }
    catch (e) { setMsg(String(e)); }
  };
  const unsubscribeAll = async (sub: string, subEmail: string) => {
    setMsg("");
    try { await api.adminUnsubscribe(org, sub, subEmail); setMsg(`Unsubscribed ${subEmail} from all lists`); reload(); }
    catch (e) { setMsg(String(e)); }
  };
  const lift = async (liftEmail: string) => {
    setMsg("");
    try { await api.unsuppress(org, liftEmail); setMsg(`Lifted suppression for ${liftEmail}`); reload(); }
    catch (e) { setMsg(String(e)); }
  };

  return (
    <div>
      <h1 className="h1">Subscribers · {org || "—"}</h1>
      {msg && <p className="muted">{msg}</p>}

      <div className="card">
        <div className="row">
          <input placeholder="Search by email…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setQuery(q.trim()); }} style={{ flex: 1 }} />
          <button className="btn" onClick={() => setQuery(q.trim())}>Search</button>
          {query && <button className="btn ghost" onClick={() => { setQ(""); setQuery(""); }}>Clear</button>}
        </div>
        {subs.loading && <p className="muted">Loading…</p>}
        {subs.error && <p className="err">{subs.error}</p>}
        {subs.data && subs.data.length === 0 && <p className="muted">No subscribers match.</p>}
        {subs.data && subs.data.length > 0 && (
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Email</th><th>Status</th><th>Entitlement</th><th>Last engaged</th><th></th></tr></thead>
            <tbody>
              {subs.data.map((s) => (
                <tr key={s.sub}>
                  <td className="t-strong">{s.email}</td>
                  <td>{s.status}</td>
                  <td>{s.entitlement}</td>
                  <td className="muted">{s.lastEngagedAt ? new Date(s.lastEngagedAt).toLocaleString() : "—"}</td>
                  <td><button className="btn ghost" onClick={() => void unsubscribeAll(s.sub, s.email)}>Unsubscribe all</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <label>Manually suppress an address (does not delete)</label>
        <div className="row">
          <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn" onClick={() => void suppress()} disabled={!email}>Suppress</button>
        </div>
      </div>

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>Suppression list</div>
        {supps.loading && <p className="muted">Loading…</p>}
        {supps.error && <p className="err">{supps.error}</p>}
        {supps.data && supps.data.length === 0 && <p className="muted">No suppressed addresses.</p>}
        {supps.data && supps.data.length > 0 && (
          <table>
            <thead><tr><th>Email</th><th>Source</th><th>Scope</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {supps.data.map((s) => (
                <tr key={`${s.email}:${s.scope}`}>
                  <td className="t-strong">{s.email}</td>
                  <td>{s.source}</td>
                  <td>{s.scope}</td>
                  <td className="muted">{new Date(s.addedAt).toLocaleString()}</td>
                  <td>
                    {s.scope === "org"
                      ? <button className="btn ghost" onClick={() => void lift(s.email)}>Lift</button>
                      : <span className="muted">global</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Segments({ org }: { org: string }) {
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


/**
 * On-the-fly CSV field mapper (#216) — the Constant Contact / Mailchimp flow.
 *
 * Uploaded files never have the columns we want. Every source column resolves to
 * exactly one of: the email address, an attribute, an audience, one of the three
 * Pinpoint row-level safety signals, or an explicit discard. Nothing is dropped
 * silently.
 */
function ImportMapper({ org }: { org: string }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [basis, setBasis] = useState<"explicit" | "implicit">("implicit");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [plan, setPlan] = useState<MappingPlan | null>(null);
  const [report, setReport] = useState<MappedImportReport | null>(null);
  const [mappingName, setMappingName] = useState("");
  const [defaults, setDefaults] = useState<NewListDefaults>({ fromAddress: "", complianceFooter: "", physicalAddress: "" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const readFile = (f: File) => {
    setFileName(f.name);
    const r = new FileReader();
    r.onload = () => setCsv(String(r.result ?? ""));
    r.readAsText(f);
  };

  const doPreview = async () => {
    setBusy(true); setMsg(""); setReport(null);
    try {
      const p = await api.importPreview(org, csv, basis);
      setPreview(p);
      setPlan(p.suggested);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const setColumn = (header: string, m: ColumnMapping) =>
    setPlan((p) => (p ? { columns: { ...p.columns, [header]: m } } : p));

  /** Any column the plan asks us to create a list for needs compliance fields. */
  const createsList = !!plan && Object.values(plan.columns).some(
    (m) => m.kind === "audience" && "createNamed" in m.list,
  );

  const run = async (dryRun: boolean) => {
    if (!plan) return;
    setBusy(true); setMsg("");
    try {
      const r = await api.importMapped(org, {
        csv, plan, sourceFile: fileName || undefined, dryRun,
        ...(createsList ? { newListDefaults: defaults } : {}),
      });
      setReport(r);
      setMsg(dryRun ? "Dry run complete — nothing was written." : "Import complete.");
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  const OUTCOMES = ["email", "attribute", "audience", "discard"] as const;
  const kindOf = (m: ColumnMapping): string =>
    m.kind === "optOut" || m.kind === "endpointStatus" || m.kind === "channel" ? m.kind : m.kind;

  return (
    <div>
      <h2>Import subscribers</h2>
      <p className="muted">
        Map each column to a field, create a new one, or discard it. Discarded columns are counted
        in the report — nothing is dropped silently.
      </p>

      <div className="card">
        <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
        <label>
          Consent basis for audience columns
          <select value={basis} onChange={(e) => setBasis(e.target.value as "explicit" | "implicit")}>
            <option value="implicit">Implicit — an existing relationship</option>
            <option value="explicit">Explicit — the file carries double opt-in evidence</option>
          </select>
        </label>
        <div className="muted">
          Implicit can only ever create <strong>pending</strong> subscriptions; the subscriber still
          has to confirm.
        </div>
        <button className="btn" disabled={!csv || busy} onClick={doPreview}>Preview mapping</button>
      </div>

      {preview && plan && (
        <>
          <div className="muted" style={{ margin: "8px 0" }}>
            {preview.headers.length} columns, {preview.rowCount} rows.
          </div>

          {preview.saved.length > 0 && (
            <div className="card">
              <strong>Saved mappings for this file shape</strong>
              <div className="muted">
                Matched on the header set, ignoring order — a reshuffled re-export still matches.
              </div>
              {preview.saved.map((m) => (
                <button key={m.mappingId} className="btn ghost" style={{ marginRight: 8 }} onClick={() => setPlan(m.plan)}>
                  Use “{m.name}”
                </button>
              ))}
            </div>
          )}

          {createsList && (
            <div className="card">
              <strong>New lists need compliance fields</strong>
              <div className="muted">
                A list with no physical address or footer is a CAN-SPAM violation, so these are
                required rather than defaulted.
              </div>
              <label>From address<input value={defaults.fromAddress} onChange={(e) => setDefaults({ ...defaults, fromAddress: e.target.value })} /></label>
              <label>Compliance footer<input value={defaults.complianceFooter} onChange={(e) => setDefaults({ ...defaults, complianceFooter: e.target.value })} /></label>
              <label>Physical address<input value={defaults.physicalAddress} onChange={(e) => setDefaults({ ...defaults, physicalAddress: e.target.value })} /></label>
            </div>
          )}

          <table className="table">
            <thead>
              <tr><th>Column</th><th>Sample</th><th>Maps to</th><th>Target</th></tr>
            </thead>
            <tbody>
              {preview.headers.map((h) => {
                const m = plan.columns[h]!;
                const sample = preview.sample.map((r) => r[h]).filter((v) => v && v.trim() !== "")[0] ?? "";
                return (
                  <tr key={h}>
                    <td><code>{h}</code></td>
                    <td className="muted">{sample.slice(0, 28)}</td>
                    <td>
                      <select
                        value={OUTCOMES.includes(kindOf(m) as never) ? kindOf(m) : "discard"}
                        onChange={(e) => {
                          const k = e.target.value;
                          if (k === "email") setColumn(h, { kind: "email" });
                          else if (k === "attribute") setColumn(h, { kind: "attribute", key: h.split(".").pop() ?? h });
                          else if (k === "audience")
                            setColumn(h, { kind: "audience", list: { createNamed: h.split(".").pop() ?? h }, consentBasis: basis });
                          else setColumn(h, { kind: "discard" });
                        }}
                      >
                        <option value="email">Email address</option>
                        <option value="attribute">Attribute</option>
                        <option value="audience">Audience</option>
                        <option value="discard">Discard</option>
                      </select>
                      {(m.kind === "optOut" || m.kind === "endpointStatus" || m.kind === "channel") && (
                        <div className="muted">detected: {m.kind} (safety signal)</div>
                      )}
                    </td>
                    <td>
                      {m.kind === "attribute" && (
                        <input value={m.key} onChange={(e) => setColumn(h, { kind: "attribute", key: e.target.value })} />
                      )}
                      {m.kind === "audience" && (
                        <select
                          value={"existingId" in m.list ? m.list.existingId : "__new__"}
                          onChange={(e) =>
                            setColumn(h, {
                              kind: "audience",
                              consentBasis: basis,
                              list: e.target.value === "__new__"
                                ? { createNamed: h.split(".").pop() ?? h }
                                : { existingId: e.target.value },
                            })
                          }
                        >
                          <option value="__new__">Create “{h.split(".").pop()}”</option>
                          {(lists.data ?? []).map((l) => (
                            <option key={l.listId} value={l.listId}>{l.name}</option>
                          ))}
                        </select>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="card">
            <label>
              Save this mapping as
              <input value={mappingName} onChange={(e) => setMappingName(e.target.value)} placeholder="Monthly Pinpoint export" />
            </label>
            <button
              className="btn ghost"
              disabled={busy || !mappingName.trim()}
              onClick={async () => {
                try {
                  await api.saveMapping(org, mappingName, preview.fingerprint, plan);
                  setMsg(`Saved “${mappingName}” — it will be offered next time this file shape appears.`);
                } catch (e) { setMsg((e as Error).message); }
              }}
            >
              Save mapping
            </button>
          </div>

          <button className="btn ghost" disabled={busy} onClick={() => run(true)}>Dry run</button>
          <button className="btn" disabled={busy} onClick={() => run(false)} style={{ marginLeft: 8 }}>
            Import
          </button>
        </>
      )}

      {msg && <div style={{ marginTop: 12 }}>{msg}</div>}

      {report && (
        <div className="card" style={{ marginTop: 12 }}>
          <div>Created {report.created} · updated {report.updated} · duplicates {report.duplicates}</div>
          <div>Subscriptions {report.subscriptionsCreated} · declines recorded {report.declinesRecorded}</div>
          <div>
            Not mailable {report.nonMailable} <span className="muted">(opted out or inactive — kept as records)</span>
          </div>
          <div>Suppressed, skipped {report.suppressed} · discarded cells {report.discardedCells}</div>
          {report.listsCreated.length > 0 && <div>Lists created: {report.listsCreated.join(", ")}</div>}
          {report.errors.length > 0 && (
            <details>
              <summary>{report.errors.length} row error(s)</summary>
              <ul>{report.errors.slice(0, 50).map((e, i) => <li key={i}>{e}</li>)}</ul>
            </details>
          )}
          {report.batchId && <div className="muted">Batch <code>{report.batchId}</code></div>}
        </div>
      )}

      <ImportHistory org={org} refresh={report?.batchId ?? ""} />
    </div>
  );
}

/**
 * Import history (#223).
 *
 * Every run was already stamped on the subscriptions it wrote, but there was no
 * way to ask what a given run had done — which is the only question anyone asks
 * about an import, and always after discovering the file was wrong. Rows load on
 * demand: a batch can hold hundreds of thousands, and nobody wants all of them
 * just to see that the run existed.
 */
function ImportHistory({ org, refresh }: { org: string; refresh: string }) {
  const batches = useAsync(() => api.importBatches(org), [org, refresh]);
  const [openId, setOpenId] = useState("");
  const detail = useAsync(
    () => (openId ? api.importBatch(org, openId) : Promise.resolve(null)),
    [org, openId],
  );

  if (batches.loading) return <div className="muted">Loading import history…</div>;
  if (batches.error) return <div className="error">{batches.error}</div>;
  const rows = batches.data ?? [];
  if (rows.length === 0) {
    return <div className="muted" style={{ marginTop: 16 }}>No imports recorded yet.</div>;
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Import history</h3>
      <table className="table">
        <thead>
          <tr><th>Started</th><th>File</th><th>Basis</th><th>Created</th><th>Updated</th><th>Memberships</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.batchId}>
              <td>{new Date(b.startedAt).toLocaleString()}</td>
              <td>{b.sourceFile ?? <span className="muted">—</span>}</td>
              {/* Blank means the file mixed bases, not that consent is unknown. */}
              <td>{b.consentBasis ?? <span className="muted">mixed</span>}</td>
              <td>{b.created}</td>
              <td>{b.updated}</td>
              <td>{b.rowCount}</td>
              <td>
                <button className="btn ghost" onClick={() => setOpenId(openId === b.batchId ? "" : b.batchId)}>
                  {openId === b.batchId ? "Hide rows" : "Show rows"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {openId && (
        <div className="card">
          {detail.loading && <div className="muted">Loading rows…</div>}
          {detail.error && <div className="error">{detail.error}</div>}
          {detail.data && (
            <>
              <strong>{detail.data.rows.length} membership(s) written by this run</strong>
              <table className="table">
                <thead><tr><th>Subscriber</th><th>List</th></tr></thead>
                <tbody>
                  {detail.data.rows.slice(0, 200).map((r) => (
                    <tr key={`${r.subscriberId}#${r.listId}`}>
                      <td><code>{r.subscriberId}</code></td>
                      <td><code>{r.listId}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.data.rows.length > 200 && (
                <div className="muted">Showing the first 200 of {detail.data.rows.length}.</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ImportSubscribers({ org }: { org: string }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const [listId, setListId] = useState("");
  const [csv, setCsv] = useState("");
  const [status, setStatus] = useState<"pending" | "confirmed">("pending");
  const [report, setReport] = useState<{ imported: number; skipped: number; suppressed: number; dryRun: boolean } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (lists.data && lists.data.length > 0 && !listId) setListId(lists.data[0]!.listId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists.data]);

  const run = async (dryRun: boolean) => {
    setMsg(""); setReport(null); setBusy(true);
    try {
      setReport(await api.importCsv(org, listId, csv, dryRun, status));
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };
  const valid = !!listId && csv.trim() !== "";

  return (
    <div>
      <h1 className="h1">Import subscribers · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Paste CSV to bulk-add subscribers to a list. Run a dry run first to preview counts.
      </p>
      {lists.data && lists.data.length === 0 && (
        <div className="card muted">No newsletters yet — create a list first.</div>
      )}
      <div className="card">
        <label>List</label>
        <select value={listId} onChange={(e) => setListId(e.target.value)} style={{ width: "100%" }}>
          {(lists.data ?? []).map((l) => (
            <option key={l.listId} value={l.listId}>{l.name} ({l.listId})</option>
          ))}
        </select>
        <label style={{ marginTop: 12 }}>Initial status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value as "pending" | "confirmed")} style={{ width: "100%" }}>
          <option value="pending">pending</option>
          <option value="confirmed">confirmed</option>
        </select>
        <label style={{ marginTop: 12 }}>CSV</label>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={10}
          placeholder={"email,first_name\nreader@example.com,Alex"}
          style={{ width: "100%", fontFamily: "monospace" }} disabled={busy} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
          <button className="btn ghost" disabled={!valid || busy} onClick={() => void run(true)}>Dry run</button>
          <button className="btn" disabled={!valid || busy} onClick={() => void run(false)}>{busy ? "Working…" : "Import"}</button>
          {msg && <span className="err">{msg}</span>}
        </div>
      </div>
      {report && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>{report.dryRun ? "Dry run — no changes applied" : "Import complete"}</div>
          <div className="kpis">
            <Kpi n={report.imported} l="imported" />
            <Kpi n={report.skipped} l="skipped" />
            <Kpi n={report.suppressed} l="suppressed" />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Bulk export (#224) — the "you can leave" half of the promise.
 *
 * Distinct from the per-subject DSAR below: this is the whole org, in the shape
 * the import mapper can read back, so leaving is a round trip rather than a
 * download nobody can use.
 */
function BulkExport({ org }: { org: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [includeUnsubscribed, setIncludeUnsubscribed] = useState(true);

  const download = async (format: "csv" | "jsonl") => {
    setBusy(true);
    setMsg("");
    try {
      const link = await api.exportData(org, format, includeUnsubscribed);
      // The file is already in S3; this URL is pre-authorized, so a plain
      // navigation works and the bytes never pass through the browser's memory
      // the way a blob would.
      const a = document.createElement("a");
      a.href = link.url;
      a.download = `addressium-${org}-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      const kb = Math.max(1, Math.round(link.bytes / 1024));
      setMsg(
        `Exported ${kb.toLocaleString()} KB. The download link expires at ` +
          `${new Date(link.expiresAt).toLocaleTimeString()} — it grants the whole file to anyone ` +
          `holding it, so don't paste it anywhere.`,
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Export everything</h3>
      <p className="muted">
        Subscribers, subscriptions, suppression state and consent provenance. The CSV imports back
        through the field mapper, so this is a way out, not just a file.
      </p>
      <label>
        <input
          type="checkbox"
          checked={includeUnsubscribed}
          onChange={(e) => setIncludeUnsubscribed(e.target.checked)}
        />{" "}
        Include unsubscribed rows
        <div className="muted">
          Leave on when migrating: an opt-out you fail to carry across is one you will mail again.
        </div>
      </label>
      <div style={{ marginTop: 8 }}>
        <button className="btn" disabled={busy} onClick={() => download("csv")}>Export CSV</button>
        <button className="btn ghost" disabled={busy} style={{ marginLeft: 8 }} onClick={() => download("jsonl")}>
          Export JSONL
        </button>
        {msg && <span style={{ marginLeft: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}

function Privacy({ org }: { org: string }) {
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ found?: boolean; data?: unknown; erased?: boolean } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (action: "export" | "erase") => {
    setMsg(""); setResult(null); setBusy(true);
    try { setResult(await api.privacy(org, action, email.trim())); }
    catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h1 className="h1">Data requests · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        Handle DSAR export and erasure requests. Erase requires the <code>subscribers:delete</code> role and will 403 otherwise.
      </p>
      <div className="card">
        <label>Subject email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" style={{ width: "100%" }} disabled={busy} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
          <button className="btn" disabled={!email.trim() || busy} onClick={() => void run("export")}>Export</button>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I understand this is irreversible
        </label>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
          <button className="btn" disabled={!email.trim() || !confirm || busy} onClick={() => void run("erase")}>Erase</button>
          {msg && <span className="err">{msg}</span>}
        </div>
      </div>
      {result && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>Result</div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

interface DraftStep { stepId: string; waitSeconds: string; listId: string; templateId: string; subject: string }

function Drips({ org }: { org: string }) {
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





/**
 * Add organization (#226) — the last piece of "invite the rest of the team
 * through the console" that had no surface.
 *
 * Provisioning is not reversible in one click: it creates a KMS key, an SES
 * identity and a configuration set. So this screen states what will be created
 * before it creates it, and surfaces the DNS records afterwards — a new org that
 * cannot send because nobody saw the DKIM records is the common failure.
 */
function AddOrganization() {
  const [form, setForm] = useState<CreateOrgInput>({
    name: "",
    primaryDomain: "",
    siteDomain: "",
    defaultTimezone: "UTC",
    magicLinks: false,
    environment: "prod",
  });
  const [poolId, setPoolId] = useState("");
  const [result, setResult] = useState<CreateOrgResult | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<CreateOrgInput>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    setBusy(true); setMsg(""); setResult(null);
    try {
      const body: CreateOrgInput = {
        ...form,
        ...(form.magicLinks && poolId.trim() ? { subscriberPool: { poolId: poolId.trim() } } : {}),
      };
      setResult(await api.createOrg(body));
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <h2>Add organization</h2>
      <p className="muted">
        Creates a silo: its own SES identity and configuration set, and — with magic links on — a
        per-org KMS signing key. Provisioning is idempotent on the derived org id.
      </p>

      <div className="card">
        <label>Name<input value={form.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label>
          Sending domain
          <input value={form.primaryDomain} onChange={(e) => set({ primaryDomain: e.target.value })} placeholder="mail.example.com" />
          <div className="muted">SES verifies this; you publish the DKIM records shown after.</div>
        </label>
        <label>
          Site domain
          <input value={form.siteDomain} onChange={(e) => set({ siteDomain: e.target.value })} placeholder="www.example.com" />
        </label>
        <label>
          Time zone
          <input value={form.defaultTimezone ?? ""} onChange={(e) => set({ defaultTimezone: e.target.value })} />
          <div className="muted">Interprets recurring wall-clock send schedules, DST-aware.</div>
        </label>
        <label>
          Environment
          <select value={form.environment} onChange={(e) => set({ environment: e.target.value as "prod" | "dev" })}>
            <option value="prod">prod</option>
            <option value="dev">dev — fail-closed to an allowlist</option>
          </select>
        </label>
      </div>

      <div className="card">
        <label>
          <input type="checkbox" checked={form.magicLinks} onChange={(e) => set({ magicLinks: e.target.checked })} />{" "}
          Magic-link tokens
        </label>
        <div className="muted">
          Off means addressium just sends email — no user pool, no signing key, no entitlement
          plumbing. On requires an existing Cognito pool: the token carries that pool&rsquo;s
          <code>sub</code> so a paywall can resolve the reader client-side.
        </div>
        {form.magicLinks && (
          <label>
            Existing subscriber pool id
            <input value={poolId} onChange={(e) => setPoolId(e.target.value)} placeholder="us-east-1_abc123" />
            <div className="muted">
              addressium links to your pool and never creates one — a pool carries far more
              configuration than this application should own.
            </div>
          </label>
        )}
      </div>

      <button className="btn" disabled={busy || !form.name || !form.primaryDomain} onClick={submit}>
        {busy ? "Provisioning…" : "Create organization"}
      </button>
      {msg && <div className="error" style={{ marginTop: 8 }}>{msg}</div>}

      {result && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>{result.alreadyExisted ? "Already existed" : "Created"}: {result.orgId}</strong>
          <div className="muted">
            {result.setupComplete
              ? "SES identity verified."
              : "Publish these DNS records — the org cannot send until SES verifies the domain."}
          </div>
          <table className="table">
            <thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead>
            <tbody>
              {result.dns.map((r, i) => (
                <tr key={i}><td>{r.type}</td><td><code>{r.name}</code></td><td><code>{r.value}</code></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * System health (#229, compendium #29) — ONE derived verdict.
 *
 * Deliberately not a list of alarm names. A marketer reading
 * `SendDlqNotEmptyAlarm` in a campaign tool learns nothing they can act on, and
 * the detail belongs on the CloudWatch dashboard where the runbook lives. The
 * composition happens server-side so the SPA holds no CloudWatch permission.
 */
function HealthBadge({ org }: { org: string }) {
  const h = useAsync(() => api.health(org), [org]);
  if (h.loading || h.error || !h.data) return null;

  const { status, alarmsInAlarm, reason } = h.data;
  // "unknown" is kept distinct from "degraded": a health check that cannot run
  // is not evidence that the system is unhealthy, and conflating them sends
  // someone to debug the mail pipeline over a missing IAM permission.
  const style: Record<string, { label: string; color: string; note: string }> = {
    ok: { label: "System OK", color: "#15803d", note: "No alarms firing." },
    degraded: {
      label: "Degraded",
      color: "#b45309",
      note: `${alarmsInAlarm} alarm${alarmsInAlarm === 1 ? "" : "s"} firing — see the CloudWatch dashboard.`,
    },
    unknown: { label: "Health unknown", color: "#6b7280", note: reason ?? "Could not read alarm state." },
  };
  const s = style[status] ?? style["unknown"]!;

  return (
    <div className="card" style={{ borderColor: s.color }}>
      <strong style={{ color: s.color }}>{s.label}</strong>
      <div className="muted">{s.note}</div>
    </div>
  );
}

const ROLE_HELP: Record<string, string> = {
  developer_admin: "Everything, including managing this team",
  editor: "Create and send campaigns, manage templates, segments and subscribers",
  analyst: "Read reports only",
  support: "Read reports and manage individual subscribers",
};

/**
 * Newsletters — create a list, open or close it (#130/#131).
 *
 * `api.saveList` and `api.setVisibility` existed and were called by NOTHING, so
 * there was no way to create a newsletter from the console at all. For a product
 * whose entire subject is newsletters, that is not a missing convenience — the
 * console could show you a count of lists and give you no way to add one.
 *
 * The compliance fields are required rather than defaulted. A list with no
 * physical address or footer is a CAN-SPAM violation on every message it ever
 * sends, and inventing a plausible-looking default is how that ships silently.
 */
function Newsletters({ org }: { org: string }) {
  const lists = useAsync(() => api.lists(org), [org]);
  const [refresh, setRefresh] = useState(0);
  const rows = useAsync(() => api.lists(org), [org, refresh]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({
    listId: "",
    name: "",
    description: "",
    fromAddress: "",
    complianceFooter: "",
    physicalAddress: "",
    optInPolicy: "double" as "single" | "double",
    access: "free" as "free" | "paid",
    visibility: "open" as "open" | "closed",
  });

  const listIdProblem = idProblem(form.listId.trim());
  const ready =
    form.listId.trim() && !listIdProblem && form.name.trim() && form.fromAddress.trim() &&
    form.complianceFooter.trim() && form.physicalAddress.trim();

  const create = async () => {
    setBusy(true); setMsg("");
    try {
      await api.saveList({
        orgId: org,
        ...form,
        listId: form.listId.trim(),
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
      });
      setMsg(`Created “${form.name}”.`);
      setForm({ ...form, listId: "", name: "", description: "" });
      setRefresh((n) => n + 1);
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };

  const toggle = async (listId: string, current: "open" | "closed" | undefined) => {
    setMsg("");
    try {
      await api.setVisibility(org, listId, current === "closed" ? "open" : "closed");
      setRefresh((n) => n + 1);
    } catch (e) { setMsg(String(e)); }
  };

  const field = (key: keyof typeof form, label: string, placeholder = "") => (
    <label style={{ display: "block", marginBottom: 8 }}>
      <span style={{ display: "block", fontSize: 13 }}>{label}</span>
      <input
        value={String(form[key])}
        placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        style={{ width: "100%" }}
      />
    </label>
  );

  return (
    <div>
      <h1 className="h1">Newsletters</h1>
      <p className="muted">
        A <strong>closed</strong> newsletter keeps its subscribers and stops accepting new ones —
        it also disappears from the public directory.
      </p>

      <div className="card">
        <strong>Create a newsletter</strong>
        {field("listId", "List id", "ledger — used in URLs, cannot change later")}
        {/* The server rejects anything outside the id charset with a 400 (#196),
            and this value is permanent — so say so before the operator commits,
            and offer the slug of the name they already typed. */}
        {listIdProblem && <p className="err" style={{ margin: "-4px 0 8px" }}>List id {listIdProblem}</p>}
        {!form.listId.trim() && suggestId(form.name) && (
          <p className="muted" style={{ margin: "-4px 0 8px" }}>
            Suggested:{" "}
            <button
              className="btn ghost"
              style={{ padding: "0 6px" }}
              onClick={() => setForm({ ...form, listId: suggestId(form.name) })}
            >
              <code>{suggestId(form.name)}</code>
            </button>
          </p>
        )}
        {field("name", "Name", "The Ledger")}
        {field("description", "Description (optional)", "Daily business briefing")}
        {field("fromAddress", "From address", "ledger@yourdomain.example")}
        {field("complianceFooter", "Compliance footer", "You subscribed at yourdomain.example")}
        {field("physicalAddress", "Physical mailing address", "1 Main St, Springfield")}
        <div className="muted" style={{ marginBottom: 8 }}>
          The footer and physical address are CAN-SPAM requirements on every message this list
          sends, so they are required here rather than defaulted.
        </div>
        <div className="row">
          <label>
            Opt-in
            <select
              value={form.optInPolicy}
              onChange={(e) => setForm({ ...form, optInPolicy: e.target.value as "single" | "double" })}
            >
              <option value="double">Double — confirm by email</option>
              <option value="single">Single</option>
            </select>
          </label>
          <label>
            Access
            <select
              value={form.access}
              onChange={(e) => setForm({ ...form, access: e.target.value as "free" | "paid" })}
            >
              <option value="free">Free</option>
              <option value="paid">Paid</option>
            </select>
          </label>
        </div>
        <button className="btn" disabled={!ready || busy} onClick={() => void create()}>
          {busy ? "Creating…" : "Create newsletter"}
        </button>
        {msg && <div style={{ marginTop: 8 }}>{msg}</div>}
      </div>

      {rows.loading && <div className="muted">Loading…</div>}
      {rows.error && <div className="error">{rows.error}</div>}
      {rows.data && rows.data.length === 0 && (
        <div className="muted">No newsletters yet — create the first one above.</div>
      )}
      {rows.data && rows.data.length > 0 && (
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Id</th><th>From</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {rows.data.map((l) => (
              <tr key={l.listId}>
                <td>{l.name}</td>
                <td><code>{l.listId}</code></td>
                <td className="muted">{l.fromAddress ?? "—"}</td>
                <td>{l.visibility === "closed" ? "Closed" : "Open"}</td>
                <td>
                  <button className="btn ghost" onClick={() => void toggle(l.listId, l.visibility)}>
                    {l.visibility === "closed" ? "Reopen" : "Close"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {lists.error && <div className="error">{lists.error}</div>}
    </div>
  );
}

/**
 * Audit log viewer (#191).
 *
 * The WORM bucket was provisioned, then the writes were wired — and the only way
 * to read an entry was still an AWS console login, which is precisely the
 * dependency §4.19 exists to remove. "Who exported subscriber data on the 14th?"
 * is the question the bucket was built to answer.
 *
 * Gated on `team:manage` like Team & access: the log names members and their
 * actions, so it is the same administrative surface, not a report.
 */
function AuditLogView({ org }: { org: string }) {
  // "GLOBAL" is a scope, not an org. Org creation and pool linking belong to no
  // single org, so they would otherwise be invisible from every view.
  const [scope, setScope] = useState(org);
  const [limit, setLimit] = useState(100);
  const entries = useAsync(() => api.auditLog(scope, limit), [scope, limit]);

  return (
    <div>
      <h2>Audit log</h2>
      <p className="muted">
        Every privileged action, written once to an Object-Locked bucket. Entries cannot be
        edited or deleted — including by whoever wrote them.
      </p>
      <div className="card">
        <label>
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value={org}>{org}</option>
            <option value="GLOBAL">Cross-org (org creation, pool linking)</option>
          </select>
        </label>
        <label>
          Show
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            <option value={50}>50 most recent</option>
            <option value={100}>100 most recent</option>
            <option value={500}>500 most recent</option>
          </select>
        </label>
      </div>

      {entries.loading && <div className="muted">Reading the log…</div>}
      {entries.error && <div className="error">{entries.error}</div>}
      {entries.data?.length === 0 && (
        <div className="muted">
          Nothing recorded in this scope in the last 90 days.
        </div>
      )}
      {entries.data && entries.data.length > 0 && (
        <table className="table">
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr>
          </thead>
          <tbody>
            {entries.data.map((e) => (
              <tr key={`${e.at}-${e.action}-${e.memberSub}`}>
                <td>{new Date(e.at).toLocaleString()}</td>
                <td><code>{e.memberSub}</code></td>
                <td>{e.action}</td>
                <td className="muted">{e.target ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Team & access (#226).
 *
 * Before this, the only member any deployment had was the deploy-time seed —
 * developer_admin scoped to every org — so the four-role matrix was enforced
 * server-side while exactly one role was reachable, and offboarding meant an
 * AWS console operation.
 */
function Team({ org }: { org: string }) {
  const loaded = useAsync(() => api.team(org), [org]);
  const [members, setMembers] = useState<TeamMemberRow[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [orgs, setOrgs] = useState(org);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (loaded.data) setMembers(loaded.data); }, [loaded.data]);

  const refresh = async () => setMembers(await api.team(org));
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg("");
    try { await fn(); await refresh(); }
    // The server's reason is the useful part — "this is the last enabled
    // developer admin" has to reach the operator, not become "request failed".
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  if (loaded.loading) return <div className="muted">Loading…</div>;
  if (loaded.error) return <div className="error">{loaded.error}</div>;

  return (
    <div>
      <h2>Team &amp; access</h2>
      <p className="muted">
        Members of this deployment&rsquo;s admin console. Roles are enforced server-side; the
        organizations listed here scope what each member can act on.
      </p>

      <div className="card">
        <h3>Invite a member</h3>
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.keys(ROLE_HELP).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <div className="muted">{ROLE_HELP[role]}</div>
        </label>
        <label>
          Organizations <span className="muted">(comma separated)</span>
          <input value={orgs} onChange={(e) => setOrgs(e.target.value)} />
          <div className="muted">
            <code>*</code> is reserved for the bootstrap administrator and cannot be granted here.
          </div>
        </label>
        <button
          className="btn"
          disabled={busy || !email}
          onClick={() => run(() => api.inviteMember(org, email, role, orgs.split(",").map((o) => o.trim()).filter(Boolean)))}
        >
          Send invite
        </button>
        <div className="muted">Cognito emails them a temporary password.</div>
      </div>

      {msg && <div className="error" style={{ margin: "8px 0" }}>{msg}</div>}

      <table className="table">
        <thead>
          <tr><th>Member</th><th>Role</th><th>Organizations</th><th>State</th><th /></tr>
        </thead>
        <tbody>
          {(members ?? []).map((m) => (
            <tr key={m.username} style={{ opacity: m.enabled ? 1 : 0.55 }}>
              <td>
                {m.email}
                {m.status && <div className="muted">{m.status}</div>}
              </td>
              <td>
                <select
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => run(() => api.setMemberAccess(org, m.username, e.target.value, m.orgs))}
                >
                  {Object.keys(ROLE_HELP).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <div className="muted">{m.capabilities.length} capabilities</div>
              </td>
              <td>
                {m.orgs.includes("*")
                  ? <span title="bootstrap administrator">all organizations</span>
                  : m.orgs.join(", ")}
              </td>
              <td>{m.enabled ? "active" : "disabled"}</td>
              <td>
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => run(() => api.setMemberEnabled(org, m.username, !m.enabled))}
                >
                  {m.enabled ? "Disable" : "Enable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const METRIC_LABEL: Record<string, string> = {
  complaint_rate: "Complaint rate",
  bounce_rate: "Bounce rate",
  send_failures: "Send failures (count)",
  reputation: "Reputation",
};

/**
 * Deliverability thresholds (#217) — the numbers that stop a campaign mid-flight.
 *
 * A missing config reads back as `null`, and that is rendered as UNPROTECTED
 * rather than as zeroed thresholds: zeros look like a deliberate setting, and an
 * org that silently has no halt is exactly what this issue was about.
 */
function Deliverability({ org }: { org: string }) {
  const loaded = useAsync(() => api.alertConfig(org), [org]);
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [topic, setTopic] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (loaded.data) {
      setRules(loaded.data.rules);
      setTopic(loaded.data.snsTopicArn ?? "");
    } else if (!loaded.loading && !loaded.error) {
      setRules([]);
    }
  }, [loaded.data, loaded.loading, loaded.error]);

  const update = (i: number, patch: Partial<AlertRule>) =>
    setRules((rs) => (rs ? rs.map((r, j) => (j === i ? { ...r, ...patch } : r)) : rs));

  const save = async () => {
    if (!rules) return;
    setSaving(true);
    setMsg("");
    try {
      // haltAt below warnAt is rejected server-side; catch it here too so the
      // operator is told which row is wrong rather than getting one message.
      const bad = rules.findIndex((r) => r.haltAt < r.warnAt);
      if (bad >= 0) throw new Error(`${METRIC_LABEL[rules[bad]!.metric]}: halt must not be below warn`);
      await api.saveAlertConfig({ orgId: org, snsTopicArn: topic.trim() || undefined, rules, notifyTargets: [] });
      setMsg("Saved.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loaded.loading) return <div className="muted">Loading…</div>;
  if (loaded.error) return <div className="error">{loaded.error}</div>;

  return (
    <div>
      <h2>Deliverability</h2>
      <p className="muted">
        When a campaign crosses a halt threshold it stops mid-flight. Rates are fractions of
        messages sent — 0.005 is 0.5%.
      </p>

      {!loaded.data && (
        <div className="card" style={{ borderColor: "#b45309" }}>
          <strong>This organization has no thresholds.</strong>
          <div className="muted">
            Nothing will stop a campaign that starts generating complaints. Set thresholds below.
          </div>
        </div>
      )}

      <div className="card">
        <label>
          Alert topic ARN <span className="muted">(optional)</span>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="arn:aws:sns:…" />
        </label>
        <div className="muted">
          Without a topic a breach still halts the campaign — you just are not notified.
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Warn at</th>
            <th>Halt at</th>
            <th>Enabled</th>
          </tr>
        </thead>
        <tbody>
          {(rules ?? []).map((r, i) => (
            <tr key={r.metric}>
              <td>
                {METRIC_LABEL[r.metric] ?? r.metric}
                {r.metric === "reputation" && (
                  <div className="muted">No live signal yet — leave disabled.</div>
                )}
              </td>
              <td>
                <input
                  type="number"
                  step="0.001"
                  value={r.warnAt}
                  onChange={(e) => update(i, { warnAt: Number(e.target.value) })}
                />
              </td>
              <td>
                <input
                  type="number"
                  step="0.001"
                  value={r.haltAt}
                  onChange={(e) => update(i, { haltAt: Number(e.target.value) })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button className="btn" onClick={save} disabled={saving || !rules}>
        {saving ? "Saving…" : "Save thresholds"}
      </button>
      {msg && <span style={{ marginLeft: 12 }}>{msg}</span>}
    </div>
  );
}

/**
 * Cost estimator (#213). Runs the SAME `estimateSendCost` model the README and
 * the domain tests use, so a number shown here cannot drift from a number
 * quoted elsewhere. Purely client-side — no API call, no stored state.
 *
 * Every line shows its arithmetic. An estimate you can't argue with is one
 * people either over-trust or ignore.
 */
function CostEstimator() {
  const [input, setInput] = useState<SendCostInput>({ ...DEFAULT_COST_INPUT, sendsPerYear: 52 });
  const est = useMemo(() => estimateSendCost(input), [input]);

  const num = (key: keyof SendCostInput, label: string, hint?: string, step = 1) => (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span style={{ display: "block", fontSize: 13 }}>{label}</span>
      <input
        type="number"
        min={0}
        step={step}
        value={String(input[key])}
        onChange={(e) => setInput({ ...input, [key]: Number(e.target.value) })}
        style={{ width: 140 }}
      />
      {hint && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{hint}</span>}
    </label>
  );

  const usd = (n: number) => `$${n.toFixed(2)}`;
  const preset = (label: string, sendsPerYear: number) => (
    <button
      type="button"
      onClick={() => setInput({ ...input, sendsPerYear })}
      style={{ marginRight: 8, fontWeight: input.sendsPerYear === sendsPerYear ? 700 : 400 }}
    >
      {label}
    </button>
  );

  return (
    <section>
      <h2>Cost estimator</h2>
      <p className="muted">
        Estimated AWS cost of sending, at <strong>us-east-1 on-demand list prices</strong> (captured
        2026-07). Excludes any WAF you attach yourself, data transfer, and the free tiers most
        accounts still have — so treat this as an upper bound.
      </p>

      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        <div>
          <h3>Inputs</h3>
          {num("subscribers", "Recipients per send", "", 1000)}
          <div style={{ marginBottom: 10 }}>
            <span style={{ display: "block", fontSize: 13 }}>Sends per year</span>
            {preset("Once", 1)}
            {preset("Weekly", 52)}
            {preset("Daily", 365)}
            <input
              type="number"
              min={0}
              value={String(input.sendsPerYear)}
              onChange={(e) => setInput({ ...input, sendsPerYear: Number(e.target.value) })}
              style={{ width: 90, marginLeft: 8 }}
            />
          </div>
          {num("openRate", "Open rate", "0.40 = 40%", 0.05)}
          {num("clickRate", "Click rate", "0.05 = 5%", 0.01)}
          {num("bounceRate", "Bounce + complaint rate", "0.02 = 2%", 0.005)}
          {num("orgs", "Organizations", "$1/mo KMS key each")}
          {num("alarms", "CloudWatch alarms")}
          {num("secrets", "Secrets Manager secrets")}
        </div>

        <div style={{ flex: 1, minWidth: 380 }}>
          <h3>Per send — {usd(est.perSendTotalUsd)}</h3>
          <p className="muted" style={{ fontSize: 12 }}>
            Generates <strong>{est.eventsPerSend.toLocaleString()}</strong> engagement events
            (one delivery per recipient, plus opens, clicks and bounces).
          </p>
          <table>
            <tbody>
              {est.perSend.map((l: CostLine) => (
                <tr key={l.label}>
                  <td>{l.label}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(l.usd)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{l.detail}</td>
                </tr>
              ))}
              <tr>
                <td><strong>Total per send</strong></td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  <strong>{usd(est.perSendTotalUsd)}</strong>
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {usd((est.perSendTotalUsd / Math.max(1, input.subscribers)) * 1000)} per 1,000
                </td>
              </tr>
            </tbody>
          </table>

          <h3 style={{ marginTop: 20 }}>Fixed — {usd(est.fixedMonthlyUsd)}/month</h3>
          <p className="muted" style={{ fontSize: 12 }}>Accrues whether or not you send anything.</p>
          <table>
            <tbody>
              {est.fixedMonthly.map((l: CostLine) => (
                <tr key={l.label}>
                  <td>{l.label}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(l.usd)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 20 }}>Annual — {usd(est.annualUsd)}</h3>
          <p className="muted" style={{ fontSize: 12 }}>
            {input.sendsPerYear.toLocaleString()} sends × {usd(est.perSendTotalUsd)} +{" "}
            {usd(est.fixedMonthlyUsd)}/mo × 12 + accrued event storage.
          </p>
        </div>
      </div>
    </section>
  );
}
