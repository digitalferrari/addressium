/**
 * Identity & pools (`demo/index.html`, `data-screen="identity"`).
 *
 * Most values here are read-only: provisioning writes them, while the signing
 * key has an explicit rotation action that retains old public keys. The screen
 * therefore renders VALUES, not disabled inputs — a greyed
 * text box invites an operator to look for the Save button that will never
 * exist, and the prototype's `readonly` inputs are a mockup convention rather
 * than a design for a console that has no write path.
 *
 * The screen's actual job is making long opaque identifiers readable: a KMS key
 * ARN, two Cognito pool ids and a JWKS URL are the kind of string an operator
 * copies into another system and never reads. Each is shown middle-truncated at
 * a monospace width that keeps the meaningful ends visible, with the full value
 * on hover and a copy button that yields it exactly.
 *
 * Nothing here is masked. The temptation is to treat the KMS ARN as a secret; it
 * is not one. An ARN is a resource NAME — the private key never leaves KMS — and
 * this screen already sits behind `identity:manage`, the capability that created
 * the key. Masking it would cost the operator the one thing they came for (a
 * value to copy into an IAM policy) and protect nothing, since anyone who can
 * load this page can also read it from the API response. The same goes for the
 * join key, which is a description of a field mapping and not a credential at
 * all. There is no secret on this screen to hide, and pretending otherwise would
 * teach operators that the masking on screens that DO show secrets is decorative.
 */
import { useState } from "react";
import { useAsync } from "../useAsync.js";
import { absoluteApiUrl, api } from "../api.js";
import { adminPoolConfig } from "../auth.js";
import { SkeletonCard } from "../Skeleton.js";

/**
 * Middle-truncate for display, keeping both ends.
 *
 * Both ends, never a trailing ellipsis: these strings are distinguished by their
 * tails (`…:key/8f2c`, `…_A9dK2xQ0p`), so a head-only truncation renders every
 * ARN in the account identically.
 */
