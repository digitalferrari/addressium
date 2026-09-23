/**
 * API keys (#280) — issue, revoke and verify the machine credentials scoped to
 * one organization. Rendered inside the API & webhooks screen, beside the
 * inbound-webhook half that was already built.
 *
 * THE ONE-TIME DISPLAY IS THE WHOLE INTERACTION. The server returns a plaintext
 * key from `POST /api-keys` and from nowhere else, ever; it stores a SHA-256
 * digest and cannot reconstruct the key even if this screen asked. So the panel
 * that shows it says so in those words, before the operator navigates away and
 * finds out. It is held in component state only — never localStorage, never a
 * refetch — and the list refresh that follows deliberately cannot repopulate it.
 *
 * WHAT IS NOT INVENTED HERE, which is the failure mode this console has had:
 *
 *  - The **Key** column renders `displayPrefix`, a real field the server
 *    captured from the plaintext at issuance. It is NOT a mask of a full value
 *    we hold, because we hold no full value. The ellipsis after it is honest:
 *    the rest is gone.
 *  - **Last used** renders `lastUsedAt` or the literal word "Never". That field
 *    is written by exactly one function server-side, `authenticateApiKey`, whose
 *    only HTTP entry point is the Verify control on this screen. Nothing else in
 *    this build authenticates with an API key — so "Never" is a fact about the
 *    key, and the panel says which action would change it rather than leaving a
 *    dash to be read as a bug.
 *  - **Scopes** are recorded at issuance and checked by that same verify path.
 *    No route is gated on them yet, because no route authenticates with a key,
 *    and the screen states that instead of implying an enforcement that does not
 *    exist.
 *
 * Server-side RBAC is the boundary. `apikeys:manage` gates all four routes; the
 * gating here only hides controls the caller could not use.
 */
import { useState } from "react";
import { useAsync } from "../useAsync.js";
import { can, type Grant } from "../rbac.js";
import { idProblem, isValidId, suggestId } from "../ids.js";
import { relativeTime } from "../time.js";
import { api, type ApiKeyEntry, type ApiKeyScope } from "../api.js";
import { SkeletonTable } from "../Skeleton.js";

/**
 * Mirrors `ApiKeyScope` in `@addressium/core`. Each label says what an
 * integration would DO with it, not which console screen it resembles — these
 * are deliberately not the console's RBAC capabilities (a key carrying
 * `apikeys:manage` could mint further keys).
 */
const SCOPES: { value: ApiKeyScope; label: string }[] = [
  { value: "subscribers:read", label: "Read subscribers" },
  { value: "subscribers:write", label: "Add and update subscribers" },
  { value: "entitlement:write", label: "Set free / paid entitlement" },
  { value: "campaigns:read", label: "Read campaigns and counters" },
  { value: "suppression:write", label: "Add to the suppression list" },
];

const scopeLabel = (s: ApiKeyScope) => SCOPES.find((x) => x.value === s)?.label ?? s;

/** An absolute timestamp plus how long ago — the same pairing Schedules uses. */
const when = (iso: string) => `${new Date(iso).toLocaleString()} (${relativeTime(iso)})`;

