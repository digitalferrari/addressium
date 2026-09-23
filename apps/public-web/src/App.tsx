/**
 * Public signup (#6): a standalone hosted signup page AND an embeddable widget
 * operators can drop into their own site. The page posts double-opt-in signups
 * to the API; the "Embed" tab shows a copy-paste snippet that renders the same
 * widget against the operator's org + list.
 */
import { useEffect, useMemo, useState } from "react";
import { HONEYPOT_ATTRS, HONEYPOT_FIELD } from "@addressium/core";

const BASE = import.meta.env.VITE_API_BASE ?? "";

/**
 * Which org this page belongs to, resolved at RUNTIME from the hostname (#294).
 *
 * It used to be `import.meta.env.VITE_ORG_ID`, which Vite substitutes at BUILD
 * time — so the shipped JavaScript contained a literal org id and one build
 * could serve exactly one org. Ten orgs meant ten builds, ten publishes, and ten
 * chances for one of them to go stale.
 *
 * Orgs are siloed: each one's subscriber portal lives on a subdomain of that
 * org's own domain, and every one of those hostnames serves this SAME bundle.
 * So the bundle asks which org it is serving.
 *
 * `VITE_ORG_ID` is honoured ONLY when the page is served from localhost, for
 * `npm run dev` where there is no configured hostname to resolve. It is
 * deliberately not a general fallback: seeding state with it meant a bundle
 * built with that variable rendered the previous org's form for one frame
 * before the lookup resolved — on a shared bundle that is a signup form briefly
 * pointed at the wrong publication.
 */
const DEV_ORG =
  typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)
    ? (import.meta.env.VITE_ORG_ID as string | undefined)
    : undefined;

function useOrgId(): { orgId: string | undefined; error: string | undefined } {
  const [orgId, setOrgId] = useState<string | undefined>(DEV_ORG);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${BASE}/public/site?host=${encodeURIComponent(window.location.host)}`);
        if (cancelled) return;
        if (res.status === 404) {
          // NOT a fallback to some default org: serving the wrong org's signup
          // form would subscribe someone to a publication they never visited.
          setError(
            "This site is not configured yet. Its subscriber domain has no organization in addressium.",
          );
          return;
        }
        if (!res.ok) throw new Error(await res.text());
        const j = (await res.json()) as { orgId: string };
        setOrgId(j.orgId);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { orgId, error };
}

export function App() {
  const [tab, setTab] = useState<"form" | "embed">("form");
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const listId = params.get("list") ?? "";
  const { orgId, error } = useOrgId();

  // A misconfigured host says so rather than rendering a form that would post
  // to the wrong org — or to `"your-org"`, the old placeholder default.
  if (error) return <div className="wrap"><h1>Subscribe</h1><p className="muted">{error}</p></div>;
  if (!orgId) return <div className="wrap"><h1>Subscribe</h1><p className="muted">Loading…</p></div>;

  return (
    <div className="wrap">
      <h1>Subscribe</h1>
      <div className="muted" style={{ marginBottom: 16 }}>
        <a onClick={() => setTab("form")} style={{ cursor: "pointer", marginRight: 12 }}>Signup form</a>
        <a onClick={() => setTab("embed")} style={{ cursor: "pointer" }}>Embed snippet</a>
      </div>
      {tab === "form" ? <SignupForm orgId={orgId} defaultList={listId} /> : <EmbedSnippet orgId={orgId} />}
    </div>
  );
}

export function SignupForm({ orgId, defaultList }: { orgId: string; defaultList?: string }) {
  const [email, setEmail] = useState("");
  const [listId, setListId] = useState(defaultList ?? "");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  // Honeypot (#230). The server-side check and the embed widget both had this;
  // the page addressium itself hosts and links from the subscriber directory did
  // not — so the trap could never trip on the one public page an operator is most
  // likely to deploy and least likely to probe as an attacker. reCAPTCHA does not
  // cover it: that runs only when an org configures a secret, which is off by
  // default. Held in React state rather than read from the DOM so the value
  // cannot be lost to a re-render between fill and submit.
  const [trap, setTrap] = useState("");
  const submit = async () => {
    setMsg(""); setErr("");
    try {
      const res = await fetch(`${BASE}/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, email, listId, [HONEYPOT_FIELD]: trap }),
      });
      if (!res.ok) throw new Error(await res.text());
      const j = (await res.json()) as { status: string };
      setMsg(j.status === "pending" ? "Almost there — check your inbox to confirm." : "Subscribed!");
      setEmail("");
    } catch (e) {
      setErr(String(e));
    }
  };
  return (
    <div className="card addressium-embed">
      <label>Email</label>
      <div className="row">
        <input placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      {/*
        Off-screen rather than `display:none` or `hidden`: a bot that skips
        obviously-hidden inputs still fills this one, and screen readers are kept
        out by aria-hidden + tabIndex rather than by visibility. Same attributes
        as embed.js, from the same constant.
      */}
      <input
        name={HONEYPOT_FIELD}
        value={trap}
        onChange={(e) => setTrap(e.target.value)}
        tabIndex={HONEYPOT_ATTRS.tabIndex}
        autoComplete={HONEYPOT_ATTRS.autoComplete}
        aria-hidden={HONEYPOT_ATTRS["aria-hidden"]}
        style={HONEYPOT_ATTRS.style}
      />
      {!defaultList && (
        <>
          <label>List id</label>
          <input value={listId} onChange={(e) => setListId(e.target.value)} placeholder="e.g. ledger" />
        </>
      )}
      <button onClick={() => void submit()} disabled={!email || !listId}>Subscribe</button>
      {msg && <p className="muted">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function EmbedSnippet({ orgId }: { orgId: string }) {
  // BASE_URL, not a bare "/", because this app is served from a subpath so that
  // subscriber-web can own the root (see vite.config.ts). Hardcoding "/embed.js"
  // here would hand operators a snippet that 404s on their own site.
  const src = new URL(`${import.meta.env.BASE_URL}embed.js`, window.location.origin).href;
  const snippet =
    `<div data-addressium data-org="${orgId}" data-list="YOUR_LIST_ID"></div>\n` +
    `<script async src="${src}"></script>`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (insecure context / old browser) — the user
      // can still select the snippet manually.
    }
  };
  return (
    <div className="card">
      <p className="muted">
        Drop this on any page. The script mounts a self-contained signup widget that posts to your
        addressium API (double opt-in). No cookies, no tracking.
      </p>
      <pre>{snippet}</pre>
      <button onClick={() => void copy()}>{copied ? "Copied!" : "Copy snippet"}</button>
    </div>
  );
}
