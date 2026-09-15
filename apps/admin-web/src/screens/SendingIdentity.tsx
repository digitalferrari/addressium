/**
 * "Can this organization actually send?" — the live SES readout (#285,
 * GitHub #285).
 *
 * Everything else on the Setup screen is derived from our own table, so the
 * checklist's "sending domain" step means only `org.domains.length > 0`. The
 * two facts that decide whether SES accepts a message live in SES:
 *
 *  - the domain identity has finished verifying, and
 *  - the ACCOUNT has production access — outside the sandbox, where it may only
 *    mail addresses it has itself verified.
 *
 * The sandbox is the one that caused a public failure: a subscriber typed a
 * valid address, SES refused it, and the refusal surfaced on the signup page
 * while the console showed a green checklist. This card is where an operator
 * now sees the cause.
 *
 * ## Why there is no green/red badge
 *
 * Because there are three answers and a badge can only carry two. `unknown`
 * means the check could not RUN — the admin router's SES grant is missing, SES
 * throttled us, the call timed out — and it is rendered as its own thing, with
 * the reason SES gave attached. Painting it red would tell an operator their
 * DNS is broken when their IAM policy is; painting it green would be worse. The
 * same rule governs `canSend === undefined`: the headline says the check did not
 * complete, never "cannot send".
 *
 * Every value shown here comes from one API response and nothing is defaulted.
 * An absent quota renders as "not reported", not as 0.
 *
 * ## Deliberately absent: DMARC
 *
 * SES reports DKIM and the custom MAIL FROM (the SPF-alignment leg) and nothing
 * else. `_dmarc` is a TXT record on the operator's own zone that SES neither
 * owns nor reads back, so there is no column for it — the design's DMARC column
 * has no source behind it, and a pill reading `p=none` would be invented.
 */
import { useAsync } from "../useAsync.js";
import { api, type DomainIdentityStatus, type SendingIdentityReport } from "../api.js";

type Tone = "good" | "warn" | "crit" | "neutral";

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const palette: Record<Tone, React.CSSProperties> = {
    good: { background: "var(--good-soft)", color: "var(--good)" },
    warn: { background: "var(--warn-soft)", color: "var(--warn)" },
    crit: { background: "var(--warn-soft)", color: "var(--crit)" },
    neutral: { background: "var(--surface-3)", color: "var(--ink-2)" },
  };
  return (
    <span className="pill" style={palette[tone]}>
      <span className="dot" />
      {children}
    </span>
  );
}

/**
 * The per-domain verdict, in words an operator can act on.
 *
 * `unknown` is `neutral`, never `warn`: a warning colour is a claim about the
 * domain, and the whole point of this state is that we have no claim to make.
 */
function domainPill(d: DomainIdentityStatus) {
  switch (d.state) {
    case "verified":
      return <Pill tone="good">Verified</Pill>;
    case "pending":
      return <Pill tone="warn">Pending — publish DKIM</Pill>;
    case "failed":
      return <Pill tone="crit">Verification failed</Pill>;
    case "not_found":
      return <Pill tone="crit">No SES identity</Pill>;
    case "unknown":
      return <Pill tone="neutral">Could not check</Pill>;
  }
}

/** What the operator should do about each state. Empty for a verified domain. */
function domainAdvice(d: DomainIdentityStatus): string {
  switch (d.state) {
    case "verified":
      return "";
    case "pending":
      return "SES is waiting on DNS. Publish the three DKIM CNAMEs printed when this organization was created.";
    case "failed":
      return "SES tried to verify and gave up. Re-check the DKIM CNAMEs — a typo or a proxied record is the usual cause.";
    case "not_found":
      return "This domain is on the organization record but SES has no identity for it. Publishing DNS will not help; the identity itself is missing.";
    case "unknown":
      return d.reason ?? "The check did not complete. This says nothing about the domain.";
  }
}

/** A number SES reported, or an honest blank. Never a zero we invented. */
function num(v: number | undefined): string {
  if (v === undefined) return "not reported";
  // SES reports -1 for an unlimited quota. Printing "-1" would read as an error.
  if (v === -1) return "unlimited";
  return v.toLocaleString();
}

/**
 * The headline. Three outcomes, because `canSend` is tri-state — see the module
 * comment on why an undefined must never render as "no".
 */
function Headline({ report }: { report: SendingIdentityReport }) {
  if (report.canSend === true) {
    return (
      <div className="row">
        <Pill tone="good">Can send</Pill>
        <span className="muted">
          The account has production access and at least one domain is verified. SES will accept
          mail to any recipient.
        </span>
      </div>
    );
  }
  if (report.canSend === undefined) {
    return (
      <div className="row">
        <Pill tone="neutral">Could not determine</Pill>
        <span className="muted">
          At least one check did not complete, so this is <b>not</b> a finding about sending — see
          the reasons below. Until they clear, the SES console is the source of truth.
        </span>
      </div>
    );
  }
  return (
    <div className="row">
      <Pill tone="crit">Cannot send to arbitrary recipients</Pill>
      <span className="muted">
        {report.account.productionAccess === false
          ? "This account is in the SES sandbox: it may only mail addresses it has itself verified. A valid subscriber address will be refused, and the refusal reaches the public signup page."
          : report.account.sendingEnabled === false
            ? "SES has paused sending for this account entirely."
            : "No sending domain has finished verifying, so there is no identity to send from."}
      </span>
    </div>
  );
}