export function ApiKeys({ org, grant }: { org: string; grant: Grant | null }) {
  const mayManage = can(grant, "apikeys:manage", org);
  const [rev, setRev] = useState(0);
  // The list itself is `apikeys:manage` server-side — a credential inventory is
  // not a report — so a caller without it is not asked to load one.
  const { data, error, loading } = useAsync(
    () => (mayManage && org ? api.apiKeys(org) : Promise.resolve<ApiKeyEntry[]>([])),
    [org, rev, mayManage],
  );

  const [name, setName] = useState("");
  const [keyId, setKeyId] = useState("");
  const [keyIdTouched, setKeyIdTouched] = useState(false);
  const [scopes, setScopes] = useState<ApiKeyScope[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  /**
   * The plaintext of the key just issued. Component state and nothing else: it
   * is unrecoverable once this unmounts, which is the guarantee the panel makes.
   */
  const [issued, setIssued] = useState<{ plaintext: string; keyId: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [verifyValue, setVerifyValue] = useState("");
  const [verifyResult, setVerifyResult] = useState("");

  const rows = data ?? [];
  const live = rows.filter((k) => !k.revoked);
  const revoked = rows.filter((k) => k.revoked);

  const effectiveId = keyIdTouched ? keyId : suggestId(name);
  const idIssue = idProblem(effectiveId);
  const canIssue =
    name.trim().length > 0 && isValidId(effectiveId) && scopes.length > 0 && !busy;

  const toggleScope = (s: ApiKeyScope) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const create = async () => {
    setMsg("");
    setBusy(true);
    try {
      const result = await api.issueApiKey({
        orgId: org,
        keyId: effectiveId,
        name: name.trim(),
        scopes,
      });
      setIssued({ plaintext: result.plaintext, keyId: result.key.keyId });
      setCopied(false);
      setName("");
      setKeyId("");
      setKeyIdTouched(false);
      setScopes([]);
      setRev((n) => n + 1);
    } catch (e) {
      // The server's sentence verbatim — a duplicate keyId names the id and says
      // why replacing it in place would break a running integration (#265).
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k: ApiKeyEntry) => {
    if (!confirm(`Revoke "${k.name}"? Any integration using this key stops working immediately.`)) {
      return;
    }
    setMsg("");
    setBusy(true);
    try {
      await api.revokeApiKey(org, k.keyId);
      setRev((n) => n + 1);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setVerifyResult("");
    setBusy(true);
    try {
      const k = await api.verifyApiKey(org, verifyValue.trim());
      setVerifyResult(`Live — "${k.name}" (${k.keyId}). Last used is now set to this check.`);
      setVerifyValue("");
      setRev((n) => n + 1);
    } catch {
      // One sentence for every cause, matching the server: an unknown key, a
      // revoked one and another org's key are deliberately indistinguishable
      // there, so the console does not invent a distinction it was not told.
      setVerifyResult("Not a live key for this organization — unknown, revoked, or from another org.");
    } finally {
      setBusy(false);
    }
  };

  if (!mayManage) {
    return (
      <div className="card">
        <div className="cardhead" style={{ margin: "-18px -18px 16px" }}>
          <h2>API keys</h2>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Managing API keys requires the <code>apikeys:manage</code> capability, which your role does
          not have. A key list names every integration with machine access to this organization and
          what each one may do, so it is not a report — the API refuses to return it, and this is not
          a display the console could grant.
        </p>
      </div>
    );
  }

  const row = (k: ApiKeyEntry) => (
    <tr key={k.keyId} style={k.revoked ? { opacity: 0.6 } : undefined}>
      <td className="t-strong">
        {k.name}
        <div className="muted" style={{ fontFamily: "monospace", fontSize: "0.85em" }}>{k.keyId}</div>
      </td>
      <td style={{ fontFamily: "monospace" }}>
        {k.displayPrefix}…
        {/* Not a mask. The rest of this key is not stored anywhere and cannot be
            shown again — these characters are what the server kept on purpose. */}
        <div className="muted" style={{ fontSize: "0.85em" }}>shown once at creation</div>
      </td>
      <td>
        {k.scopes.map((s) => (
          <div key={s}>
            <code>{s}</code>
          </div>
        ))}
      </td>
      <td className="muted">{k.lastUsedAt ? when(k.lastUsedAt) : "Never"}</td>
      <td className="muted">{when(k.createdAt)}</td>
      <td>
        {k.revoked ? (
          // No fallback to `createdAt` if `revokedAt` were ever absent: that
          // would print the creation time under the word "revoked" — a
          // plausible, wrong timestamp, which is worse than the bare word.
          <span className="pill p-warn">
            revoked{k.revokedAt ? ` ${relativeTime(k.revokedAt)}` : ""}
          </span>
        ) : (
          <button className="btn ghost" onClick={() => void revoke(k)} disabled={busy}>
            Revoke
          </button>
        )}
      </td>
    </tr>
  );

  return (
    <>
      {issued && (
        <div className="card" style={{ borderColor: "var(--warn)", background: "var(--warn-soft)" }}>
          <strong>Copy this key now — it will not be shown again.</strong>
          <p className="muted">
            addressium stores only a SHA-256 hash of this key. It is not written to any log and there
            is no way for this console, or the API, to display it a second time. If you lose it,
            revoke <code>{issued.keyId}</code> and issue a new key.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              readOnly
              value={issued.plaintext}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="New API key"
              style={{ flex: 1, minWidth: 280, fontFamily: "monospace" }}
            />
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(issued.plaintext)
                  .then(() => setCopied(true))
                  // Clipboard access can be denied outright; saying so beats a
                  // button that silently does nothing while the operator
                  // believes the key is on their clipboard.
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="btn ghost" onClick={() => setIssued(null)}>
              I have stored it
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="cardhead" style={{ margin: "-18px -18px 16px" }}>
          <h2>API keys</h2>
          <span className="pill p-good">Built</span>
        </div>
        <p className="muted">
          Credentials for machines rather than people. Keys are stored hashed, shown once, and
          revocable. They do <b>not</b> sign you into this console — the console rides Cognito, and
          revoking a key does not affect any operator's access.
        </p>

        {loading && <SkeletonTable rows={4} />}
        {error && <p className="err">{error}</p>}

        {!loading && rows.length === 0 && (
          <p className="muted" style={{ marginBottom: 0 }}>
            No API keys have been issued for this organization.
          </p>
        )}

        {rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scope</th>
                <th>Last used</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {live.map(row)}
              {revoked.length > 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ paddingTop: 12 }}>
                    Revoked — kept so you can still see what each key could do and when it was cut
                    off
                  </td>
                </tr>
              )}
              {revoked.map(row)}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>Create key</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (e.g. Billing entitlement sync)"
            style={{ flex: 2, minWidth: 220 }}
            disabled={busy}
          />
          <input
            value={effectiveId}
            onChange={(e) => {
              setKeyIdTouched(true);
              setKeyId(e.target.value);
            }}
            placeholder="key id"
            aria-label="Key id"
            style={{ flex: 1, minWidth: 160, fontFamily: "monospace" }}
            disabled={busy}
          />
        </div>
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ marginBottom: 6 }}>
            Scope — at least one. A key is refused if it carries none.
          </div>
          {SCOPES.map((s) => (
            <label key={s.value} style={{ display: "block", marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={scopes.includes(s.value)}
                onChange={() => toggleScope(s.value)}
                disabled={busy}
              />{" "}
              {s.label} <code className="muted">{s.value}</code>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <button className="btn" disabled={!canIssue} onClick={() => void create()}>
            {busy ? "Working…" : "Create key"}
          </button>
          {idIssue && <span className="err">Key id {idIssue}.</span>}
          {msg && <span className="err">{msg}</span>}
        </div>
      </div>

      <div className="card">
        <div className="muted" style={{ marginBottom: 8 }}>Check a key</div>
        <p className="muted">
          Paste a key to find out whether it is still live for this organization — useful when you
          are not sure whether the value in a deployment is the current one. This is the only thing
          in addressium that authenticates an API key today, and it is what sets <b>Last used</b>:
          a successful check below is recorded against the key, which is why a key nothing has
          checked reads <i>Never</i> rather than a dash.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={verifyValue}
            onChange={(e) => setVerifyValue(e.target.value)}
            placeholder="ak_…"
            aria-label="API key to check"
            style={{ flex: 1, minWidth: 260, fontFamily: "monospace" }}
            disabled={busy}
          />
          <button className="btn ghost" disabled={busy || verifyValue.trim() === ""} onClick={() => void verify()}>
            Check
          </button>
          {verifyResult && (
            <span className={verifyResult.startsWith("Live") ? "muted" : "err"}>{verifyResult}</span>
          )}
        </div>
      </div>
    </>
  );
}
