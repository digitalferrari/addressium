/**
 * The console topbar (#260) — breadcrumb, search, environment pill, avatar.
 *
 * The shell exposes a real bounded resource search plus two honest stand-ins:
 *
 *  - **Search.** The endpoint searches named operator resources (newsletters,
 *    campaigns, series, templates and segments). Subscriber email search stays
 *    on the Subscribers screen behind its narrower capability.
 *  - **Region.** Nothing in the console knows the deployment's region: no
 *    `VITE_*` carries one and no response returns one. Parsing it out of the
 *    API hostname breaks the moment a custom domain is used. So the pill shows
 *    the environment alone — a wrong region is worse than no region.
 *  - **Notifications.** No notification feed exists; the bell is disabled and
 *    says so rather than opening an empty tray.
 */
import { useEffect, useState } from "react";
import { api, type SearchResult } from "./api.js";
import type { View } from "./Sidebar.js";
import { VIEW_LABELS } from "./Sidebar.js";

export interface TopbarProps {
  /** Display name of the current org, or null before GET /orgs/{org} resolves. */
  orgName: string | null;
  org: string;
  view: View;
  /** null while loading or if the fetch failed — renders NO pill, never a guess. */
  orgEnv: "prod" | "dev" | null;
  /** The signed-in user's claims, for the avatar. */
  claims: Record<string, string>;
  onNavigate: (view: View) => void;
}

/**
 * Up to two initials from the signed-in user's own claims: a two-word `name`
 * gives one letter each, otherwise the first two alphanumerics of the email
 * local part. Returns null when the claims say nothing — the avatar then shows
 * a neutral glyph instead of inventing a person.
 */
export function initialsFromClaims(claims: Record<string, string>): string | null {
  const words = (claims.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const letters =
      words.length >= 2 ? (words[0] ?? "").slice(0, 1) + (words[1] ?? "").slice(0, 1) : (words[0] ?? "").slice(0, 2);
    const cleaned = letters.replace(/[^\p{L}\p{N}]/gu, "");
    if (cleaned) return cleaned.toUpperCase();
  }
  // Falls through to the email when `name` is absent or is punctuation only.
  const local = (claims.email ?? "").trim().split("@")[0] ?? "";
  const cleaned = local.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2);
  return cleaned ? cleaned.toUpperCase() : null;
}

export function Topbar({ orgName, org, view, orgEnv, claims, onNavigate }: TopbarProps) {
  const initials = initialsFromClaims(claims);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!org || q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api.search(org, q)
        .then((response) => { if (live) setResults(response.results); })
        .catch(() => { if (live) setResults([]); })
        .finally(() => { if (live) setSearching(false); });
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [org, query]);
  // The org half is dropped entirely when no org has resolved, rather than
  // rendering a dangling separator or an em-dash standing in for a name.
  const crumbOrg = orgName ?? (org || null);

  return (
    <div className="topbar">
      <div className="crumbs">
        {crumbOrg && <span>{crumbOrg} / </span>}
        <b>{VIEW_LABELS[view]}</b>
      </div>

      <div className="searchbox" style={{ position: "relative" }}>
        <span aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search newsletters, campaigns…"
          aria-label="Search console"
        />
        {query.trim().length >= 2 && (
          <div role="listbox" aria-label="Search results" style={{ position: "absolute", top: "calc(100% + 8px)", left: 0, right: 0, zIndex: 20, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 10px 28px rgba(0,0,0,.12)", padding: 5 }}>
            {searching && <div className="muted" style={{ padding: "8px 10px" }}>Searching…</div>}
            {!searching && results.length === 0 && <div className="muted" style={{ padding: "8px 10px" }}>No matching resources.</div>}
            {!searching && results.map((result) => (
              <button
                key={`${result.kind}:${result.id}`}
                role="option"
                className="btn ghost"
                style={{ display: "block", width: "100%", textAlign: "left", border: 0 }}
                onClick={() => { onNavigate(result.kind as View); setQuery(""); setResults([]); }}
              >
                <b>{result.label}</b><span className="muted" style={{ marginLeft: 8 }}>{result.kind}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {/* No pill at all while the environment is unknown: rendering PROD by
          default would assert something about the org we have not been told. */}
      {orgEnv && (
        <div
          className="envchip"
          title={
            orgEnv === "dev"
              ? "Test organization — same workflows as production, fail-closed send allowlist, excluded from cost rollups"
              : "Production organization"
          }
        >
          <span className={orgEnv === "dev" ? "pill p-warn" : "pill p-good"}>
            <span className="dot" />
            {orgEnv.toUpperCase()}
          </span>
        </div>
      )}

      <button
        className="iconbtn"
        disabled
        title="Notifications are not implemented in this build."
        aria-label="Notifications (unavailable)"
      >
        {/* U+25CE, not 🔔: the sidebar and topbar are a monochrome glyph set
            (▤ ◇ ✉ ⧉ ⚑) that one colour emoji would break, and the Unicode bell
            renders as colour emoji on most platforms. ⚑ is already the Team
            row's glyph, so this takes a shape the nav does not use. */}
        <span aria-hidden="true">◉</span>
      </button>

      <div
        className="avatar"
        title={claims.email ?? claims.name ?? "Signed in"}
        aria-label={claims.email ?? claims.name ?? "Signed in"}
      >
        {initials ?? "•"}
      </div>
    </div>
  );
}
