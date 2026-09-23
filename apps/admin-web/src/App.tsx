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
import { completeLoginIfPresent, decodeClaims, getTokens, isExpired, isLocalDevelopment, login, logout } from "./auth.js";
import { grantFromClaims, can, type Grant } from "./rbac.js";
import { api } from "./api.js";
import { Dashboard, HealthBadge } from "./screens/Dashboard.js";
import { Setup } from "./screens/Setup.js";
import { Newsletters } from "./screens/Newsletters.js";
import { Templates } from "./screens/Templates.js";
import { MergeTags } from "./screens/MergeTags.js";
import { Compose } from "./screens/Compose.js";
import { Campaigns } from "./screens/Campaigns.js";
import { Report } from "./screens/Report.js";
import { Analytics } from "./screens/Analytics.js";
import { Schedules } from "./screens/Schedules.js";
import { Usage } from "./screens/Usage.js";
import { CostEstimator } from "./screens/CostEstimator.js";
import { Subscribers } from "./screens/Subscribers.js";
import { Suppression } from "./screens/Suppression.js";
import { Feeds } from "./screens/Feeds.js";
import { AdTags } from "./screens/AdTags.js";
import { ApiWebhooks } from "./screens/ApiWebhooks.js";
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
import { Settings } from "./screens/Settings.js";
import { Identity } from "./screens/Identity.js";
import { Sidebar, type View } from "./Sidebar.js";
import { Topbar } from "./Topbar.js";

