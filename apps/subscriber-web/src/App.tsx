/**
 * Subscriber site (#5): newsletter directory (branding-themed, presentation
 * toggles honored), double opt-in confirm landing, preference center /
 * unsubscribe. Reads public branding + list views; posts signup to the API.
 * The subscriber Cognito login (per-org shared pool) reuses the same Hosted-UI
 * PKCE flow as the admin app when VITE_COGNITO_* is configured.
 */
import { useEffect, useMemo, useState } from "react";
import { api, applyBranding, ORG, type Branding, type PublicList } from "./api.js";

type Route =
  | { name: "directory" }
  | { name: "all" }
  | { name: "confirm"; token: string }
  | { name: "unsubscribe"; token: string };

function parseRoute(): Route {
  const p = new URLSearchParams(window.location.search);
  const path = window.location.pathname;
  if (path.endsWith("/confirm") && p.get("token")) return { name: "confirm", token: p.get("token")! };
  if (path.endsWith("/unsubscribe") && p.get("token")) return { name: "unsubscribe", token: p.get("token")! };
  if (path.endsWith("/all")) return { name: "all" };
  return { name: "directory" };
}

export function App() {
  const route = useMemo(parseRoute, []);
  const [branding, setBranding] = useState<Branding | null>(null);
  useEffect(() => {
    api.branding().then((b) => { setBranding(b); applyBranding(b); }).catch(() => undefined);
  }, []);

  return (
    <div className="wrap">
      <header>
        {branding?.logoUrl && <img src={branding.logoUrl} alt="logo" />}
        <h1>Newsletters</h1>
      </header>
      {(route.name === "directory" || route.name === "all") && (
        <nav className="muted" style={{ marginBottom: 16 }}>
          <a href="/" style={{ marginRight: 12, fontWeight: route.name === "directory" ? 700 : 400 }}>Browse</a>
          <a href="/all" style={{ fontWeight: route.name === "all" ? 700 : 400 }}>Subscribe to all</a>
        </nav>
      )}
      {route.name === "directory" && <Directory />}
      {route.name === "all" && <AllNewsletters />}
      {route.name === "confirm" && <Confirm token={route.token} />}
      {route.name === "unsubscribe" && <Unsubscribe token={route.token} />}
    </div>
  );
}

/**
 * "All newsletters" landing page (#61): browse every list, check the ones you
 * want, enter one email, and opt into them all with a single double opt-in — no
 * account or login required.
 */
function AllNewsletters() {
  const [lists, setLists] = useState<PublicList[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api.lists()
      .then((ls) => Promise.all(ls.map((l) => api.publicList(l.listId).catch(() => null))))
      .then((rows) => setLists(rows.filter((r): r is PublicList => r !== null)))
      .catch((e) => setErr(String(e)));
  }, []);
  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const subscribe = async () => {
    setMsg(""); setErr("");
    try {
      await api.signupMany(email, [...selected]);
      setMsg(`Almost there — check ${email} to confirm your ${selected.size} subscription${selected.size === 1 ? "" : "s"}.`);
      setSelected(new Set()); setEmail("");
    } catch (e) { setErr(String(e)); }
  };
  if (err) return <p className="err">{err}</p>;
  if (!ORG) return <p className="muted">Set VITE_ORG_ID to view this org's newsletters.</p>;
  return (
    <div className="card">
      <div className="title">Subscribe to our newsletters</div>
      <p className="muted">Pick the ones you'd like, add your email, and confirm once.</p>
      {lists.length === 0 && <p className="muted">Loading newsletters…</p>}
      {lists.map((l) => (
        <label key={l.listId} className="row" style={{ alignItems: "flex-start", gap: 10, padding: "8px 0" }}>
          <input type="checkbox" checked={selected.has(l.listId)} onChange={() => toggle(l.listId)} />
          <span>
            <b>{l.name}</b>
            {l.presentation.showFrequency && l.frequencyLabel && <span className="pill" style={{ marginLeft: 8 }}>{l.frequencyLabel}</span>}
            {l.description && <div className="muted">{l.description}</div>}
          </span>
        </label>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <input placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button onClick={() => void subscribe()} disabled={!email || selected.size === 0}>
          Subscribe{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

function Directory() {
  const [ids, setIds] = useState<string[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.lists().then((ls) => setIds(ls.map((l) => l.listId))).catch((e) => setErr(String(e)));
  }, []);
  if (err) return <p className="err">{err}</p>;
  if (!ORG) return <p className="muted">Set VITE_ORG_ID to view this org's newsletters.</p>;
  return (
    <div>
      {ids.length === 0 && <p className="muted">Loading newsletters…</p>}
      {ids.map((id) => <ListCard key={id} listId={id} />)}
    </div>
  );
}

function ListCard({ listId }: { listId: string }) {
  const [list, setList] = useState<PublicList | null>(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api.publicList(listId).then(setList).catch(() => undefined);
  }, [listId]);
  const subscribe = async () => {
    setMsg("");
    try { const r = await api.signup(email, listId); setMsg(r.status === "pending" ? "Check your inbox to confirm." : "Subscribed!"); setEmail(""); }
    catch (e) { setMsg(String(e)); }
  };
  if (!list) return null;
  return (
    <div className="card">
      <div className="title">{list.name}</div>
      <div className="meta">
        {list.presentation.showFrequency && list.frequencyLabel && <span className="pill">{list.frequencyLabel}</span>}
        {list.presentation.showSendTime && list.sendTimeLabel && <span>{list.sendTimeLabel}</span>}
        {list.presentation.showReaderCount && list.readerCount !== undefined && <span>{list.readerCount.toLocaleString()} readers</span>}
        {list.presentation.showFreePaidCount && list.freePaidCount && (
          <span>{list.freePaidCount.free} free · {list.freePaidCount.paid} paid</span>
        )}
      </div>
      {list.description && <p className="muted">{list.description}</p>}
      <div className="row">
        <input placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button onClick={() => void subscribe()} disabled={!email}>Subscribe</button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

function Confirm({ token }: { token: string }) {
  const [state, setState] = useState("Confirming…");
  useEffect(() => {
    api.confirm(token).then((r) => setState(r.status === "confirmed" ? "You're subscribed — thank you!" : `Status: ${r.status}`))
      .catch((e) => setState(String(e)));
  }, [token]);
  return <div className="card"><div className="title">Confirm subscription</div><p className="muted">{state}</p></div>;
}

function Unsubscribe({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const go = async () => {
    try { await api.unsubscribe(token); setState("done"); } catch (e) { setErr(String(e)); setState("error"); }
  };
  return (
    <div className="card">
      <div className="title">Unsubscribe</div>
      {state === "idle" && <><p className="muted">Confirm you want to unsubscribe from this list.</p><button onClick={() => void go()}>Unsubscribe</button></>}
      {state === "done" && <p className="muted">You've been unsubscribed.</p>}
      {state === "error" && <p className="err">{err}</p>}
    </div>
  );
}
