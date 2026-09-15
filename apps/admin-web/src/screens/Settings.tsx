/**
 * Settings — the deployment configuration for one organization, gathered into
 * five tabs.
 *
 * Three of the five are NOT reimplemented here. Alerts, Privacy and Team each
 * already have a screen module that is exactly the tab the design asks for, and
 * a second implementation of any of them would be a second writer of the same
 * record with none of the guards the first one grew: `Deliverability` alone
 * knows that a null config means UNPROTECTED rather than zeroed thresholds and
 * that `haltAt` below `warnAt` has to be caught per-row; `Team` alone knows the
 * server's "last enabled developer admin" refusal has to reach the operator
 * verbatim. So those tabs mount the existing components. The two tabs this
 * module actually authors are Domains and Magic-link, because nothing else
 * renders them.
 *
 * A consequence of mounting them: each brings its own heading, so the Alerts
 * pane is titled "Deliverability" and the Privacy pane "Data requests". That is
 * left alone deliberately. They ARE those screens — the same component, reached
 * a second way — and a title that matches the one in the nav tells an operator
 * which of the two routes they are looking at, where a suppressed heading would
 * imply Settings owns a configuration surface it does not.
 *
 * Tabs are capability-gated HERE, which nav-level screens never have to be.
 * Every other screen is hidden by `NavItem`'s `cap`, so it never renders for
 * someone the API will 403 — but Settings is reachable by anyone and its tabs
 * span four different capabilities. An analyst opening it and finding
 * Team 403'd into a red box would be the console blaming them for a door it
 * drew. A tab the grant cannot use is not rendered at all.
 */
import { useState } from "react";
import { useAsync } from "../useAsync.js";
import { api } from "../api.js";
import { can, type Capability, type Grant } from "../rbac.js";
import { Deliverability } from "./Deliverability.js";
import { Privacy } from "./Privacy.js";
import { Team } from "./Team.js";

type TabId = "domains" | "magic" | "alerts" | "privacy" | "team";

const TABS: { id: TabId; label: string; cap: Capability }[] = [
  { id: "domains", label: "Domains & deliverability", cap: "reports:view" },
  { id: "magic", label: "Magic-link & entitlement", cap: "reports:view" },
  { id: "alerts", label: "Alerts & SNS", cap: "alerts:manage" },
  { id: "privacy", label: "Privacy & data", cap: "subscribers:manage" },
  { id: "team", label: "Team", cap: "team:manage" },
];