export function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  // Where the automatic redirect to the Hosted UI has got to. "idle" only ever
  // moves forward: resetting it on failure would re-satisfy the effect below
  // and retry forever instead of falling back to the card.
  const [redirect, setRedirect] = useState<"idle" | "going" | "failed">("idle");

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

  // Send an unauthenticated operator straight to the Hosted UI rather than
  // parking them on a card whose only control is "go to the Hosted UI".
  //
  // This runs in its own effect, AFTER `ready`, so it can never fire while
  // `completeLoginIfPresent` is still exchanging a `?code=` — doing that would
  // abandon a login that was about to succeed and bounce forever. Local
  // development keeps the button: `login()` there mints a fake token without
  // navigating, so an automatic call would sign the developer in with no way to
  // see the console's own landing page.
  useEffect(() => {
    if (!ready || authed || isLocalDevelopment || redirect !== "idle") return;
    setRedirect("going");
    void login().catch(() => {
      // The redirect never happened — Cognito unreachable, or the SPA was built
      // without VITE_COGNITO_DOMAIN. Fall back to the card so the operator gets
      // a control and an explanation instead of a permanently blank page.
      setRedirect("failed");
    });
  }, [ready, authed, redirect]);

  // One neutral shell covers every pre-authenticated state: the token check,
  // the code exchange, and the redirect to Cognito. No console chrome, no
  // screens, and nothing that can fire an API call renders until `authed` is
  // genuinely true — which is what the operator was seeing flash past.
  if (!ready || (!authed && !isLocalDevelopment && redirect !== "failed")) {
    return <div className="center muted">Signing in…</div>;
  }
  if (!authed) {
    return (
      <div className="center">
        <div className="card" style={{ textAlign: "center" }}>
          <div className="brand">addressium</div>
          <p className="muted">Operator console</p>
          <button className="btn" onClick={() => void login().then(() => setAuthed(true))}>
            {isLocalDevelopment ? "Enter local development console" : "Sign in with Cognito"}
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
        setOrg((cur) => (cur === "" ? (ids[0] ?? cur) : cur));
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
  // Set when a link elsewhere (a Schedules row) opens a specific report, and
  // cleared as soon as the view moves off "report" — otherwise reaching the
  // report later from the nav would silently reload whichever campaign was
  // linked to last, instead of the empty picker that entry point implies.
  const [reportCampaign, setReportCampaign] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (view !== "report" && reportCampaign !== undefined) setReportCampaign(undefined);
  }, [view, reportCampaign]);
  const [orgEnv, setOrgEnv] = useState<"prod" | "dev" | null>(null);
  // Name and sending domain for the sidebar identity block and the breadcrumb
  // (#260). Cleared alongside `orgEnv` on every switch so the shell never shows
  // the previous organization's identity against the new one's screens, and
  // left null on failure so it shows the org id rather than a stale name.
  const [orgName, setOrgName] = useState<string | null>(null);
  const [orgDomain, setOrgDomain] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  useEffect(() => {
    setOrgEnv(null);
    setOrgName(null);
    setOrgDomain(null);
    if (!org) return;
    let live = true;
    api
      .orgMeta(org)
      .then((m) => {
        if (!live) return;
        setOrgEnv(m.environment);
        setOrgName(m.name);
        setOrgDomain(m.primaryDomain ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [org]);

  return (
    <div className="app">
      <Sidebar
        org={org}
        orgs={orgs}
        setOrg={setOrg}
        orgName={orgName}
        orgDomain={orgDomain}
        orgEnv={orgEnv}
        view={view}
        setView={setView}
        grant={grant}
        role={claims["custom:role"] ?? "unknown role"}
        switcherOpen={switcherOpen}
        setSwitcherOpen={setSwitcherOpen}
        onSignOut={() => { logout(); location.reload(); }}
      />
      <main className="main">
        <Topbar orgName={orgName} org={org} view={view} orgEnv={orgEnv} claims={claims} onNavigate={setView} />
        <div className="view" key={view}>
        {view === "dashboard" && (<><HealthBadge org={org} /><Dashboard org={org} grant={grant} onGoToSetup={() => setView("setup")} onCompose={() => setView("compose")} onViewCampaigns={() => setView("campaigns")} /></>)}
        {view === "setup" && <Setup org={org} />}
        {view === "newsletters" && <Newsletters org={org} />}
        {view === "templates" && <Templates org={org} />}
        {view === "mergetags" && <MergeTags org={org} />}
        {view === "compose" && <Compose org={org} onScheduled={() => setView("schedules")} />}
        {view === "campaigns" && <Campaigns org={org} grant={grant} onCompose={() => setView("compose")} />}
        {view === "report" && <Report org={org} grant={grant} initialCampaign={reportCampaign} />}
        {view === "analytics" && <Analytics org={org} grant={grant} />}
        {view === "schedules" && (
          <Schedules
            org={org}
            grant={grant}
            onViewReport={(campaignId) => { setReportCampaign(campaignId); setView("report"); }}
          />
        )}
        {view === "usage" && <Usage org={org} />}
        {view === "costs" && <CostEstimator />}
        {view === "subscribers" && <Subscribers org={org} grant={grant} />}
        {view === "suppression" && <Suppression org={org} />}
        {view === "feeds" && <Feeds org={org} />}
        {view === "adtags" && <AdTags org={org} />}
        {view === "apiwebhooks" && <ApiWebhooks org={org} grant={grant} />}
        {view === "segments" && <Segments org={org} />}
        {view === "importmap" && <ImportMapper org={org} />}
        {view === "import" && <ImportSubscribers org={org} />}
        {view === "privacy" && (<><BulkExport org={org} /><Privacy org={org} /></>)}
        {view === "drips" && <Drips org={org} grant={grant} />}
        {view === "branding" && <BrandingEditor org={org} />}
        {view === "presentation" && <PresentationEditor org={org} />}
        {view === "team" && <Team org={org} />}
        {view === "audit" && <AuditLogView org={org} />}
        {view === "addorg" && <AddOrganization />}
        {view === "deliverability" && <Deliverability org={org} />}
        {view === "settings" && <Settings org={org} grant={grant} />}
        {view === "identity" && <Identity org={org} />}
        </div>
      </main>
    </div>
  );
}
