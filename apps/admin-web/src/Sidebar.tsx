/**
 * The console sidebar (#260) — org identity block, grouped nav, sign-out.
 *
 * Lives beside App.tsx rather than under `screens/` because it is shell, not a
 * screen: the same rule that puts `useAsync.ts`, `Kpi.tsx` and `time.ts` here.
 *
 * The nav is a capability-filtered list of the 22 views the console actually
 * has, grouped five ways to match the design. It is NOT the prototype's list:
 * `demo/index.html` advertises screens this build has no code for (API &
 * outbound webhooks), and a nav row that
 * leads nowhere is worse than an absent one. Every entry below resolves to a
 * real `View` in App.tsx's switch.
 */
import { can, type Capability, type Grant } from "./rbac.js";

/** The shell's own view union, re-exported by App.tsx as `View`. */
export type View =
  | "dashboard" | "setup" | "templates" | "mergetags" | "compose" | "campaigns" | "report" | "usage"
  | "schedules" | "branding" | "presentation" | "subscribers" | "segments" | "import"
  | "privacy" | "suppression" | "feeds" | "adtags" | "apiwebhooks" | "drips" | "costs" | "deliverability" | "importmap" | "team" | "audit"
  | "newsletters" | "addorg" | "analytics" | "settings" | "identity";

interface NavEntry {
  id: View;
  label: string;
  /** Glyph only — decorative, hidden from assistive tech (the label carries it). */
  icon: string;
  cap?: Capability;
}

/**
 * The five groups, in the design's order. A screen with no design counterpart
 * still gets a home: Cost estimator and Presentation sit with the neighbours
 * they are read alongside, Data requests answers the design's "Data & exports".
 */
// `satisfies`, not a type annotation: an annotation widens every `id` to `View`,
// which makes the completeness guard below compare `View` against itself and
// silently pass. `satisfies` type-checks each entry AND keeps the literal ids.
const GROUPS = [
  {
    label: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", icon: "▤" },
      { id: "analytics", label: "Analytics", icon: "◔", cap: "reports:view" },
      { id: "setup", label: "Setup", icon: "◇" },
    ],
  },
  {
    label: "Audience",
    items: [
      { id: "newsletters", label: "Newsletters", icon: "✉", cap: "newsletters:close" },
      { id: "subscribers", label: "Subscribers", icon: "◎", cap: "subscribers:manage" },
      { id: "segments", label: "Segments", icon: "⧉", cap: "segments:manage" },
      { id: "suppression", label: "Suppression", icon: "⊘", cap: "suppression:manage" },
      { id: "importmap", label: "Import (mapper)", icon: "⇥", cap: "subscribers:manage" },
      { id: "import", label: "Import (simple)", icon: "⇥", cap: "subscribers:manage" },
    ],
  },
  {
    label: "Messaging",
    items: [
      { id: "compose", label: "Compose & schedule", icon: "➤", cap: "campaigns:schedule" },
      // `reports:view`, not `campaigns:schedule`: the list is a READ of
      // `GET /orgs/{org}/campaigns` (which the route gates on `reports:view`),
      // and an analyst who may read every report must be able to see what
      // exists to report on. Its lifecycle buttons gate separately inside.
      { id: "campaigns", label: "Campaigns", icon: "≡", cap: "reports:view" },
      { id: "schedules", label: "Schedules", icon: "◷", cap: "campaigns:schedule" },
      { id: "templates", label: "Templates", icon: "▦", cap: "campaigns:manage" },
      { id: "drips", label: "Automations", icon: "⟳", cap: "campaigns:manage" },
      { id: "report", label: "Campaign report", icon: "◔", cap: "reports:view" },
      { id: "deliverability", label: "Deliverability", icon: "⚠", cap: "alerts:manage" },
    ],
  },
  {
    label: "Developer",
    items: [
      { id: "feeds", label: "Feeds", icon: "⌁", cap: "campaigns:manage" },
      { id: "mergetags", label: "Merge tags", icon: "❴❵", cap: "campaigns:manage" },
      { id: "adtags", label: "Ad tags", icon: "▱", cap: "campaigns:manage" },
      { id: "identity", label: "Identity & pools", icon: "⚿", cap: "identity:manage" },
      { id: "privacy", label: "Data & exports", icon: "⇅", cap: "subscribers:manage" },
      { id: "apiwebhooks", label: "API & webhooks", icon: "⚷" },
    ],
  },
  {
    label: "Configure",
    items: [
      { id: "addorg", label: "Organizations", icon: "◈", cap: "identity:manage" },
      { id: "team", label: "Roles & access", icon: "⚑", cap: "team:manage" },
      { id: "branding", label: "Branding", icon: "◐", cap: "branding:manage" },
      { id: "presentation", label: "Presentation", icon: "▱", cap: "branding:manage" },
      { id: "usage", label: "Usage & cost", icon: "◨", cap: "reports:view" },
      { id: "costs", label: "Cost estimator", icon: "⊞", cap: "reports:view" },
      { id: "audit", label: "Audit log", icon: "☷", cap: "team:manage" },
      // No `cap`: Settings gathers tabs spanning four capabilities and gates
      // each one itself, so there is no single capability that means "may open
      // Settings" — and every role has at least the read-only Domains and
      // Magic-link tabs.
      { id: "settings", label: "Settings", icon: "⚙" },
    ],
  },
] as const satisfies readonly { label: string; items: readonly NavEntry[] }[];

