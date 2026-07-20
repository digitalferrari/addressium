/**
 * Subscriber site (#5): newsletter directory (branding-themed, presentation
 * toggles honored), double opt-in confirm landing, preference center /
 * unsubscribe. Reads public branding + list views; posts signup to the API.
 * The subscriber Cognito login (per-org shared pool) reuses the same Hosted-UI
 * PKCE flow as the admin app when VITE_COGNITO_* is configured.
 */
import { useEffect, useMemo, useState } from "react";
import { api, applyBranding, ORG, type Branding, type PublicList } from "./api.js";

type Route = { name: "directory" } | { name: "confirm"; token: string } | { name: "unsubscribe"; token: string };

function parseRoute(): Route {
  const p = new URLSearchParams(window.location.search);
  const path = window.location.pathname;
  if (path.endsWith("/confirm") && p.get("token")) return { name: "confirm", token: p.get("token")! };
  if (path.endsWith("/unsubscribe") && p.get("token")) return { name: "unsubscribe", token: p.get("token")! };
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
      {route.name === "directory" && <Directory />}
      {route.name === "confirm" && <Confirm token={route.token} />}
      {route.name === "unsubscribe" && <Unsubscribe token={route.token} />}
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
