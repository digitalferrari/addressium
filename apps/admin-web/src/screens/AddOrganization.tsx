/**
 * Add organization (#226) — the last piece of "invite the rest of the team
 * through the console" that had no surface.
 *
 * Provisioning is not reversible in one click: it creates a KMS key, an SES
 * identity and a configuration set. So this screen states what will be created
 * before it creates it, and surfaces the DNS records afterwards — a new org that
 * cannot send because nobody saw the DKIM records is the common failure.
 *
 * `parseDevAllowlist` and `isDevAllowlistEntry` are exported alongside the
 * screen for `AddOrganization.test.tsx` (#250).
 */
import { useState } from "react";
import { api, type CreateOrgInput, type CreateOrgResult } from "../api.js";

/** One entry per line or comma, blanks dropped — the shape `recipientAllowedForDev` reads. */
export function parseDevAllowlist(text: string): string[] {
  return text.split(/[\n,]/).map((e) => e.trim()).filter(Boolean);
}

/**
 * The two forms `recipientAllowedForDev` can actually match (#250): an exact
 * address, or a leading-`@` domain suffix. `example.com` and `*@example.com`
 * both look like they grant a domain and match NOTHING — the same silent
 * undeliverability this issue is about, re-created one layer up.
 */
export function isDevAllowlistEntry(entry: string): boolean {
  const e = entry.trim();
  // The domain half must be dotted: the matcher compares the WHOLE domain, so
  // `@localhost` can never equal a real recipient's domain.
  const domain = "[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+";
  // The local half excludes `*` deliberately. A permissive "anything but @"
  // class accepts `*@example.com`, which reads as a wildcard, is compared
  // literally, and therefore denies every address it appears to allow.
  if (e.startsWith("@")) return new RegExp(`^@${domain}$`).test(e);
  return new RegExp(`^[A-Za-z0-9._%+-]+@${domain}$`).test(e);
}