export function SendingIdentity({ org }: { org: string }) {
  const { data, error, loading } = useAsync(
    () => (org ? api.sendingIdentity(org) : Promise.resolve(null)),
    [org],
  );

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <b>Sending identity · live from SES</b>
        <span className="muted" style={{ fontSize: 12 }}>
          Read on every load — never cached
        </span>
      </div>

      {loading && <div className="muted">Checking SES…</div>}
      {/*
        Two different failures, and telling them apart is the whole point.

        A 403 is the SERVER's RBAC refusing this caller: the route is gated on
        `identity:manage` (the sandbox and the account quota describe the whole
        deployment, not this org's numbers), while the Setup screen around it is
        `reports:view`. An analyst reaching this card is a normal, correct
        outcome, not a broken check — so it says who can see it rather than
        showing a raw status line. The server is the boundary; this branch only
        makes its answer readable.

        Anything else means the console could not ask at all, which is not
        evidence about the domains — so no verdict is rendered in its place.
      */}
      {error && /→ 403/.test(error) && (
        <p className="muted">
          <b>Not visible to your role.</b> Live SES verification and account state need{" "}
          <code>identity:manage</code> — the same capability that provisioned this
          organization&rsquo;s sending domain. Everything else on this page is unaffected.
        </p>
      )}
      {error && !/→ 403/.test(error) && (
        <>
          <p className="err">{error}</p>
          <p className="muted">
            The console could not reach this check. That says nothing about whether the
            organization can send — read the SES console directly until it clears.
          </p>
        </>
      )}

      {data && (
        <>
          <Headline report={data} />

          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ marginBottom: 6 }}>
              <b>Account</b> — these describe the whole deployment&rsquo;s SES account in its
              region, not this organization alone.
            </div>
            {data.account.reason ? (
              /*
               * The account read failed. Show WHY and show nothing else: an
               * absent quota rendered as 0, or an unreadable sandbox state
               * rendered as "sandbox", would both be assertions we cannot make.
               */
              <div className="row">
                <Pill tone="neutral">Could not check</Pill>
                <span className="muted">{data.account.reason}</span>
              </div>
            ) : (
              <table>
                <tbody>
                  <tr>
                    <td className="t-strong" style={{ width: 210 }}>
                      Production access
                    </td>
                    <td>
                      {data.account.productionAccess === undefined ? (
                        <span className="muted">not reported</span>
                      ) : data.account.productionAccess ? (
                        <Pill tone="good">Out of the sandbox</Pill>
                      ) : (
                        <Pill tone="crit">In the SES sandbox</Pill>
                      )}
                    </td>
                    <td className="muted">
                      In the sandbox, SES accepts mail only to addresses the account has itself
                      verified.
                    </td>
                  </tr>
                  <tr>
                    <td className="t-strong">Sending</td>
                    <td>
                      {data.account.sendingEnabled === undefined ? (
                        <span className="muted">not reported</span>
                      ) : data.account.sendingEnabled ? (
                        <Pill tone="good">Enabled</Pill>
                      ) : (
                        <Pill tone="crit">Paused by SES</Pill>
                      )}
                    </td>
                    <td className="muted">
                      {data.account.enforcementStatus
                        ? `Enforcement status: ${data.account.enforcementStatus}`
                        : ""}
                    </td>
                  </tr>
                  <tr>
                    <td className="t-strong">Send quota (24h)</td>
                    <td>{num(data.account.max24HourSend)}</td>
                    <td className="muted">
                      {data.account.sentLast24Hours === undefined
                        ? ""
                        : `${num(data.account.sentLast24Hours)} sent in the last 24 hours`}
                    </td>
                  </tr>
                  <tr>
                    <td className="t-strong">Max send rate</td>
                    <td>
                      {data.account.maxSendRate === undefined
                        ? "not reported"
                        : `${num(data.account.maxSendRate)}/second`}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            )}
          </div>

          <div style={{ marginTop: 18 }}>
            <div className="muted" style={{ marginBottom: 6 }}>
              <b>Sending domains</b> — one SES identity per name on the organization record.
            </div>
            {data.domains.length === 0 ? (
              <p className="muted">
                No sending domain on this organization&rsquo;s record — the failing{" "}
                <b>Sending domain</b> step above. Nothing to check in SES yet.
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Verification</th>
                    <th>DKIM</th>
                    <th>MAIL FROM (SPF alignment)</th>
                    <th>What to do</th>
                  </tr>
                </thead>
                <tbody>
                  {data.domains.map((d) => (
                    <tr key={d.domain}>
                      <td className="t-strong">{d.domain}</td>
                      <td>{domainPill(d)}</td>
                      <td className="muted">{d.dkimStatus ?? "not reported"}</td>
                      <td className="muted">
                        {d.mailFromDomain
                          ? `${d.mailFromDomain} · ${d.mailFromStatus ?? "status not reported"}`
                          : "none configured"}
                      </td>
                      <td className="muted">{domainAdvice(d) || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="muted" style={{ marginTop: 14 }}>
            <b>DMARC is not shown, and cannot be from here.</b> SES reports DKIM and the custom
            MAIL FROM; the <code>_dmarc</code> record is a TXT entry on your own zone that SES
            never reads back. Check it with a DNS lookup — a domain published at{" "}
            <code>p=none</code> has DMARC records but no DMARC protection.
          </p>
        </>
      )}
    </div>
  );
}
