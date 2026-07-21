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
import { api, type Branding, type CampaignReport, type ListPresentation, type SetupState, type UsageRecord } from "./api.js";

type View = "dashboard" | "setup" | "report" | "usage" | "branding" | "presentation" | "subscribers" | "settings";

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
          <NavItem id="report" label="Campaign report" cap="reports:view" />
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
        {view === "report" && <Report org={org} grant={grant} />}
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
