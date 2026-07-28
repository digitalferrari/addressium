/**
 * Public signup (#6): a standalone hosted signup page AND an embeddable widget
 * operators can drop into their own site. The page posts double-opt-in signups
 * to the API; the "Embed" tab shows a copy-paste snippet that renders the same
 * widget against the operator's org + list.
 */
import { useMemo, useState } from "react";

const BASE = import.meta.env.VITE_API_BASE ?? "";
const ORG = import.meta.env.VITE_ORG_ID ?? "your-org";

export function App() {
  const [tab, setTab] = useState<"form" | "embed">("form");
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const listId = params.get("list") ?? "";
  return (
    <div className="wrap">
      <h1>Subscribe</h1>
      <div className="muted" style={{ marginBottom: 16 }}>
        <a onClick={() => setTab("form")} style={{ cursor: "pointer", marginRight: 12 }}>Signup form</a>
        <a onClick={() => setTab("embed")} style={{ cursor: "pointer" }}>Embed snippet</a>
      </div>
      {tab === "form" ? <SignupForm defaultList={listId} /> : <EmbedSnippet />}
    </div>
  );
}

export function SignupForm({ defaultList }: { defaultList?: string }) {
  const [email, setEmail] = useState("");
  const [listId, setListId] = useState(defaultList ?? "");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    setMsg(""); setErr("");
    try {
      const res = await fetch(`${BASE}/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: ORG, email, listId }),
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

function EmbedSnippet() {
  const src = `${window.location.origin}/embed.js`;
  const snippet =
    `<div data-addressium data-org="${ORG}" data-list="YOUR_LIST_ID"></div>\n` +
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