function middleTruncate(value: string, max = 44): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** A labelled identifier: readable on screen, exact on the clipboard. */
function IdField({ label, value, hint }: { label: string; value?: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access can be denied (insecure origin, permission policy).
      // The full value is already in the `title`, so the operator can still
      // select it by hand — a thrown error here would blank the screen.
      setCopied(false);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11.5, letterSpacing: 0.02 }}>
        {label}
      </div>
      {value ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <code
            title={value}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              padding: "7px 9px",
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              color: "var(--ink)",
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {middleTruncate(value)}
          </code>
          <button
            className="btn ghost"
            style={{ flex: "none", fontSize: 11.5, padding: "5px 9px" }}
            onClick={() => void copy()}
            title={`Copy ${label}`}
            aria-label={`Copy ${label}`}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : (
        <div
          className="muted"
          style={{
            fontSize: 12.5,
            padding: "7px 9px",
            borderRadius: 7,
            border: "1px dashed var(--border)",
            fontStyle: "italic",
          }}
        >
          not configured
        </div>
      )}
      {hint && (
        <div className="muted" style={{ fontSize: 11 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function Pill({ tone, children }: { tone: "accent" | "neutral" | "warn"; children: React.ReactNode }) {
  const palette = {
    accent: { color: "var(--accent-ink)", background: "var(--accent-soft)" },
    neutral: { color: "var(--ink-2)", background: "var(--surface-3)" },
    warn: { color: "var(--warn)", background: "var(--warn-soft)" },
  }[tone];
  return (
    <span
      style={{
        ...palette,
        flex: "none",
        fontSize: 11,
        fontWeight: 650,
        padding: "3px 9px",
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Note({ tone, children }: { tone: "info" | "warn"; children: React.ReactNode }) {
  const warn = tone === "warn";
  return (
    <div
      style={{
        display: "flex",
        gap: 9,
        fontSize: 12.5,
        lineHeight: 1.55,
        padding: "10px 12px",
        borderRadius: 8,
        color: warn ? "var(--warn)" : "var(--ink-2)",
        background: warn ? "var(--warn-soft)" : "var(--surface-2)",
        border: `1px solid ${warn ? "var(--warn)" : "var(--border)"}`,
      }}
    >
      <span style={{ flex: "none" }}>{warn ? "⚠" : "▹"}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

const CARD: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 11 };
const GRID2: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
  gap: 14,
};

export function Identity({ org }: { org: string }) {
  const [refresh, setRefresh] = useState(0);
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateMessage, setRotateMessage] = useState("");
  const { data, error, loading } = useAsync(
    () => (org ? api.orgIdentity(org) : Promise.resolve(null)),
    [org, refresh],
  );
  const pool = adminPoolConfig();

  const rotate = async () => {
    if (!window.confirm("Rotate this organization's magic-link signing key? Existing links will continue to verify.")) return;
    setRotateBusy(true);
    setRotateMessage("");
    try {
      const result = await api.rotateMagicLinkKey(org);
      setRotateMessage(`Key rotated. ${result.keyCount} public keys remain available for verification.`);
      setRefresh((value) => value + 1);
    } catch (e) {
      setRotateMessage(String(e));
    } finally {
      setRotateBusy(false);
    }
  };

  return (
    <div>
      <h1 className="h1">Identity &amp; pools · {org || "—"}</h1>
      <p className="muted" style={{ marginTop: -6, maxWidth: 760 }}>
        Magic-link signing, plus the optional Cognito pool this organization can{" "}
        <b>link</b>. Held on the organization record. Written at provisioning time and{" "}
        <b>mostly read-only here</b> — the only update is deliberate magic-link
        signing-key rotation; pool, domain and issuer configuration remain fixed.
      </p>

      {loading && <SkeletonCard lines={3} />}
      {error && <p className="err">{error}</p>}

      {!loading && !error && (
        <>
          <div style={GRID2}>
            <div className="card" style={CARD}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div className="muted" style={{ fontWeight: 650, fontSize: 12 }}>
                  Admin user pool · staff
                </div>
                <Pill tone="accent">shared across orgs</Pill>
              </div>
              <IdField label="User pool ID" value={pool.poolId} />
              <IdField label="App client ID" value={pool.clientId} />
              <IdField label="Hosted UI domain" value={pool.hostedUiDomain} />
              <Note tone="info">
                The pool this console signs you in to. It is <b>stack-level</b>, not part of any
                organization — one pool of staff operators serving every org — so it is read from
                this console's own build configuration rather than from the organization record.
                A field reading <i>not configured</i> means that build-time value was not set;
                the pool ID is display-only, while sign-in requires the Hosted UI domain and app client ID.
              </Note>
            </div>

            <div className="card" style={CARD}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div className="muted" style={{ fontWeight: 650, fontSize: 12 }}>
                  Subscriber user pool
                </div>
                <Pill tone="neutral">optional · linked, never created</Pill>
              </div>
              <IdField
                label="Linked user pool ID"
                value={data?.subscriberPoolId}
                hint={data && !data.subscriberPoolId ? "No pool linked — magic links are off for this organization." : undefined}
              />
              <IdField
                label="Join key"
                value="Subscriber.externalId ↔ pool sub"
                hint="How a subscriber row is matched to a pool user. Not a credential."
              />
              <Note tone="info">
                addressium <b>references</b> this pool — it does not own it and never creates it;
                the subscriber-pool linking path does not create a pool. Linking
                validates it with <code>DescribeUserPool</code> and nothing more. An organization
                with magic links off has no pool at all and runs a list fine.
              </Note>
            </div>
          </div>

          <div className="card" style={{ ...CARD, gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div className="muted" style={{ fontWeight: 650, fontSize: 12 }}>
                Magic-link signing
              </div>
              {data && (
                <Pill tone={data.magicLink.enabled ? "accent" : "neutral"}>
                  {data.magicLink.enabled ? "on" : "off for this organization"}
                </Pill>
              )}
            </div>

            {data?.magicLink.enabled ? (
              <>
                <div style={GRID2}>
                  <IdField label="KMS key ARN (ES256)" value={data.magicLink.kmsKeyArn} />
                  <IdField
                    label="JWKS URL"
                    value={absoluteApiUrl(data.magicLink.jwksPath)}
                    hint="Public — no login. This is what an org's website fetches to verify a token."
                  />
                  <IdField label="Issuer (iss)" value={data.magicLink.issuer} />
                  <IdField label="Audience (aud)" value={data.magicLink.audience} />
                  <IdField
                    label="Key ID (kid)"
                    value={data.magicLink.kid}
                    hint="Identifies the signing key inside this organization's JWKS."
                  />
                </div>
                <Note tone="info">
                  The <b>JWKS endpoint is scoped to this organization</b>: it publishes this
                  org's current and retained public signing keys. Verifiers must also check the expected issuer,
                  audience and token expiry.
                </Note>
                <div className="row" style={{ alignItems: "center" }}>
                  <button className="btn" disabled={rotateBusy} onClick={() => void rotate()}>
                    {rotateBusy ? "Rotating…" : "Rotate signing key"}
                  </button>
                  <span className="muted">{data.magicLink.keyCount} public key{data.magicLink.keyCount === 1 ? "" : "s"} published</span>
                  {data.magicLink.rotatedAt && <span className="muted">Last rotated {new Date(data.magicLink.rotatedAt).toLocaleString()}</span>}
                </div>
                {rotateMessage && <p className={rotateMessage.startsWith("Key rotated") ? "muted" : "err"}>{rotateMessage}</p>}
              </>
            ) : (
              /*
               * The prototype only draws the ON state. Absent `magicLink` is the
               * documented feature-off configuration, and rendering it as four
               * empty fields would read as a broken or half-provisioned silo —
               * which is the single most likely misreading of this screen.
               */
              <Note tone="info">
                Magic links are <b>off</b> for this organization, which is a complete and valid
                configuration — not a missing step. It has <b>no signing key, no linked pool, no
                token</b>. Its public JWKS endpoint returns an empty key set. Editorial links
                render untokenized (still click-tracked); sending also depends on SES readiness.
                An org gets its own KMS signing key only when the
                feature is turned on, at provisioning time.
              </Note>
            )}

            <Note tone="info">
              Key rotation creates a new KMS key, makes it current for new tokens, and retains
              previous public keys in JWKS so links already in readers' inboxes continue to work.
              The private keys never leave KMS. The linked pool, domain and issuer remain unchanged.
            </Note>
          </div>
        </>
      )}
    </div>
  );
}
