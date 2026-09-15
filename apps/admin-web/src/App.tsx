/**
 * addressium admin console (#4) — the shell only: Cognito Hosted-UI login, the
 * org switcher, the capability-filtered nav, and the view switch.
 *
 * Every screen lives in its own module under `src/screens/`. Server-side RBAC is
 * the boundary; the console mirrors capabilities only to hide/disable controls.
 * Shared pieces that more than one screen needs live beside this file:
 * `useAsync.ts`, `Kpi.tsx`, `time.ts`, plus `api.ts`, `auth.ts`, `rbac.ts` and
 * `ids.ts`.
 *
 * Adding a screen means adding a module and two lines here — an import and a
 * case in the switch — so screens can be built in parallel without contending
 * over one file.
 */
import { useEffect, useMemo, useState } from "react";
import { completeLoginIfPresent, decodeClaims, getTokens, isExpired, login, logout } from "./auth.js";
import { grantFromClaims, can, type Grant } from "./rbac.js";
import { api } from "./api.js";
import { Dashboard, HealthBadge } from "./screens/Dashboard.js";
import { Setup } from "./screens/Setup.js";
import { Newsletters } from "./screens/Newsletters.js";
import { Templates } from "./screens/Templates.js";
import { Compose } from "./screens/Compose.js";
import { Report } from "./screens/Report.js";
import { Schedules } from "./screens/Schedules.js";
import { Usage } from "./screens/Usage.js";
import { CostEstimator } from "./screens/CostEstimator.js";
import { Subscribers } from "./screens/Subscribers.js";
import { Segments } from "./screens/Segments.js";
import { ImportMapper } from "./screens/ImportMapper.js";
import { ImportSubscribers } from "./screens/ImportSubscribers.js";
import { BulkExport, Privacy } from "./screens/Privacy.js";
import { Drips } from "./screens/Drips.js";
import { BrandingEditor } from "./screens/BrandingEditor.js";
import { PresentationEditor } from "./screens/PresentationEditor.js";
import { Team } from "./screens/Team.js";
import { AuditLogView } from "./screens/AuditLogView.js";
import { AddOrganization } from "./screens/AddOrganization.js";
import { Deliverability } from "./screens/Deliverability.js";

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
  // Seeded from the claim so the switcher is populated on first paint, then
  // replaced by GET /orgs. The claim alone is not enough: "*" means "every org",
  // which it cannot enumerate — so a developer_admin, the one person entitled to
  // see every organization, fell through to a free-text box and had to type an
  // org id from memory to make the console do anything at all.
  const claimOrgs = useMemo(() => {
    const raw = (claims["custom:orgs"] ?? "").trim();
    return raw === "*" ? [] : raw.split(",").map((o) => o.trim()).filter(Boolean);
  }, [claims]);
  const [orgs, setOrgs] = useState<string[]>(claimOrgs);
  useEffect(() => {
    let cancelled = false;
    void api
      .listOrgs()
      .then((r) => {
        if (cancelled) return;
        const ids = r.orgs.map((o) => o.orgId);
        setOrgs(ids);
        // useState(orgs[0]) only ran at mount, when the list was still empty, so
        // without this the picker SHOWS the first org while `org` is still ""
        // — every request then goes to /orgs//lists and 404s, and the header
        // reads "Dashboard · —" next to a populated dropdown.
        setOrg((cur) => (cur === "" && ids.length > 0 ? ids[0] : cur));
      })
      // A failure here leaves whatever the claim gave us. The switcher degrades
      // to the old behaviour rather than emptying itself under the user.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
        {view === "subscribers" && <Subscribers org={org} grant={grant} />}
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