export function AddOrganization() {
  const [form, setForm] = useState<CreateOrgInput>({
    name: "",
    primaryDomain: "",
    siteDomain: "",
    defaultTimezone: "UTC",
    magicLinks: false,
    environment: "prod",
  });
  const [poolId, setPoolId] = useState("");
  const [allowlistText, setAllowlistText] = useState("");
  const [result, setResult] = useState<CreateOrgResult | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<CreateOrgInput>) => setForm((f) => ({ ...f, ...patch }));

  const allowlist = parseDevAllowlist(allowlistText);
  // An entry the matcher cannot match is worse than no entry: it looks like the
  // operator granted an address and denies it anyway. Both halves are blocking
  // (#250) because creation is the ONLY chance to set this field — there is no
  // org-update route, so an org provisioned as `dev` with an empty or unusable
  // allowlist can never deliver a message and can never be repaired.
  const badEntries = allowlist.filter((e) => !isDevAllowlistEntry(e));
  const devNeedsAllowlist = form.environment === "dev" && allowlist.length === 0;
  const canSubmit =
    !busy && !!form.name && !!form.primaryDomain && !devNeedsAllowlist && badEntries.length === 0;

  const submit = async () => {
    setBusy(true); setMsg(""); setResult(null);
    try {
      const body: CreateOrgInput = {
        ...form,
        ...(form.magicLinks && poolId.trim() ? { subscriberPool: { poolId: poolId.trim() } } : {}),
        // Omitted, not empty, for a prod org: `recipientAllowedForDev` never
        // gates prod, so storing a list there would record a rule nothing reads.
        ...(form.environment === "dev" ? { devAllowlist: allowlist } : {}),
      };
      setResult(await api.createOrg(body));
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div>
      <h2>Add organization</h2>
      <p className="muted">
        Creates a silo: its own SES identity and configuration set, and — with magic links on — a
        per-org KMS signing key. Provisioning is idempotent on the derived org id.
      </p>

      <div className="card">
        <label>Name<input value={form.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label>
          Sending domain
          <input value={form.primaryDomain} onChange={(e) => set({ primaryDomain: e.target.value })} placeholder="mail.example.com" />
          <div className="muted">SES verifies this; you publish the DKIM records shown after.</div>
        </label>
        <label>
          Site domain
          <input value={form.siteDomain} onChange={(e) => set({ siteDomain: e.target.value })} placeholder="www.example.com" />
        </label>
        <label>
          Time zone
          <input value={form.defaultTimezone ?? ""} onChange={(e) => set({ defaultTimezone: e.target.value })} />
          <div className="muted">Interprets recurring wall-clock send schedules, DST-aware.</div>
        </label>
        <label>
          Environment
          <select value={form.environment} onChange={(e) => set({ environment: e.target.value as "prod" | "dev" })}>
            <option value="prod">prod</option>
            <option value="dev">dev — fail-closed to an allowlist</option>
          </select>
        </label>
        {form.environment === "dev" && (
          <label>
            Dev send allowlist
            <textarea
              value={allowlistText}
              onChange={(e) => setAllowlistText(e.target.value)}
              rows={4}
              placeholder={"qa@team.example\n@team.example"}
              style={{ width: "100%", fontFamily: "monospace" }}
            />
            <div className="muted">
              One per line: an exact address, or <code>@domain</code> for everyone at a domain. A{" "}
              <strong>dev org sends only to these addresses</strong> — everything else is dropped,
              and the drop is silent: campaigns schedule, run, and reach no one. This is the only
              screen that can set the list, so it cannot be left for later.
            </div>
            {devNeedsAllowlist && (
              <div className="err">
                A dev org with an empty allowlist can never deliver a message. Add at least one
                entry, or choose <code>prod</code>.
              </div>
            )}
            {badEntries.length > 0 && (
              <div className="err">
                Not a form the send guard matches: {badEntries.join(", ")}. Use{" "}
                <code>name@example.com</code> or <code>@example.com</code> — a bare domain or a{" "}
                <code>*@</code> wildcard matches nothing and would deny the address it looks like it
                allows.
              </div>
            )}
          </label>
        )}
      </div>

      <div className="card">
        <label>
          <input type="checkbox" checked={form.magicLinks} onChange={(e) => set({ magicLinks: e.target.checked })} />{" "}
          Magic-link tokens
        </label>
        <div className="muted">
          Off means addressium just sends email — no user pool, no signing key, no entitlement
          plumbing. On requires an existing Cognito pool: the token carries that pool&rsquo;s
          <code>sub</code> so a paywall can resolve the reader client-side.
        </div>
        {form.magicLinks && (
          <label>
            Existing subscriber pool id
            <input value={poolId} onChange={(e) => setPoolId(e.target.value)} placeholder="us-east-1_abc123" />
            <div className="muted">
              addressium links to your pool and never creates one — a pool carries far more
              configuration than this application should own.
            </div>
          </label>
        )}
      </div>

      <button className="btn" disabled={!canSubmit} onClick={submit}>
        {busy ? "Provisioning…" : "Create organization"}
      </button>
      {msg && <div className="error" style={{ marginTop: 8 }}>{msg}</div>}

      {result && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>{result.alreadyExisted ? "Already existed" : "Created"}: {result.orgId}</strong>
          <div className="muted">
            {result.setupComplete
              ? "SES identity verified."
              : "Publish these DNS records — the org cannot send until SES verifies the domain."}
          </div>
          <table className="table">
            <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Why</th></tr></thead>
            <tbody>
              {/* The `Why` column is load-bearing, not decoration (#200): a
                  missing MAIL FROM MX record and a DMARC policy parked at
                  p=none both fail SILENTLY — mail keeps flowing, and the
                  protection everyone assumes is there is not. A table of
                  eight indistinguishable rows is how that happens. */}
              {result.dns.map((r, i) => (
                <tr key={i}>
                  <td>{r.type}</td>
                  <td><code>{r.name}</code></td>
                  <td><code>{r.value}</code></td>
                  <td className="muted">{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