/** The exact set of views the nav offers, as a literal union. */
type NavId = (typeof GROUPS)[number]["items"][number]["id"];

/**
 * Compile-time guard: every member of `View` must have a nav row.
 *
 * Without it, a view added to the union with no `GROUPS` entry compiles, then
 * ships as a screen with no way to reach it and an EMPTY breadcrumb. This
 * errors instead — "Type 'View' does not satisfy the constraint 'NavId'".
 */
type _EveryViewHasANavRow = View extends NavId ? true : never;
const _NAV_IS_COMPLETE: _EveryViewHasANavRow = true;
void _NAV_IS_COMPLETE;

/**
 * The label shown in the breadcrumb for a view — one source of truth with the
 * nav, so a row and its breadcrumb can never disagree. Safe to build by
 * reduction because the guard above establishes the key set is complete.
 */
export const VIEW_LABELS: Record<View, string> = Object.fromEntries(
  GROUPS.flatMap((g) => g.items.map((i) => [i.id, i.label] as const)),
) as Record<View, string>;

export interface SidebarProps {
  org: string;
  orgs: string[];
  setOrg: (org: string) => void;
  orgName: string | null;
  orgDomain: string | null;
  orgEnv: "prod" | "dev" | null;
  view: View;
  setView: (v: View) => void;
  grant: Grant | null;
  role: string;
  /** Whether the org picker is expanded — held by App so nothing else resets it. */
  switcherOpen: boolean;
  setSwitcherOpen: (open: boolean) => void;
  onSignOut: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { org, orgs, setOrg, orgName, orgDomain, orgEnv, view, setView, grant, role } = props;

  // The subline is "<domain> · <env>" when the org record gives a domain, and
  // falls back to the org id — which is always real — rather than inventing a
  // domain from the name. Nothing is shown at all before the first org resolves.
  const sub = [orgDomain ?? (org || null), orgEnv].filter(Boolean).join(" · ");
  // With no org selected the picker is FORCED open. Collapsing it behind a
  // blank, unlabelled block would hide the only control that can select one —
  // which is precisely the state a developer_admin holding "*" lands in when
  // GET /orgs fails, and the state the free-text fallback below exists for.
  const pickerOpen = props.switcherOpen || !org;

  return (
    <aside className="sidebar">
      <div className="brand">addressium</div>

      <button
        className="orgblock"
        onClick={() => props.setSwitcherOpen(!props.switcherOpen)}
        aria-expanded={pickerOpen}
        title="Switch organization"
      >
        <span className="stamp" aria-hidden="true" />
        <span className="who">
          {/* The name comes from GET /orgs/{org}; until it lands the id is the
              only true thing we know, so it stands in for itself. With neither,
              the block still says what it is — never an empty bold line. */}
          <b>{orgName ?? (org || "Select organization")}</b>
          {sub && <small title={sub}>{sub}</small>}
        </span>
        <span className="chev" aria-hidden="true">
          ⇅
        </span>
      </button>

      {pickerOpen && (
        <div style={{ padding: "0 8px 10px" }}>
          {orgs.length > 0 ? (
            <select
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              aria-label="Organization"
              style={{ width: "100%" }}
            >
              {orgs.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            // Kept deliberately: a developer_admin holding "*" cannot enumerate
            // orgs from the claim, so if GET /orgs fails this free-text box is
            // the only way into the console at all.
            <input
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="org id"
              aria-label="Organization"
              style={{ width: "100%" }}
            />
          )}
        </div>
      )}

      <nav className="nav">
        {GROUPS.map((group) => {
          // Widened back to `NavEntry` for rendering: `as const` above makes
          // `cap` absent (not optional) on the entries that have none, which is
          // what the completeness guard needs but not what a `.cap` read wants.
          const items: readonly NavEntry[] = group.items;
          const visible = items.filter((i) => !i.cap || can(grant, i.cap, org));
          // A group whose every row is hidden by RBAC takes its header with it.
          if (visible.length === 0) return null;
          return (
            <div key={group.label}>
              <div className="navlab">{group.label}</div>
              {visible.map((item) => (
                <button
                  key={item.id}
                  className={view === item.id ? "active" : ""}
                  aria-current={view === item.id ? "page" : undefined}
                  onClick={() => setView(item.id)}
                >
                  <span className="ic" aria-hidden="true">
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              ))}
            </div>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />
      <div className="muted" style={{ padding: "12px 10px 0" }}>
        {role}
      </div>
      <button className="btn ghost" style={{ marginTop: 8 }} onClick={props.onSignOut}>
        Sign out
      </button>
    </aside>
  );
}