export function Settings({ org, grant }: { org: string; grant: Grant | null }) {
  const visible = TABS.filter((t) => can(grant, t.cap, org));
  const [tab, setTab] = useState<TabId>("domains");
  // The remembered tab can fall out of the visible set when the org switches —
  // `can` is org-scoped, so a member of two orgs with different roles would
  // otherwise land on a blank pane rather than on a tab they can use.
  const active = visible.some((t) => t.id === tab) ? tab : visible[0]?.id;

  if (visible.length === 0) {
    return (
      <div>
        <h1 className="h1">Settings</h1>
        <p className="muted">Your role has no settings to configure for this organization.</p>
      </div>
    );
  }

  return (
    <div>
      {/* h1, not h2: the tabs that mount an existing screen bring that screen's
          own h2 with them, and a page title below its children's headings is a
          document outline no screen reader can make sense of. */}
      <h1 className="h1">Settings</h1>
      <p className="muted">Deployment configuration for this organization.</p>

      <div className="tabs" role="tablist" style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0" }}>
        {visible.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={active === t.id ? "btn" : "btn ghost"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active === "domains" && <DomainsTab org={org} />}
      {active === "magic" && <MagicLinkTab org={org} />}
      {active === "alerts" && <Deliverability org={org} />}
      {active === "privacy" && <Privacy org={org} />}
      {active === "team" && <TeamTab org={org} />}
    </div>
  );
}

/**
 * Sending domains, plus an honest account of what the console cannot tell you
 * about them.
 *
 * The list itself is real: `GET /orgs/{org}` projects the org record's
 * `domains`, and provisioning creates one SES domain identity and one
 * configuration set per entry, unconditionally. What is NOT here is the
 * verification readout — see the note below, which is the whole reason this tab
 * is two cards rather than one table.
 */
function DomainsTab({ org }: { org: string }) {
  const loaded = useAsync(() => api.orgMeta(org), [org]);

  if (loaded.loading) return <div className="muted">Loading…</div>;
  if (loaded.error) return <div className="error">{loaded.error}</div>;

  const domains = loaded.data?.domains ?? [];

  return (
    <div>
      <div className="card">
        <h3>Sending domains</h3>
        {domains.length === 0 ? (
          <p className="muted">
            No sending domain on this organization. This is the setup checklist&rsquo;s first
            required step, and until it passes there is no SES identity to send from. A domain is
            set when the organization is created and cannot be added from this screen.
          </p>
        ) : (
          <table className="table">
            {/*
              Two columns, not three. There was a third reading "Created at
              provisioning" for every row, and nothing was read to establish it:
              a provisioning run that failed partway, or a domain appended to the
              record afterwards, printed the same confident sentence as a healthy
              one. Whether an SES identity exists for a name is a live SES fact,
              and `Setup` → `<SendingIdentity>` is the screen that actually reads
              it (`GET /orgs/{org}/sending-identity`). It is not restated here
              from nothing.
            */}
            <thead>
              <tr>
                <th>Domain</th>
                <th>On the org record</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d, i) => (
                <tr key={d}>
                  <td>
                    <code>{d}</code>
                    {i === 0 && <div className="muted">Primary — the envelope sender aligns to this one.</div>}
                  </td>
                  <td>
                    <code>domains[{i}]</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Provisioning is what creates an SES domain identity — with the DKIM records for you to
          publish — and a configuration set, one of each per name on this list. Whether it
          <em> succeeded</em> for any given name is not something this table knows: all it reads is{" "}
          <code>GET /orgs/{"{org}"}</code>, which returns the names on the organization record and
          nothing about SES.
        </p>
      </div>

      <div className="card">
        <h3>Verification &amp; quota</h3>
        {/*
          This card used to say verification and quota were unreadable from the
          console and that the admin router held no SES grant. That stopped
          being true at #285: `GET /orgs/{org}/sending-identity` reads SES live,
          and the admin function carries both `ses:GetEmailIdentity` and
          `ses:GetAccount` (control-plane-stack.ts). The readout is NOT
          duplicated here — `<SendingIdentity>` on Setup is tri-state
          throughout (verified / pending / could-not-check, and a quota that is
          "not reported" rather than 0), and a second renderer of the same
          response would be a second place for those distinctions to be lost.
          So this points at it instead of restating it.
        */}
        <p className="muted">
          <strong>Shown on Setup, read live from SES.</strong> Per-domain verification and DKIM
          state, whether this account has left the SES sandbox, and the account send quota and
          send rate all come from <code>GET /orgs/{"{org}"}/sending-identity</code> on the{" "}
          <strong>Setup</strong> screen. They are not repeated here, so there is one place that
          renders them and one set of rules for what an unreadable check looks like.
        </p>
        <p className="muted">
          That route is gated on <code>identity:manage</code> — the account sandbox and quota
          describe the whole deployment rather than this organization — so a role without it sees
          the Domains list above and not the SES state.
        </p>
        <p className="muted">
          <strong>DMARC is still not shown anywhere.</strong> SES reports DKIM and the custom MAIL
          FROM (the SPF-alignment leg) and nothing else; <code>_dmarc</code> is a TXT record on
          your own zone that SES never reads back. Check it with a DNS lookup.
        </p>
        <p className="muted">
          The setup checklist&rsquo;s &ldquo;sending domain&rdquo; step still means only that a
          domain is on the org record — not that it has verified. That is what the live check is
          for.
        </p>
      </div>
    </div>
  );
}

/**
 * Magic-link & entitlement — documentation, because there is nothing to
 * configure.
 *
 * Every value below is a constant in the signing path rather than a setting:
 * `JoseMagicLinkSigner` / `KmsMagicLinkSigner` emit a fixed claim set, the
 * algorithm is ES256 against a per-org KMS key, and the TTL is a deployment
 * environment variable, not a per-org field. The design draws a "sync source of
 * truth" dropdown and a last-sync line next to these; both are invented — no
 * store holds either — so neither is rendered. Controls the backend does not
 * have are worse than no controls: they teach an operator that a setting exists.
 */
function MagicLinkTab({ org }: { org: string }) {
  const loaded = useAsync(() => api.orgMeta(org), [org]);

  const enabled = loaded.data?.magicLinkEnabled;

  return (
    <div>
      <div className="card">
        <h3>Magic-link tokens</h3>
        {loaded.loading ? (
          <div className="muted">Loading…</div>
        ) : loaded.error ? (
          // The claim table below is true of the deployment either way, but
          // whether THIS org mints tokens is a fact we just failed to read —
          // and `enabled` is `undefined` here, which would otherwise fall
          // through to the "magic links are on" copy and assert it anyway.
          <div className="error">Could not read this organization&rsquo;s configuration: {loaded.error}</div>
        ) : enabled === false ? (
          <p className="muted">
            <strong>Magic links are off for this organization.</strong> It has no linked subscriber
            pool and no signing key, so editorial links render untokenized — still click-tracked,
            just carrying no entitlement. The feature is turned on when the organization is
            created, not here.
          </p>
        ) : (
          <p className="muted">
            Per-recipient tokens that let the operator&rsquo;s own website recognise a reader and
            their entitlement from the link alone, with no call back to addressium.
          </p>
        )}

        <table className="table">
          <tbody>
            <tr>
              <td>Signing</td>
              <td>
                Asymmetric <code>ES256</code>, per-org key in KMS. The private key never leaves KMS.
              </td>
            </tr>
            <tr>
              <td>Public keys</td>
              <td>
                <code>/orgs/{org || "{org}"}/.well-known/jwks.json</code>
                <div className="muted">
                  Per organization, not one deployment-wide set — but at the standard{" "}
                  <code>.well-known</code> path under the org, which is the route the deployment
                  actually serves (unauthenticated). An org with magic links off serves a valid
                  empty JWKS rather than a 404.
                </div>
              </td>
            </tr>
            <tr>
              <td>Placement</td>
              <td>
                URL fragment <code>#tok=</code>
                <div className="muted">A fragment is never sent to the server in a request line.</div>
              </td>
            </tr>
            <tr>
              <td>Scope</td>
              <td>
                <code>content:read</code>
              </td>
            </tr>
            <tr>
              <td>Lifetime</td>
              <td>
                14 days by default
                <div className="muted">
                  Deployment-wide (<code>MAGIC_TTL_SECONDS</code>), not per organization — this
                  screen cannot read the value the sender was deployed with.
                </div>
              </td>
            </tr>
            <tr>
              <td>Redemption</td>
              <td>
                Reusable and stateless — nothing is recorded when one is used
                <div className="muted">
                  Which makes it forwardable by design. <code>content:read</code> is the whole
                  point of the narrow scope: the operator&rsquo;s site must keep profile and
                  account pages behind its own step-up auth.
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Claims</h3>
        <p className="muted">
          A closed set. Both signers emit exactly these and there is no extension point, so claim
          minimisation holds by construction rather than by policy — no profile field, no name, no
          address, can be put into a URL-borne token.
        </p>
        <p>
          {["sub", "external_sub", "scope", "amr", "entitlement", "entitlement_asof", "aud", "iss", "iat", "exp"].map(
            (c) => (
              <code key={c} style={{ marginRight: 8 }}>
                {c}
              </code>
            ),
          )}
        </p>
        <p className="muted">
          <code>sub</code> is addressium&rsquo;s subscriber id; <code>external_sub</code> is the
          reader&rsquo;s subject in the organization&rsquo;s own linked pool. With both, plus{" "}
          <code>entitlement</code>, a paywall resolves reader and access with zero calls back here.
        </p>
      </div>
    </div>
  );
}

/**
 * The Team tab is the Team screen, with one thing said around it.
 *
 * The design's table carries MFA and "Last active" columns that the team model
 * does not have — `TeamMemberRow` is member, role, orgs, enabled, status — and
 * both would need Cognito reads that no route makes. Saying so is cheaper than
 * either fabricating the columns or silently dropping them and leaving the next
 * person to wonder whether they were forgotten.
 */
function TeamTab({ org }: { org: string }) {
  return (
    <div>
      <Team org={org} />
      <div className="card">
        <p className="muted">
          <strong>MFA status and last activity are not shown.</strong> Neither is part of the team
          record — both are Cognito user attributes, and no route reads them, so the columns the
          design draws for them would be invented. The user pool is where MFA enrolment and
          sign-in history can be seen today.
        </p>
      </div>
    </div>
  );
}
