# addressium — Security Design & Threat Model

> How addressium protects subscriber data, sending reputation, and its
> multi-tenant boundaries. Every control here maps to a **public, named
> standard** so it can be independently reviewed — nothing bespoke.

- **Status:** Design-level, tracking
  [`DESIGN-COMPENDIUM.md`](./DESIGN-COMPENDIUM.md) revision 2. Nothing has ever
  been deployed (compendium §9). Where r2 decided a control that the CDK does
  not yet build, it carries the inline tag **[Decided r2 — not yet built]**.
  Read an untagged control as present in the synthesized stack today, and a
  tagged one as a decision, not a protection you currently have.
- **Companion docs:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) (system design),
  [`../SECURITY.md`](../SECURITY.md) (how to report a vulnerability).
- **Audience:** contributors, security reviewers, and operators self-hosting
  addressium.

---

## 1. Principles & standards

Secure-by-default, defense-in-depth, least privilege, and **no home-grown
crypto** (KMS + a vetted JOSE library, never our own). We hold ourselves to:

| Area | Standard |
|---|---|
| Application requirements | OWASP **ASVS** (target **Level 2**), OWASP **Top 10 (2021)**, **Proactive Controls** |
| APIs | OWASP **API Security Top 10 (2023)** |
| Tokens & identity | NIST **SP 800-63B**; **RFC 8725** (JWT BCP); RFC **7519/7515/7517/7518**; **RFC 7636** (PKCE); RFC **6749/6819** (OAuth 2.0) |
| Email authentication | **SPF** (7208), **DKIM** (6376), **DMARC** (7489), **ARC** (8617), **BIMI**, **RFC 8058** (one-click unsubscribe) |
| Cloud | AWS **Well-Architected Security Pillar**; **CIS AWS Foundations Benchmark** |
| Governance | NIST **CSF 2.0** / **SP 800-53**; **STRIDE** threat modeling |
| Frontend | OWASP **Secure Headers**; **CSP Level 3** |
| Supply chain | **SLSA**, **OpenSSF Scorecard** + **Best Practices Badge**, **Sigstore/cosign**, **SBOM** (CycloneDX/SPDX) |

---

## 2. Assets & trust boundaries

**Crown-jewel assets:** subscriber PII · SES **sending reputation** · magic-link
**signing keys** · admin access · entitlement data · **cross-org isolation**.

**Trust boundaries** (each crossing is an authorization decision):

```
Internet ─▶ Public plane (unauth)  ─▶ Subscriber plane (signed action tokens)
                                    ─▶ Admin plane (admin pool + RBAC + org scope)
Main website ◀── JWKS / magic-link token boundary (client-side verify)
AWS account boundary ─▶ per-org silos (orgId partition + per-org KMS key + SES identity)
Build/release ─▶ self-hosted deployment (supply chain)
```

**Adversaries:** external abuser (signup/list-bombing, token forgery,
denial-of-wallet), compromised/malicious admin, cross-tenant attacker, a
forwarded-email recipient, and a poisoned dependency in the supply chain.

---

## 3. Threat model (STRIDE per boundary)

