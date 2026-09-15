/**
 * Subscriber site (#5): newsletter directory (branding-themed, presentation
 * toggles honored) and all-lists view, plus the signed preference centre,
 * double opt-in confirm landing, and one-click unsubscribe. Reads public
 * branding + list views; posts signup and preference changes to the API. There
 * is no login here — the addressium subscriber record is the identity, and any
 * Cognito pool belongs to the org, not to us (docs/ARCHITECTURE.md §4.10).
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, applyBranding, displayError, ORG, type Branding, type PreferenceView, type PublicList } from "./api.js";

type Route =
  | { name: "directory" }
  | { name: "all" }
  | { name: "preferences"; token?: string }
  | { name: "confirm"; token: string }
  | { name: "unsubscribe"; token: string };

function parseRoute(): Route {
  const p = new URLSearchParams(window.location.search);
  const path = window.location.pathname;
  if (path.endsWith("/confirm") && p.get("token")) return { name: "confirm", token: p.get("token")! };
  if (path.endsWith("/unsubscribe") && p.get("token")) return { name: "unsubscribe", token: p.get("token")! };
  if (path.endsWith("/preferences")) return { name: "preferences", ...(p.get("token") ? { token: p.get("token")! } : {}) };
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
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Home">
          {branding?.logoUrl ? <img src={branding.logoUrl} alt="" /> : <span className="brand-mark">A</span>}
          <span>{branding ? "Newsletters" : "addressium"}</span>
        </a>
        {(route.name === "directory" || route.name === "all" || route.name === "preferences") && (
          <nav aria-label="Newsletter navigation">
            <a className={route.name === "directory" ? "active" : ""} href="/">Browse</a>
            <a className={route.name === "all" ? "active" : ""} href="/all">Subscribe to all</a>
            <a className={route.name === "preferences" ? "active" : ""} href="/preferences">Manage subscriptions</a>
          </nav>
        )}
      </header>
      {(route.name === "directory" || route.name === "all") && (
        <section className="hero">
          <p className="eyebrow">Stay in the loop</p>
          <h1>Ideas worth opening.</h1>
          <p>Choose the newsletters you want in your inbox. No account required — just a thoughtful email when it matters.</p>
        </section>
      )}
      {(route.name === "directory" || route.name === "all") && (
        <main>
          {route.name === "directory" && <Directory />}
          {route.name === "all" && <AllNewsletters />}
        </main>
      )}
      {route.name === "confirm" && <main className="action-page"><Confirm token={route.token} /></main>}
      {route.name === "unsubscribe" && <main className="action-page"><Unsubscribe token={route.token} /></main>}
      {route.name === "preferences" && <main className="action-page"><Preferences token={route.token} /></main>}
      <footer>Powered by addressium · You can unsubscribe at any time.</footer>
    </div>
  );
}

export function Preferences({ token }: { token?: string }) {
  const [view, setView] = useState<PreferenceView | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    setBusy(true);
    api.preferences(token)
      .then((next) => {
        setView(next);
        setChecked(Object.fromEntries(next.rows.map((row) => [row.listId, row.subscribed])));
      })
      .catch((e) => setError(displayError(e)))
      .finally(() => setBusy(false));
  }, [token]);

  const request = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api.requestPreferences(email);
      setMessage(result.message);
      setEmail("");
    } catch (e) { setError(displayError(e)); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!token || !view) return;
    setBusy(true); setError(""); setMessage("");
    const changes = view.rows
      .filter((row) => checked[row.listId] !== row.subscribed)
      .map((row) => ({ listId: row.listId, subscribed: checked[row.listId] === true }));
    try {
      const result = await api.updatePreferences(token, changes);
      setView(result.view);
      setChecked(Object.fromEntries(result.view.rows.map((row) => [row.listId, row.subscribed])));
      setMessage(result.rejected.length ? "Some changes could not be applied." : "Your preferences have been saved.");
    } catch (e) { setError(displayError(e)); }
    finally { setBusy(false); }
  };

  if (!token) return (
    <div className="action-card preference-card">
      <span className="action-icon">✦</span>
      <div className="title">Manage your subscriptions</div>
      <p className="muted">Enter your email and we’ll send a private link to update every newsletter subscription.</p>
      <form className="preference-request" onSubmit={(e) => void request(e)}>
        <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        <button disabled={busy}>{busy ? "Sending…" : "Email me a link"}</button>
      </form>
      {message && <p className="muted">{message}</p>}
      {error && <p className="err">{error}</p>}
    </div>
  );

  if (error && !view) return <div className="action-card preference-card"><div className="title">This link could not be opened</div><p className="err">{error}</p><a href="/preferences">Request a new link</a></div>;
  if (!view) return <div className="action-card preference-card"><p className="muted">Loading your preferences…</p></div>;

  return (
    <div className="action-card preference-card preference-editor">
      <span className="action-icon">✦</span>
      <div className="title">Your subscriptions</div>
      <p className="muted">Manage newsletters for <strong>{view.email}</strong>.</p>
      {view.rows.length === 0 && <p className="muted">There are no newsletters available for this address.</p>}
      <div className="preference-list">
        {view.rows.map((row) => (
          <label className="preference-row" key={row.listId}>
            <input type="checkbox" checked={checked[row.listId] === true} onChange={(e) => setChecked((current) => ({ ...current, [row.listId]: e.target.checked }))} disabled={busy || row.status === "bounced" || row.status === "complained"} />
            <span><b>{row.name}</b>{row.description && <small>{row.description}</small>}{(row.status === "bounced" || row.status === "complained") && <small className="err">This address cannot be resubscribed.</small>}</span>
          </label>
        ))}
      </div>
      <button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save preferences"}</button>
      {message && <p className="muted">{message}</p>}
      {error && <p className="err">{error}</p>}
      <a href="/">Back to newsletters</a>
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
  // Distinct from `lists.length === 0`. An org with no public newsletters is a
  // normal state, and conflating it with "still fetching" left the page saying
  // "Loading newsletters…" forever — including on a stale build pointed at an
  // org that no longer exists, where the request succeeds and returns [].
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    // One request. This used to fan out to /lists/{id}/public per list, which
    // made the front page's cost scale with the number of newsletters.
    api
      .directory()
      .then(setLists)
      .catch((e) => setErr(displayError(e)))
      .finally(() => setLoaded(true));
  }, []);
  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const subscribe = async () => {
    setMsg(""); setErr("");
    try {
      await api.signupMany(email, [...selected]);
      setMsg(`Almost there — check ${email} to confirm your ${selected.size} subscription${selected.size === 1 ? "" : "s"}.`);
      setSelected(new Set()); setEmail("");
    } catch (e) { setErr(displayError(e)); }
  };
  if (err) return <p className="err">{err}</p>;
  if (!ORG) return <p className="muted">Set VITE_ORG_ID to view this org's newsletters.</p>;
  return (
    <section className="subscribe-panel">
      <div className="section-heading"><div><p className="eyebrow">One simple signup</p><h2>Choose your inbox</h2></div><span className="count">{lists.length} available</span></div>
      <p className="muted">Pick the ones you'd like, add your email, and confirm once.</p>
      {!loaded && <p className="muted">Loading newsletters…</p>}
      {loaded && lists.length === 0 && (
        <p className="muted">No newsletters are published yet.</p>
      )}
      {lists.map((l) => (
        <label key={l.listId} className="choice">
          <input type="checkbox" checked={selected.has(l.listId)} onChange={() => toggle(l.listId)} />
          <span className="choice-copy">
            <b>{l.name}</b>
            {l.presentation.showFrequency && l.frequencyLabel && <span className="pill" style={{ marginLeft: 8 }}>{l.frequencyLabel}</span>}
            {l.description && <div className="muted">{l.description}</div>}
          </span>
        </label>
      ))}
      <div className="signup-row">
        <input placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="primary" onClick={() => void subscribe()} disabled={!email || selected.size === 0}>
          Subscribe{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}

function Directory() {
  const [ids, setIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    api
      .directory()
      .then((ls) => setIds(ls.map((l) => l.listId)))
      .catch((e) => setErr(displayError(e)))
      .finally(() => setLoaded(true));
  }, []);
  if (err) return <p className="err">{err}</p>;
  if (!ORG) return <p className="muted">Set VITE_ORG_ID to view this org's newsletters.</p>;
  return (
    <div className="directory">
      {!loaded && <p className="muted">Loading newsletters…</p>}
      {loaded && ids.length === 0 && (
        <p className="muted">No newsletters are published yet.</p>
      )}
      <div className="list-grid">{ids.map((id) => <ListCard key={id} listId={id} />)}</div>
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
    catch (e) { setMsg(displayError(e)); }
  };
  if (!list) return null;
  return (
    <article className="list-card">
      <div className="list-card-top"><span className="list-icon">✦</span><div className="title">{list.name}</div></div>
      <div className="meta">
        {list.presentation.showFrequency && list.frequencyLabel && <span className="pill">{list.frequencyLabel}</span>}
        {list.presentation.showSendTime && list.sendTimeLabel && <span>{list.sendTimeLabel}</span>}
        {list.presentation.showReaderCount && list.readerCount !== undefined && <span>{list.readerCount.toLocaleString()} readers</span>}
        {list.presentation.showFreePaidCount && list.freePaidCount && (
          <span>{list.freePaidCount.free} free · {list.freePaidCount.paid} paid</span>
        )}
      </div>
      {list.description && <p className="muted">{list.description}</p>}
      <div className="signup-row">
        <input placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="primary" onClick={() => void subscribe()} disabled={!email}>Subscribe</button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </article>
  );
}

function Confirm({ token }: { token: string }) {
  const [state, setState] = useState("Confirming…");
  useEffect(() => {
    api.confirm(token).then((r) => setState(r.status === "confirmed" ? "You're subscribed — thank you!" : `Status: ${r.status}`))
      .catch((e) => setState(displayError(e)));
  }, [token]);
  return <div className="action-card"><span className="action-icon">✓</span><div className="title">Confirm subscription</div><p className="muted">{state}</p><a href="/">Back to newsletters</a></div>;
}

function Unsubscribe({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const go = async () => {
    try { await api.unsubscribe(token); setState("done"); } catch (e) { setErr(displayError(e)); setState("error"); }
  };
  return (
    <div className="action-card">
      <span className="action-icon">↗</span>
      <div className="title">Unsubscribe</div>
      {state === "idle" && <><p className="muted">Confirm you want to unsubscribe from this list.</p><button onClick={() => void go()}>Unsubscribe</button></>}
      {state === "done" && <p className="muted">You've been unsubscribed.</p>}
      {state === "error" && <p className="err">{err}</p>}
      {state !== "idle" && <a href="/">Back to newsletters</a>}
    </div>
  );
}
