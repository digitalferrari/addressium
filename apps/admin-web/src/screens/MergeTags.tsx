/**
 * Merge tags (§4.15) — the registry of `{{…}}` placeholders a template can write
 * and the send path will fill in.
 *
 * The screen's real job is making one rule legible: FOUR names are reserved by
 * the send path, and a reserved name always beats a subscriber attribute of the
 * same name. That rule is not enforced here — it is enforced in `mergeValues`
 * (`packages/domain/src/send.ts`) at send time and in `saveMergeTag` at
 * registration. This screen shows it, and the `reserved` flag on each row comes
 * from the server rather than being guessed from the source column.
 */
import { useState } from "react";
import { useAsync } from "../useAsync.js";
import { api, type MergeTagEntry, type MergeTagScope, type MergeTagSource } from "../api.js";
import { SkeletonTable } from "../Skeleton.js";

const SOURCES: { value: MergeTagSource; label: string }[] = [
  { value: "profile", label: "Profile attribute" },
  { value: "feed", label: "Feed field" },
  { value: "token_claim", label: "Token claim" },
  { value: "system", label: "System" },
];
const SCOPES: { value: MergeTagScope; label: string }[] = [
  { value: "per_recipient", label: "per-recipient" },
  { value: "per_campaign", label: "per-campaign" },
  { value: "token_claim", label: "token claim" },
];

const sourceLabel = (s: MergeTagSource) => SOURCES.find((x) => x.value === s)?.label ?? s;
const scopeLabel = (s: MergeTagScope) => SCOPES.find((x) => x.value === s)?.label ?? s;

/** Mirrors `mergeTagNameSchema` so the operator is not handed a rejected form after typing. */
const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function MergeTags({ org }: { org: string }) {
  const [rev, setRev] = useState(0);
  const { data, error, loading } = useAsync(() => api.mergeTags(org), [org, rev]);
  const [name, setName] = useState("");
  const [source, setSource] = useState<MergeTagSource>("profile");
  const [scope, setScope] = useState<MergeTagScope>("per_recipient");
  const [example, setExample] = useState("");
  const [fallback, setFallback] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const rows = data ?? [];
  const reserved = rows.filter((t) => t.reserved);
  const own = rows.filter((t) => !t.reserved);

  const reset = () => {
    setName(""); setSource("profile"); setScope("per_recipient"); setExample(""); setFallback("");
  };
  const edit = (t: MergeTagEntry) => {
    setName(t.name); setSource(t.source); setScope(t.scope);
    setExample(t.example ?? ""); setFallback(t.fallback ?? ""); setMsg("");
  };

  const save = async () => {
    setMsg(""); setBusy(true);
    try {
      const saved = await api.saveMergeTag({
        orgId: org,
        name: name.trim(),
        source,
        scope,
        ...(example.trim() ? { example: example.trim() } : {}),
        ...(fallback.trim() ? { fallback: fallback.trim() } : {}),
      });
      setMsg(`Saved {{${saved.name}}}.`);
      setRev((n) => n + 1);
      reset();
    } catch (e) {
      // The server's sentence, verbatim — for a reserved name it names the tag
      // and says why, which is the whole reason that check throws
      // InvalidInputError rather than failing zod validation.
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: MergeTagEntry) => {
    setMsg(""); setBusy(true);
    try {
      await api.deleteMergeTag(org, t.name);
      setRev((n) => n + 1);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };

  const trimmed = name.trim();
  const collides = reserved.some((t) => t.name === trimmed);
  const valid = NAME_RE.test(trimmed) && !collides;

  const row = (t: MergeTagEntry) => (
    <tr key={t.name}>
      <td className="t-strong" style={{ fontFamily: "monospace" }}>{`{{${t.name}}}`}</td>
      <td>{sourceLabel(t.source)}</td>
      <td>{scopeLabel(t.scope)}</td>
      <td className="muted">{t.example ?? "—"}</td>
      <td style={{ fontFamily: "monospace" }}>{t.fallback ?? "—"}</td>
      <td>
        {t.reserved ? (
          <span className="muted">reserved</span>
        ) : (
          <>
            <button className="btn ghost" onClick={() => edit(t)} disabled={busy}>Edit</button>{" "}
            <button className="btn ghost" onClick={() => remove(t)} disabled={busy}>Remove</button>
          </>
        )}
      </td>
    </tr>
  );

  return (
    <div>
      <h1 className="h1">Merge tags · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -8 }}>
        In-email replacement variables and where each value comes from at send time. Write one in a
        template as <code>{"{{name}}"}</code>.
      </p>

      <div className="card">
        <strong>Reserved names win.</strong>{" "}
        <span className="muted">
          The send path supplies{" "}
          {reserved.map((t, i) => (
            <span key={t.name}>
              {i > 0 && ", "}
              <code>{t.name}</code>
            </span>
          ))}
          . A subscriber attribute of the same name is overridden, never the other way round — an
          imported CSV column called <code>unsubscribe_url</code> cannot replace the real
          unsubscribe link. Registering a tag under one of these names is refused.
        </span>
      </div>

      {loading && <SkeletonTable rows={4} />}
      {error && <p className="err">{error}</p>}

      {rows.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr><th>Tag</th><th>Source</th><th>Scope</th><th>Example</th><th>Fallback</th><th></th></tr>
            </thead>
            <tbody>
              {reserved.map(row)}
              {own.length > 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ paddingTop: 12 }}>
                    Defined by this organization
                  </td>
                </tr>
              )}
              {own.map(row)}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>Add or update a merge tag</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="tag name (e.g. first_name)"
            style={{ flex: 2, minWidth: 180, fontFamily: "monospace" }}
            disabled={busy}
          />
          <select value={source} onChange={(e) => setSource(e.target.value as MergeTagSource)} disabled={busy}>
            {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select value={scope} onChange={(e) => setScope(e.target.value as MergeTagScope)} disabled={busy}>
            {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <input value={example} onChange={(e) => setExample(e.target.value)}
            placeholder="example value (optional)" style={{ flex: 1, minWidth: 180 }} disabled={busy} />
          <input value={fallback} onChange={(e) => setFallback(e.target.value)}
            placeholder="fallback when empty (optional)" style={{ flex: 1, minWidth: 180 }} disabled={busy} />
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
          <button className="btn" disabled={!valid || busy} onClick={save}>
            {busy ? "Saving…" : "Save merge tag"}
          </button>
          {trimmed && collides && (
            <span className="err">
              {`{{${trimmed}}}`} is reserved by the send path — choose another name.
            </span>
          )}
          {trimmed && !collides && !NAME_RE.test(trimmed) && (
            <span className="err">
              Lowercase letters, digits and underscores; must start with a letter.
            </span>
          )}
          {msg && <span className={msg.startsWith("Saved") ? "muted" : "err"}>{msg}</span>}
        </div>
      </div>
    </div>
  );
}