| Boundary | Top threats (STRIDE) | Primary controls |
|---|---|---|
| Public plane | Spoofing, DoS/denial-of-wallet, injection | Double opt-in, signed action tokens, zod input validation, in-app honeypot + opt-in reCAPTCHA on `/signup*` (#40); edge rate limits and a WAF CAPTCHA rule are **operator-supplied** (#225) — the stack creates no WebACL, so an unconfigured deploy is genuinely unprotected |
| Magic-link / main site | **Tampering** (alg confusion, forged token), **EoP** (paywall→account) | RFC 8725 alg-pinning, per-org keys, lite scope, step-up on the main site |
| Subscriber plane | Spoofing, info disclosure | Signed, single-purpose action tokens (confirm, RFC 8058 unsubscribe) scoped to one subscriber's `sub`; a per-org Cognito pool is **optional** and, under r2, reference-only **[Decided r2 — not yet built]** |
| Admin plane | **EoP**, repudiation | Server-side RBAC + org scope, TOTP MFA, immutable audit log |
| Cross-org (tenancy) | **Info disclosure** (BOLA/BFLA) | Server-derived `orgId`, central authz, per-org keys, cross-tenant tests |
| Feeds/webhooks | **SSRF**, spoofed callbacks | Egress allowlist + private-range blocking, signature verification |
| Supply chain | Tampering (build), poisoned deps | SLSA provenance, signed releases, SBOM, pinned CI, OIDC-to-AWS |

Two rows need reading carefully, because each mixes a control we ship with one we
do not.

**Public plane — two kinds of CAPTCHA, often conflated, failing differently:**

- **The in-app bot checks are ours.** `/signup` and `/signup/batch` run a
  honeypot check and, when the org has configured `recaptchaSecretArn`,
  server-side reCAPTCHA verification (#40). These run inside the handler, on
  every request, and a tripped honeypot returns a silent `202` so a scraper
  cannot tell it was caught. They are built and tested.
- **A WAF CAPTCHA rule is the operator's**, lives at the edge, and never reaches
  our code. Under r2 addressium creates no WebACL (#30, #31, #66), so edge rate
  limiting and edge CAPTCHA exist only once the operator creates and associates
  one — see §8.

**Subscriber plane — the subscriber record is the identity, not a pool account.**
Signup is unauthenticated and creates an addressium subscriber keyed by our own
durable id; a subscriber has no Cognito user unless the org uses magic links. A
per-org subscriber pool is **optional and link-only** — addressium links to a
pool the org already owns via `Subscriber.externalId`, and the stack holds no
`CreateUserPool` permission anywhere. The linking half is real: the HMAC-verified
identity-sync webhook, `externalId` as the join key, and email-change and delete
handling are built.

The single write addressium makes into that pool is creating a **subscriber**
after their double opt-in, with a random permanent password and Cognito's
welcome email suppressed — the magic-link token carries the pool `sub`, so a
subscriber without an account would receive an unresolvable token. It lives in a
dedicated function reachable from no route (#23); the public `/confirm` handler
can only ask for it, holding `lambda:InvokeFunction` on that one function and no
Cognito permission at all. The provisioner's grant is three enumerated actions,
narrowed to exact pool ARNs when the operator names them at deploy time, with an
explicit `Deny` on the admin pool. There is no subscriber login at all,
and r2 does not call for one — the pool is the org's, not ours. The subscriber
surface is four unauthenticated routes: directory, subscribe-to-all, confirm and
unsubscribe, the last two reached by signed token. A tokenized preference centre
is **[Decided r2 — not yet built]** — there is no preference route on the API.

---

## 4. Crown-jewel controls

### 4.1 Magic-link token security — the highest-risk surface (RFC 8725)

Verification happens **client-side with a public key** (the page is
CloudFront-cached; see `ARCHITECTURE.md` §8.1), so the classic attack is
**algorithm confusion**: forging an `HS256` token that uses the *public* key
bytes as the HMAC secret, or sending `alg:none`. Requirements for **any**
verifier (ours and every integrator's):

1. **Pin the algorithm to `ES256`.** Reject anything the JWT header selects —
   never let the token choose its own algorithm or key type (RFC 8725 §2.1, §3.1).
2. **Reject `alg:none`** and all symmetric algorithms.
3. Validate `iss`, `aud`, and `exp`; honor `kid` against the JWKS. Stated
   precisely, because the reference verifier is the spec: `exp` is required
   twice over (by the JOSE library and by an explicit type check), `nbf` is
   checked only when present and addressium never mints one, and **`iat` is not
   validated at all** — no `maxTokenAge` is supplied. Clock tolerance defaults
   to 30s.
4. **Per-org signing keys** so a token minted for one silo cannot verify against
   another (`ARCHITECTURE.md` §4.11).
5. **Verify, don't decode** — an unverified base64 decode is trivially forged.
   The package exports no decode-without-verify path.
6. Enforce the **lite scope** (`scope: "content:read"`, `amr: ["magic_link"]`);
   never elevate a magic-link session — gate profile/account behind step-up.
7. Require `entitlement` to be exactly `free` or `paid`, and `sub` to be a
   non-empty string. A token missing either is **rejected**, not downgraded to
   an anonymous read — fail closed, so a malformed token can never be mistaken
   for a valid free-tier one.

The operator's paywall plugin is an **integrator, not a trusted peer**. What it
receives is the org's **public key**, fetched from the published JWKS endpoint
(`GET /orgs/{org}/.well-known/jwks.json`, unauthenticated and cacheable).
**No shared secret is ever distributed** — there is no symmetric material
anywhere in the magic-link path. This is exactly why asymmetric signing is
**mandatory rather than merely preferable**: verification happens client-side,
in a CloudFront-cached page or a third-party plugin, and a verifier in that
position cannot hold a secret. The verifying half must therefore be safe to
publish, and the signing half never leaves KMS (§4.6). A symmetric scheme would
require handing every integrator a key that also *mints* tokens.

Because integrators write the client-side half, addressium ships a **hardened
reference verifier** so nobody rolls their own: see
[`packages/magiclink-verify`](../packages/magiclink-verify/src/index.ts). Use it
verbatim in Node (custom-auth Lambda) and the browser.

For the browser there is a **drop-in** on top of it
([`browser.ts`](../packages/magiclink-verify/src/browser.ts), #215) shipped as a
self-contained bundle with a published SRI hash. Three properties are security
-relevant and are the reason it exists rather than being left to each site: it
**never throws**, so a paywall's failure path is "show the wall" rather than an
unhandled rejection; it **removes the token from the URL** with
`history.replaceState` *before* verification resolves, so a slow or failing
check cannot leave a live credential in the address bar, in a screenshot, or in
a copy-pasted link; and with an embedded JWKS it makes **no network call**, so
access decisions do not depend on addressium's availability and addressium does
not learn which reader opened which article. Its cached session lives in
`sessionStorage`, expires exactly when the token does, and is a copy of a
verified result rather than evidence — editing it fools only that browser.

Note what `sub` is: it is
**addressium's own durable subscriber id**, not a Cognito subject. The token
authenticates a *subscriber*; linking that subscriber to an account in the
operator's own user pool is optional, and is the operator's business
(`ARCHITECTURE.md` §4.10).

### 4.2 Multi-tenant isolation — OWASP API #1 (BOLA) / #5 (BFLA)

- `orgId` is **derived from the authenticated grant, server-side** — never
  trusted from a request body/param. The DynamoDB `orgId` partition prefix is
  **defense-in-depth, not the authorization**.
- Authorization is centralized (see [`packages/rbac`](../packages/rbac)) rather
  than ad-hoc per handler, and it runs through a **Cedar** policy engine: the
  policy set is generated from the ROLES matrix and evaluated server-side in
  `authorize()` (§10, #30). Cedar is in place, not planned.
- CI carries **cross-tenant tests** ("can a grant for org A read/write org B?")
  as a required gate.
- **Tenant-supplied ids are a constrained charset** — `idSchema` in
  `packages/core/src/schemas.ts`: `^[a-z0-9][a-z0-9_-]*$`, at most 64 characters,
  applied to `orgId`, `listId`, `campaignId`, `segmentId`, `templateId`,
  `sequenceId` and `stepId` (#196).

  DynamoDB is *not* the reason. That key design is sound: composite partitions
  have disjoint sort-key namespaces, and no cross-tenant item collision was
  constructible. The exposure is that these ids leak into namespaces that are
  **flat and not ours** — EventBridge Scheduler names, the send-claim key, S3
  keys, Secrets Manager names, KMS aliases, OpenSearch indices, the magic-link
  `issuer`. Two concrete failures existed:

  - **Cross-tenant denial of scheduling.** `camp-${orgId}-${campaignId}` was
    ambiguous because `-` is legal inside both ids — org `acme` + campaign `x-1`
    and org `acme-x` + campaign `1` both produced `camp-acme-x-1`. Scheduler
    names are account-wide and `CreateSchedule` is not an upsert, so the second
    tenant got a `ConflictException`. Now built by `scheduleName()`, which joins
    on `.` (forbidden by the charset) and falls back to a digest of the exact
    pair past the 64-character Scheduler limit — never a truncation, which would
    reintroduce the collision at the cut point.
  - **Silently skipped recipients.** The send-claim key is
    `${campaignId}#${subscriberId}`, so a campaign named `promo#0` collided with
    campaign `promo` and a subscriber id starting `0`. The loser was recorded as
    "already sent" and never received the campaign. `#` is now forbidden in a
    campaign id, which is what makes the separator unambiguous.

  The charset and the two separators are one design, not three: widening the
  charset without revisiting `scheduleName()` and `sendClaimKey()` puts both
  collisions back. `packages/domain/test/id-hardening.test.ts` asserts them
  together for that reason.
- **Unauthenticated inputs are bounded.** `POST /signup/batch` caps `listIds` at
  50 (the handler walks them sequentially — 50,000 ids was 50,000 round-trips
  from one anonymous request), and subscriber `attributes` are capped at 32 keys
  of ≤1024 characters each. Unbounded, an anonymous caller could write a
  subscriber item up to DynamoDB's 400 KB ceiling that every later read pays for.
- **Provisioning validates the org id it is given**, not just the one it derives.
  The handler read `event.orgId` off the *raw* event, bypassing `slugifyOrgId`
  entirely; that value then reached S3 keys, a Secrets Manager name, a KMS alias
  and the magic-link `issuer`. It is now checked at the handler *and* in
  `provisionOrganization`, so a caller arriving by another route cannot skip it.
  A display name that slugs past 64 characters fails loudly rather than being
  truncated — truncation would hand org B the org A record on the idempotency
  check.

### 4.3 Admin authorization & audit

- **Server-side RBAC** (capability + org scope) on every mutating handler; the
  console UI mirror is convenience only. Destructive actions
  (delete contacts, close newsletters) are Developer-Admin-only.
- **TOTP MFA required** on the admin pool (enforced in the CDK stack).
- **Append-only audit log** on an S3 **Object Lock (WORM)** bucket, created in
  every stage with a `RETAIN` removal policy, so history cannot be rewritten
  even by an admin. The mode is GOVERNANCE (§10) — recoverable by a principal
  holding `s3:BypassGovernanceRetention`, which is the escape hatch erasure
  depends on.
- **The log is readable from the console** (#191), gated on `team:manage` —
  Developer Admin only. The log names members and their actions, so it is the
  same administrative surface as Team & access rather than a report; an analyst
  with `reports:view` cannot reach it. Cross-org entries (org creation, pool
  linking) live in a `GLOBAL` scope of their own, so an operator scoped to one
  org cannot read deployment-wide actions. Reading is deliberately **not itself
  audited**: it is not a mutation, and an entry per view would bury the actions
  the log exists to record. The Lambda's grant is Put and Read, never Delete —
  Object Lock is the second line of defence, not the first.
- Only Developer Admin can change roles — no privilege-escalation path.
- **Manual subscription confirmation is a named, audited act (#205).** An admin
  can set one subscription to `confirmed` from the console, which bypasses double
  opt-in. Three things make that safe rather than merely convenient:
  - It is refused unless the request carries `acknowledgeManualConfirmation`,
    enforced in the domain and not only in the console — a flag the client alone
    checks is a speed bump, not a safeguard.
  - The consent it writes records what actually happened:
    `basis: "manual_admin"` with the acting member's `sub` taken from the
    verified JWT, never from the request body, and **no fabricated `sourceUrl`**.
    Recording it as `explicit` would make an administrative act
    indistinguishable from a real signup in precisely the record a consent
    dispute turns on.
  - Existing consent is never overwritten. The original provenance is the proof
    of the original opt-in; an admin re-confirming is not a better version of it.

  It is audited under its own action (`subscription.manual_confirm`), so "who
  hand-confirmed this address?" is answerable from the WORM log rather than
  inferred. `bounced` and `complained` are deliberately not settable by hand:
  those are facts SES reports about a delivery, and a human typing one in would
  corrupt the deliverability signal the halt logic reads.
- **Suppression outranks every opt-in an admin can set.** Nothing on the
  subscriber screen can un-suppress an address — that is `liftSuppression`, with
  its own `suppression:manage` capability. The detail panel says so in place, so
  an operator does not read the resulting silent send as a broken feature.

### 4.4 Send-path abuse & denial-of-wallet

The system's purpose is sending mail, so a compromised account is a spam/phishing
cannon aimed at your own reputation, and unauth endpoints are a cost-explosion
vector.

- **Double opt-in** means confirmation goes to the address itself — addressium
  cannot be weaponized to spam third parties.
- **Per-org sending quotas + anomaly alerts** (complaint/bounce spikes → SNS,
  auto-halt thresholds).
- **Honeypot + opt-in reCAPTCHA** on `/signup` and `/signup/batch` (#40, #230),
  run before any work is done. The honeypot is end-to-end: both the hosted
  signup page and the embed widget render an off-screen, `aria-hidden`,
  `tabindex="-1"` trap and post it, and a filled one yields a silent `202
  pending` — no subscriber written, no mail sent, and no signal to the caller
  that it was caught. The field name is a single exported constant so the check
  and the clients cannot drift; a drift would fail **open** and, because a
  caught bot looks exactly like a successful signup, would go unreported. The
  limit worth stating: reCAPTCHA runs **only** when the org has set
  `recaptchaSecretArn`, so it is off unless configured.
- **AWS Budgets** alarms are the spend cap that ships. WAF **rate-based rules**
  and a WAF **CAPTCHA** rule are the operator's to add (#30, #31)
  **[Decided r2 — not yet built]** — so until an operator WebACL is associated,
  the denial-of-wallet story is Budgets plus the in-app checks above, and there
  is no per-IP brake in front of the unauthenticated endpoints.

### 4.5 SSRF (feeds) & stored-HTML / XSS

- **Feeds** fetch operator-supplied URLs server-side — textbook **SSRF**. Guard:
  HTTPS-only, **egress allowlist**, block link-local/private ranges
  (`169.254/16`, `10/8`, `172.16/12`, `192.168/16`, `127/8`, `0/8`), reject
  DNS-rebinding by pinning the resolved IP, and set tight timeouts. Reference
  guard: [`services/feeds/src/guard.ts`](../services/feeds/src/guard.ts).
  (Fetchers run in **Lambda, which has no IMDS endpoint** — removing the
  `169.254.169.254` credential-theft path — but internal/VPC SSRF still matters.)
- **Ad tags / raw-HTML templates** are attacker/advertiser-controlled markup.
  Admin previews render only inside a **sandboxed iframe with a strict CSP**;
  merge-tag values are **contextually escaped** so a malicious subscriber
  attribute cannot inject markup.

#### Pre-launch review outcomes (#94)

- **Every send body is sanitized or trusted-by-provenance, uniformly.** `raw_html`
  bodies and **`text`/`ad` blocks** are hard-sanitized (`sanitizeEmailHtml`) at the
  API edge, so blocks mode is no weaker than raw HTML. **`mjmlHtml` is the one
  intentional bypass**: it is HTML our own SPA compiled from operator MJML and is
  trusted as-is so Outlook `<!--[if mso]>` conditional comments survive. Its trust
  boundary is **authenticated admin holding `campaigns:schedule`** — the same
  actor could paste `raw_html` — so it grants no capability that role lacks. Stored
  email HTML is never rendered in a privileged same-origin context (previews use a
  sandboxed iframe), so the bypass cannot become console XSS.
- **Link schemes are restricted in depth.** Editorial/ad link URLs are validated to
  `http(s)`/`mailto` at the schema boundary (`z.string().url()` alone accepts
  `javascript:`), and `renderForRecipient`/`renderHtmlForRecipient` re-check every
  href at send time — so even the trusted `mjmlHtml` path cannot emit a
  `javascript:`/`data:` link (neutralized to `#`).
- **`style` is allowed without a CSS-property allowlist** (accepted risk): inline
  styles are load-bearing for email layout, mail clients strip active CSS
  (`expression()`, `url(javascript:…)`), and merge values are escaped. Revisit with
  `allowedStyles` if a concrete client-side CSS-exfil vector is identified.
- **RBAC:** every route added since the last review (`campaigns` list, `subscribers`
  list, `suppressions` list, `unsuppress`, `import`, `privacy`, `drip-sequences`)
  enforces an explicit capability + org scope; `privacy:erase` requires the stronger
  `subscribers:delete`. **Magic-link verifier** re-audited: pins `ES256`, rejects
  `alg:none`/symmetric (RFC 8725), checks `iss`/`aud`/`exp`/`scope`/`amr`, fails
  closed.

### 4.6 Secrets, keys & webhooks

- Signing keys **never leave KMS** (asymmetric). Application secrets live in
  **Secrets Manager / SSM**, never in the repo (`addressium.config.json` is
  gitignored).
- **Verify inbound webhook signatures** (e.g. billing entitlement sync) and
  **HMAC-sign outbound** webhooks; always **timing-safe** comparison.
- Scheduled key/secret rotation with a JWKS overlap window.

### 4.7 Data protection & privacy

- **Encryption** at rest and in transit (TLS 1.2+). The DynamoDB table uses a
  **customer-managed KMS key** with rotation enabled, not the AWS-owned default
  (#202) — the default gives no CloudTrail record of key usage, no rotation
  control and no crypto-shredding option, all three of which an auditor expects
  on a multi-tenant PII store. The same key encrypts both SNS topics, because
  **SNS is not encrypted by default** (unlike S3, DynamoDB and Kinesis) and the
  SES events topic carries bounce and complaint notifications containing
  subscriber addresses. Queues declare `SQS_MANAGED` explicitly rather than
  relying on the service default — an auditor reads the template, not the
  service documentation.

  The key is `RETAIN` with a 30-day pending window: deleting it makes every
  ciphertext permanently unreadable, and that includes the backups, which are
  encrypted with it. Queues deliberately do **not** use the CMK: `SesEventsTopic`
  publishes into `EventsQueue`, and a customer-managed key there additionally
  needs a key policy admitting the SNS service principal — a second failure mode
  (silently undelivered notifications) in exchange for control over ciphertexts
  that live at most 14 days. The durable store is the table, and that has the CMK.
- **Claim minimization** in tokens; **token redaction** from the event pipeline
  and logs (no bearer tokens at rest).
- **Consent provenance**, configurable retention, and **GDPR/CCPA** export +
  erase-to-tombstone (`ARCHITECTURE.md` §4.19).

Three limits on that last bullet, stated here because a privacy control that is
narrower than it sounds is worse than one that is absent:

- **What erasure reaches, exactly** (#164). It used to anonymize a single
  DynamoDB item and return `true`, so an operator ran it, got a success, and
  reported compliance while the person was still resolvable from their Cognito
  `sub`. `eraseSubscriber` now returns an `ErasureReport` of what it actually
  did, and the API records those counts in the audit entry — "erased: true" said
  the same thing whether one item changed or every trace went.

  | Data | On erasure | Why |
  | --- | --- | --- |
  | Profile (`email`, `attributes`, signup IP + source URL) | anonymized in place | The id is kept so references stay valid |
  | `externalId` + the `EXTID#` pointer item | **deleted** | The pointer is a separate item read *first* by `findByExternalId`, so clearing the field alone left the Cognito sub resolving |
  | Email-reservation item | **released** | Its sort key *is* the plaintext address |
  | Entitlement record | **deleted** | Links the subject to a billing system |
  | `EVENT#` rows, every campaign | **deleted** | Walks the org's campaigns; there is deliberately no subscriber-keyed index, which would be a second place the id lives |
  | Campaign counters | **untouched** | Aggregates, not personal data. Decrementing would rewrite historical reports to hide that a send happened |
  | Subscription consent: IP, user agent, source URL | **stripped** | Personal data |
  | Subscription consent: timestamps, basis | **kept** | The org's evidence it was once entitled to mail the address, which an erasure request does not retroactively undo |
  | Suppression tombstone (holds the address) | **kept** | GDPR Art. 17(3)(b) / Recital 65 — and without it the next import silently re-adds them |
  | S3 data lake | **tombstone + expiry**, see below | An S3 object cannot be edited per subject |

- **The lake is handled by tombstone and expiry, not by rewriting** (#164). Rows
  already written to `events/` are GZIP-compressed, dynamically partitioned,
  append-only objects; rewriting them per request is neither cheap nor atomic,
  and a half-rewritten partition is worse than an intact one. So an erasure
  writes an `ERASURE#` item, which flows through the existing Kinesis → Firehose
  path and lands in the **same Glue table** as an `event_type = 'erased'` row —
  no second delivery stream, no second table, and no partition a query can forget
  to include. Every analytics query anti-joins against it:

  ```sql
  WITH erased AS (
    SELECT DISTINCT org_id, subscriber_id FROM events WHERE event_type = 'erased'
  )
  SELECT e.* FROM events e
  LEFT JOIN erased x ON e.org_id = x.org_id AND e.subscriber_id = x.subscriber_id
  WHERE x.subscriber_id IS NULL AND e.event_type <> 'erased'
  ```

  The rows themselves then age out: `events/` expires at **730 days** by default
  (`-c analyticsEventRetentionDays=…`), `entities/` — the nightly full-table
  export, which lands *raw* subscriber items — at **30 days**, `athena-results/`
  at 14 and `events-errors/` at 30. Two years is chosen because year-over-year
  cohort reporting is why the lake exists; "retained indefinitely", which is what
  it was, is not a retention policy anyone can defend to a regulator.

  The erasure report quotes the resulting expiry date back to the operator, read
  from the same value the bucket's lifecycle rule is built from, so the date a
  subject is given matches the rule that enforces it. It is quoted **only** when
  the analytics tier is enabled — on a default deployment there is no lake, and a
  window the operator cannot check against any bucket would be worse than none.

  **The honest limit:** between the erasure and that expiry, a row bearing the
  subject's (pseudonymous) subscriber id still exists on disk. Nothing can
  resolve it to a person — the profile, the pointer and the reservation are all
  gone — and no query returns it. An operator who needs the row physically gone
  sooner should lower `analyticsEventRetentionDays`, at the cost of the reporting
  history it buys.
- **Export covers both the subject and the list.** The DSAR path returns one
  subject's profile, subscriptions and entitlement as JSON; bulk CSV/JSONL
  portability of a whole org, including a re-import plan, is done (#58, #224).
- **Consent provenance is recorded on both paths** (#220, #223). A public double
  opt-in writes the request timestamp, source URL and the confirming request's IP
  and user-agent when the signup supplies them — absent stays absent, since a
  fabricated `0.0.0.0` is worse than a missing field. An import writes the *same*
  `SubscriptionConsent` shape: the declared basis, the batch id and the source
  file, per row rather than per file, so a dispute is answered for the subscriber
  who raised it. A row with no recorded basis reads as **unknown**, never as
  explicit, and can only ever be `pending`. The API refuses a `confirmed` import
  against an implicit or absent basis outright, naming the columns that blocked
  it — downgrading in silence would leave the operator believing the list is
  mailable. What an import still cannot prove is *when* the person opted in: a
  Pinpoint `EffectiveDate` is an endpoint-update stamp, not consent evidence, and
  is never presented as one.

### 4.8 Event-plane integrity & durability

Engagement events are not a reporting nicety: bounces and complaints drive
suppression and auto-halt. A lost bounce is an address that keeps being mailed —
reputation damage that compounds silently and that nobody is paged about. So
delivery of the event stream is an integrity control.

- **Deterministic `eventId`** (#183): the DynamoDB sort key is
  `EVENT#<at>#<eventId>`, so a redelivered event overwrites its own row rather
  than double-counting. Built.
- **DLQ on the send path** (#92): `SendQueue` has a dead-letter queue with
  `maxReceiveCount: 5`, and two of the 24 alarms watch it (DLQ-not-empty, queue
  age). A message that repeatedly fails to send is inspectable and replayable
  instead of lost. Built.
- ~~SQS between SNS and `EventsFn`~~ **Done** (#20, #44, #218).
  Today SES → SNS invokes `EventsFn` **directly**, which is an async Lambda
  invocation: AWS retries twice and then discards the event permanently, and
  there is no events DLQ. Interposing SQS adds durable buffering, a real DLQ,
  and partial-batch-failure reporting. Until it lands, treat bounce and
  complaint ingestion as best-effort, not guaranteed.
- **Event write + counter increment in one `TransactWriteItems`** (#57), made
  exactly-once by the deterministic `eventId`.
  **Done** (#221) — campaign counters were derived by
  folding the whole event list on every read; the stored `Campaign.counters`
  field is only ever zero-initialized and nothing increments it, so any figure
  served straight from that field reads zero.

---

## 5. Cloud hardening (CIS / Well-Architected)

| Control | Requirement |
|---|---|
| IAM | Least-privilege per Lambda; scoped resource ARNs; **no wildcards**; no long-lived keys |
| Detection | CloudTrail (all regions), GuardDuty, AWS Config, Security Hub |
| Edge | **Operator-supplied WAF** (#30, #31, #225): create or reuse a REGIONAL WebACL for the HTTP API and a CLOUDFRONT-scope one (in `us-east-1`) for the SPAs — AWS managed common + known-bad-inputs rule sets, a per-IP rate limit, optionally a CAPTCHA rule on `/signup` — then associate them |
| Storage | S3 Block Public Access on; SSE-KMS; TLS-only bucket policies |
| Compute | IMDSv2 only (any EC2/containers); minimal Lambda perms; DLQs |
| Budget | AWS Budgets + anomaly alarms (denial-of-wallet backstop) |

## 6. Frontend hardening

Both SPA distributions carry a CloudFront `ResponseHeadersPolicy`
(`infra/cdk/lib/static-site.ts`, #197), asserted in `infra/cdk/test/template.test.ts`:

| Header | Value | Why |
| --- | --- | --- |
| `content-security-policy` | `default-src 'none'`, `script-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, allowlisted `connect-src` | See below |
| `strict-transport-security` | 2 years, `includeSubDomains; preload` | The redirect-to-HTTPS behaviour doesn't protect the *first* request |
| `x-content-type-options` | `nosniff` | A user-uploaded asset must not be sniffed into a script |
| `referrer-policy` | `strict-origin-when-cross-origin` | An OAuth callback or magic-link URL must never leave in a `Referer` |
| `permissions-policy` | camera/mic/geolocation/etc. all `()` | Neither app uses them |

**Why the CSP is shaped the way it is.** The console renders operator-authored
HTML in the GrapesJS editor and in a `srcdoc` preview iframe, which inherits the
parent policy — `script-src 'self'` is what stops a pasted `<script>` in a
template from executing with the operator's tokens in reach (the preview iframe
also carries `sandbox=""`). Three directives are deliberately looser and each is
load-bearing: `style-src 'unsafe-inline'` (GrapesJS writes inline styles as
blocks are dragged, and email HTML is inline-styled by definition — there is no
nonce path through a static S3 origin), `img-src https:` (editorial images come
from the publisher's own CDN, unknown at synth), and `frame-src 'self'` (the
`about:srcdoc` preview).

**`connect-src` is an allowlist, with a known gap.** It names the API origin and,
for the console only, the Cognito Hosted UI (the PKCE exchange POSTs to
`/oauth2/token` directly). It cannot default to the API's own endpoint token: the
API's CORS allowlist already resolves from the two distributions, so referencing
the API from a distribution closes a CloudFormation dependency cycle and synth
fails. The default is therefore
`https://*.execute-api.<region>.amazonaws.com` — bounded to API Gateway in this
region, but not to *this* API. **Set the `apiAppUrl` stack prop** (a custom
domain, or the endpoint printed by the first deploy) to pin it to one origin.

Auth is Cognito **Authorization Code + PKCE** (no implicit flow). Tokens live in
`sessionStorage`, not `localStorage`, so they die with the tab. There is **no
refresh flow**: `expires_in` is stored as an absolute timestamp, an expired token
shows the sign-in card instead of blank panels, and a `401` from the API clears
the token and bounces once through the Hosted UI (once per tab — Cognito's SSO
cookie would otherwise make a non-expiry `401` loop forever). A `403` is an RBAC
verdict and never triggers re-auth. The consequence worth stating plainly: an id
token stolen from a compromised tab is valid for its full lifetime, with no
server-side session to revoke — which is why the CSP above matters more here than
it would on a page with a revocable session.

Public one-click unsubscribe is a **signed POST** (RFC 8058) — the token
authorizes the cross-origin request, so no ambient-authority CSRF exists.

## 7. Supply chain & release integrity

Because addressium is **self-hosted OSS**, build/release integrity is a
first-class control:

- **SLSA** build provenance; **Sigstore/cosign**-signed release artifacts.
- Published **SBOM** (CycloneDX) per release.
- GitHub Actions **pinned by commit SHA** (every `uses:` in `.github/workflows/`
  carries a full-SHA pin + a version comment); workflow `permissions`
  least-privilege; **OIDC to AWS** (no static deploy keys). The `deploy` job runs
  only on `refs/tags/v*`, requests `id-token: write`, and assumes the
  `DEPLOY_ROLE_ARN` repo variable's role via `configure-aws-credentials`.
  Create that role once with a GitHub OIDC provider
  (`token.actions.githubusercontent.com`) and a trust policy that restricts
  `sub` to `repo:<owner>/<repo>:ref:refs/tags/v*`; grant it only the CDK
  deploy permissions. No branch/PR run can assume it.
- **Dependabot/Renovate**, **CodeQL**, and **secret scanning** enabled.

### One accepted advisory

`npm audit` reports **GHSA-mh99-v99m-4gvg** (`brace-expansion` DoS via unbounded
expansion) with **no fix applied**, deliberately. It reaches us only as a
dependency that `aws-cdk-lib` **bundles** inside its own `minimatch`, so an npm
`overrides` entry does not patch it — it deletes the bundled copy and breaks CDK
synth outright. That was tried and reverted.

Accepting it is defensible on reachability: `aws-cdk-lib` appears in
`infra/cdk` and **nowhere else** — no deployed service depends on it, so the
code is absent from every Lambda. The only thing that ever evaluates those globs
is `cdk synth` on a maintainer's machine or in CI, over stack definitions from
this repository. There is no path from an untrusted input to it.

It clears when aws-cdk-lib ships a release bundling a patched `minimatch`.
Re-check on each CDK bump rather than suppressing the warning.
- Branch protection + required review; maintainer **2FA**.
- Public trust signals: **OpenSSF Scorecard** + **Best Practices Badge**.
- Coordinated disclosure per [`../SECURITY.md`](../SECURITY.md).

## 8. Secure defaults (a fresh `cdk deploy`)

Out of the box, with no tuning: admin **MFA required**, encryption at rest on all
stores, S3 public access blocked, least-privilege IAM, DynamoDB **PITR +
deletion protection + a `RETAIN` removal policy in every stage** (not just
prod), an Object-Lock audit bucket, per-org KMS signing keys, double opt-in
default, DKIM/SPF/DMARC guided in the setup wizard, and secrets sourced from
Secrets Manager/SSM. Hardening beyond the defaults is documented, not assumed.

**What a fresh deploy does not give you.** This is the part a risk decision
turns on, so it is stated plainly rather than left to be inferred:

- **Edge protection is the operator's step.** r2 makes both WebACLs
  operator-supplied (#30, #31, #66): addressium creates neither, and the
  operator creates or reuses them and associates them with the API stage and the
  two distributions. **[Decided r2 — not yet built]** — the current stack still
  creates both ACLs and associates them, unconditionally, in every stage. So do
  not read "WAF and rate limiting ship out of the box" as a durable property of
  addressium: it is true of today's template and is scheduled to stop being
  true. Plan the operator WebACL now. Without one, the public plane's brakes are
  the in-app controls in §3 and §4.4 — double opt-in, signed action tokens, zod
  validation, the honeypot check, and reCAPTCHA where an org has configured a
  secret — and nothing rate-limits by IP.
- **Alarms fire into a topic nobody is subscribed to.** All 24 CloudWatch alarms
  publish to an SNS topic the stack creates, and a fresh deploy adds **no
  subscription** to it — no email, no PagerDuty, no Slack. Alerting is therefore
  silent until an operator subscribes something. r2 goes further and has
  addressium consume an **external** ops topic instead of creating its own
  (#32, #67, config `opsAlertTopicArn` / `opsAlertEmail`)
  **[Decided r2 — not yet built]**; that config key does not exist yet.
- **Nothing preflights either of the above.** The only preflight that exists is
  `npm run deploy:check`, and it covers a different concern — whether a deploy
  would replace or remove a data-holding resource. No command warns that no WAF
  is associated or that no alert target is configured, so shipping unprotected
  is currently silent.

## 9. ASVS Level 2 — condensed verification checklist

A living checklist mapped to our controls (full ASVS tracked separately):

- **V1 Architecture** — documented threat model (this doc); trust boundaries defined.
- **V2 Authentication** — Cognito + TOTP MFA (admin); NIST 800-63B alignment.
- **V3 Session** — Cognito-managed sessions (admin); magic-link is a **lite,
  scoped** session, never elevated.
- **V4 Access Control** — server-side RBAC + org scope; deny-by-default; BOLA/BFLA tests.
- **V5 Validation/Encoding** — zod validation at the edge; contextual output
  encoding; SSRF egress guard.
- **V6 Cryptography** — KMS-managed keys; ES256; no home-grown crypto.
- **V7 Errors/Logging** — structured logs, PII/token redaction, immutable audit.
- **V9 Communications** — TLS 1.2+ everywhere; HSTS.
- **V10 Malicious Code** — pinned deps, CodeQL, SBOM, signed releases.
- **V12 Files/Resources** — SSRF controls on feeds; sanitized/sandboxed HTML.
- **V13 API** — authz on every object/function; rate limiting is the operator's
  WebACL (§5, §8), not an addressium default.
- **V14 Config** — secure defaults; secrets never in repo; least-privilege IAM.

## 10. Open items (tracked)

- ~~Central policy engine (Cedar) for authorization as rules grow.~~ **Done** —
  enforcement runs through the Cedar engine; the policy set is generated from the
  ROLES matrix and evaluated server-side in `authorize()` (#30).
- ~~WORM/Object-Lock wiring for the audit log.~~ **Done** — the audit bucket is
  Object-Lock enabled with a default retention and a `RETAIN` removal policy, so
  history cannot be rewritten (#29). The *mode* is a separate open item, below.
- ~~CI: pin all actions to SHAs, wire OIDC-to-AWS deploy role.~~ **Done** —
  every `uses:` pinned by SHA; OIDC `deploy` job assumes a scoped role on tags (#27).
- ~~Switch the audit bucket's Object Lock from COMPLIANCE to GOVERNANCE.~~
  **Done** (#9 **[CHANGED r2]**, #219) — the CDK now sets
  `ObjectLockRetention.governance(...)`, verified as `Mode: GOVERNANCE` in a
  fresh `cdk synth`. Under GOVERNANCE a sufficiently privileged principal can
  still remove an object with `s3:BypassGovernanceRetention`, so a mistake — a
  wrong retention window, the wrong object written to the wrong bucket — stays
  recoverable, and it is the escape hatch GDPR erasure depends on. COMPLIANCE
  cannot be undone by anyone, **including AWS**. This had to land *before* the
  first real deploy: an object already written under COMPLIANCE could never be
  relaxed, and the bucket is `RETAIN`, so the mistake would outlive the stack.
  **Grant `s3:BypassGovernanceRetention` as break-glass only**, to a named
  principal, and record who holds it.
- Formal, full ASVS L2 line-by-line review before a 1.0 release.
