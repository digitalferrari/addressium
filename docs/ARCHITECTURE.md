# addressium — Architecture & Design

> An open-source, self-hostable replacement for the email capabilities of
> **Amazon Pinpoint**. Deploy it into your own AWS account, verify a sending
> domain, and run email lists, signup forms, broadcasts, and drip automations —
> all serverless, at near-zero idle cost.

- **Status:** Design (pre-implementation)
- **Audience:** Contributors and operators evaluating or building addressium
- **Scope of this document:** the canonical system design. Code follows this spec.

---

## 1. Motivation

Amazon Pinpoint is being retired, leaving teams who used it for email lists,
signup forms, and campaign sending without a drop-in path. Existing hosted
alternatives (Mailchimp, Customer.io, etc.) are SaaS and take custody of your
subscriber data and sending reputation.

**addressium** fills that gap: a project **anyone can deploy into their own AWS
account**. You own the data (DynamoDB), you own the sending reputation (your
SES identity), and you pay AWS directly (~$0 at idle, ~$0.10 per 1,000 emails
via SES). It is not a multi-tenant SaaS — each deployment is a single
organization's system.

### Design principles

1. **Serverless-first** — near-zero cost when nothing is being sent; scales on
   demand. No always-on servers or databases in the default deployment.
2. **Own your data and reputation** — subscriber data never leaves the
   operator's account; email is sent through the operator's own SES identity.
3. **Deliverability is a feature, not an afterthought** — DKIM/SPF/DMARC,
   one-click unsubscribe, and suppression handling are built in and enforced.
4. **Channel-agnostic core, email-first build** — the domain model and pipeline
   are designed so SMS/push can be added later without a rewrite, but only the
   email path is built and tested for v1.
5. **One-command deploy** — `cdk deploy` plus a guided setup wizard. An operator
   should get to "verified domain, first list, first send" quickly.

---

## 2. Scope

### In scope (v1)

- Email channel via **Amazon SES v2**
- Subscriber & list management with per-list subscription status
- Public **signup forms** (embeddable snippet + hosted landing pages)
- **Double opt-in** confirmation (configurable per list), preference center,
  one-click unsubscribe
- **Broadcasts**: send now, scheduled, and recurring campaigns
- **Drip automations**: trigger-based sequences (welcome series, re-engagement)
  via Step Functions
- **Segmentation** over subscriber attributes and engagement, via DynamoDB GSIs
  and materialized tags
- **Templates** authored in MJML with merge variables and live preview
- **Engagement analytics & reporting dashboards**: sends, deliveries, opens,
  clicks, bounces, complaints, unsubscribes — real-time counters, queryable
  event history, per-campaign funnels, and link performance
- **Email archive + click overlay**: a copy of every generic (per-campaign)
  rendered email is stored, so reporting can overlay per-link click data on the
  actual email — a click map
- **Subscriber identity via Cognito**: every subscriber has an account in a
  Cognito user pool — **shared with the operator's main website** as the single
  base identity everything hangs off. The Cognito `sub` keys the DynamoDB
  subscriber profile, subscription preferences, and entitlement (see §4.10)
- **Magic-link SSO tokens**: editorial newsletter links carry a per-recipient
  signed token that logs the reader into a *lite, content-only* session on the
  main website and removes the reg/paywall overlay (soft paywall — see §8.1),
  carrying an `entitlement` (free/paid) plus whitelisted claims. addressium mints
  and signs the token; the main site verifies and applies it (client-side, on a
  CloudFront-cached page — that sign-in logic is out of scope, see §12)
- **Editorial vs advertising link handling**: the sender adds tokens + click
  tracking to **editorial** links only; **LiveIntent advertising** links are left
  untouched (no token, no tracking)
- **Migration importer**: Pinpoint export and CSV ingest (endpoints, segments,
  suppression lists)
- **Admin console** (React SPA) protected by Cognito
- **Infrastructure as code** via AWS CDK (TypeScript), one-command deploy

### Out of scope (v1, designed for later)

- SMS, push, voice, in-app channels (seams exist; not built)
- Visual drag-and-drop template builder (template store is shaped for it)
- Ad-hoc arbitrary segmentation at scale (OpenSearch mirror is a documented
  drop-in when needed)
- Full visual journey builder (v1 ships code/config-defined drip automations)
- Multi-tenant SaaS operation

### Key decisions (locked)

| Area | Decision | Rationale |
|---|---|---|
| Channel scope | Email only | Do one channel exceptionally well; keep seams for more |
| Data store | DynamoDB (on-demand) | Pay-per-use, ~zero idle cost, scales infinitely |
| Segmentation | GSIs + materialized tags | Covers common list filters cheaply; OpenSearch mirror later |
| Automation | Broadcasts + drip (Step Functions) | Covers the majority of list use without a journey-builder build |
| Open/click tracking | SES built-in (config sets) | Reliable, minimal code |
| Opt-in | Double opt-in default (per-list configurable) | Deliverability + consent provenance |
| Templating | MJML now, block editor later | Robust responsive email; store shaped for a visual editor |
| Migration | First-class Pinpoint + CSV importer | Adoption hook for the "Pinpoint is ending" moment |
| Email archive | Generic copy per campaign | Powers the click overlay; tiny storage; no recipient PII or tokens at rest |
| Subscriber identity | Shared Cognito user pool | One base account for prefs + main-site login; `sub` ties everything together |
| Magic-link token | Asymmetric JWT + JWKS | Verified **client-side** on a cached page — a shared secret would leak and be forgeable; asymmetric ships only the public key |
| Token placement | URL fragment (`#tok=`) | Never sent to CDN/origin, no logs/Referer leak, never in the cache key; fall back to query param only if it can't survive the SES redirect |
| Paywall model | Soft / cosmetic (client overlay) | Content stays in the page for SEO/Google indexing; token removes the overlay; graceful fallback to the wall on any token failure |
| Entitlement | free/paid, staleness bounded by TTL | Client trusts the token's entitlement for its lifetime; churn self-corrects at expiry |
| Token posture | Long-lived, low-privilege (lite scope) | Best newsletter UX; forwarded links can only ever read content, never touch account |
| Token redemption | Reusable within TTL, stateless | No callback to addressium; keeps the two systems decoupled |
| Entitlement freshness | Synced from system of record | addressium's entitlement copy stays current; token also stamps `entitlement_asof` |
| IaC / language | AWS CDK, TypeScript monorepo | One language across infra, backend, and frontend |

---

## 3. High-level architecture

```
                          ┌────────────────── CloudFront ──────────────────┐
                          │                                                 │
   Public visitors ──▶  Signup / confirm / preference / unsubscribe pages   │
   Admin operators ──▶  Admin SPA (React) ── Cognito auth ──────────────────┤
                          │                                                  │
                          ▼                                                  ▼
                   API Gateway (HTTP API) ───────────────▶ Lambda (API handlers)
                          │                                         │
        ┌─────────────────┼──────────────────────┬─────────────────┤
        ▼                 ▼                        ▼                 ▼
   DynamoDB          EventBridge Scheduler   Step Functions     SQS send queue
 (single table   (scheduled + recurring    (drip automations,       │
  + GSIs)          campaign triggers)        wait/branch states)     ▼
        ▲                                                     Sender Lambdas
        │                                                     (token-bucket
        │                                                      throttled)
        │                                                            │
        │                                                            ▼
        │                                                       Amazon SES v2
        │                                                            │
        │                              SES configuration set events │
        │                                                            ▼
        └──────── Events Lambda ◀── SQS ◀── SNS ◀── (delivery/bounce/complaint/
                          │                            open/click/reject)
                          ▼
             Hot counters (DynamoDB)  +  Firehose ─▶ S3 ─▶ Athena/Glue (analytics)
```

### Request/data planes

- **Public plane** (unauthenticated, WAF-protected, rate-limited + CAPTCHA):
  signup, double-opt-in confirmation, one-click unsubscribe. Tokenized/signed so
  a request can only affect the acting subscriber.
- **Subscriber plane** (Cognito-authenticated, shared pool): the subscriber logs
  in with their own account to manage list preferences and attributes (§4.10).
- **Admin plane** (Cognito-authenticated, operator): list/subscriber/segment/
  campaign/template/automation management, analytics, and settings.
- **Sending plane** (async): campaign launch → segment resolution → suppression
  filter → SQS fan-out → throttled SES send.
- **Event plane** (async): SES events → SNS → SQS → processor → counters +
  suppression + link aggregation + Firehose (magic-link tokens redacted).
- **Archive/reporting plane**: sender writes a generic rendered copy + link-map
  to S3/DynamoDB; the admin SPA paints the click overlay and dashboards from it.
- **Token plane**: the token service mints KMS-signed magic-link JWTs and serves
  a JWKS endpoint the operator's main website verifies against (§12).

---

## 4. Component design

### 4.1 Admin console (`apps/admin-web`)

React SPA hosted on S3 behind CloudFront, authenticated with Cognito
(Authorization Code + PKCE). Surfaces:

- Lists & subscribers (search, filter, detail, manual add/suppress)
- Segments (build/save predicate; preview count)
- Templates (MJML editor + live preview + test send)
- Campaigns (compose, choose audience, schedule, review, launch)
- Automations (define/enable drip sequences and triggers)
- Analytics (per-campaign funnels, list growth, engagement)
- Settings (sending domains, DKIM/DMARC status, from-addresses,
  physical mailing address, opt-in policy, operators)

### 4.2 Public site (`apps/public-web`)

Static pages + minimal JS on S3/CloudFront:

- **Embeddable signup snippet** — a `<script>` operators drop on any site;
  posts to the public API.
- **Hosted signup pages** — for operators without their own site.
- **Confirmation page** — landing target for the double-opt-in link.
- **Preference center** — subscriber self-manages list memberships and
  attributes via a signed, tokenized link (no login).
- **Unsubscribe page** — one-click, honored globally or per-list.

### 4.3 API (`services/api`)

API Gateway HTTP API → Lambda. Two authorizer scopes:

- **Admin routes**: Cognito JWT authorizer.
- **Public routes**: no auth, but WAF + per-IP rate limiting + CAPTCHA on
  signup, and tokenized/signed links for confirm/preference/unsubscribe so a
  request can only affect the subscriber the token encodes.

Handlers are thin: validate (zod schemas from `packages/core`), authorize,
mutate DynamoDB, enqueue async work. No business logic in the frontend.

- **Entitlement sync endpoint**: a dedicated, authenticated **operator API /
  webhook** receives entitlement updates from the operator's billing /
  subscription **system of record** and writes `entitlement` + `entitlement_asof`
  onto the subscriber. This keeps the value addressium mints into magic-link
  tokens near-real-time. Authenticated with a scoped machine credential (API
  key / signed webhook), separate from the Cognito operator auth. Idempotent by
  `(subscriber, source, version)`.

### 4.4 Sender (`services/sender`)

- Campaign launch resolves the target segment to a recipient stream.
- Each recipient is checked against the **suppression list** (account + list
  level) before enqueue.
- Recipients are batched onto **SQS**; sender Lambdas consume batches, render
  the MJML template with per-recipient merge variables, and call SES
  `SendBulkEmail` (up to 50 destinations/call).
- A **token-bucket throttle** keeps aggregate send rate within the account's SES
  quota so the sandbox/production sending limits are never exceeded.
- Every message is tagged (campaign id, subscriber id) via SES message tags so
  events can be attributed.
- **Link classification** at render time: each link is tagged **editorial** or
  **advertising**. Editorial links get a per-recipient magic-link token and SES
  click tracking; **LiveIntent advertising links are left untouched** — no token,
  no tracking, no rewrite. The link-map records the class so the click overlay
  reports editorial performance only.
- **Archive at render time** (once per campaign): the first render produces the
  **generic body** — the template rendered with merge fields and the magic-link
  token left as placeholders — which is written to the archive S3 bucket, and
  each editorial `<a>` is assigned a stable **link-id**. This is what the click
  overlay is painted on (see §4.8). No per-recipient copies are stored.
- **Magic-link tokens are minted per recipient** (see §4.9) and passed as a
  per-destination `ReplacementTemplateData` merge variable, so `SendBulkEmail`
  still batches 50 at a time. The token rides in the destination URL's
  **fragment** (`#tok=…`), so it stays client-side only (see §8.1). The token is
  the only per-recipient difference in the link; the link's identity for
  reporting is its link-id, not its full URL.

### 4.5 Events processor (`services/events`)

SES configuration set publishes delivery/bounce/complaint/open/click/reject
events → SNS → SQS → Lambda. The processor:

- Appends to the **Events** table (append-only engagement log).
- Updates **hot counters** on the campaign and subscriber records.
- **Aggregates clicks by link-id** (resolving the clicked URL back to the
  link-id assigned at archive time) so the click overlay has per-link totals and
  unique counts.
- **Redacts magic-link tokens before persistence.** SES click tracking reports
  the full destination URL of an editorial link, which carries the bearer token
  (in the URL fragment, or a query param on the fallback path). The processor
  **strips the token** before writing to the Events table or Firehose, so
  magic-link credentials never land at rest in the analytics pipeline.
- Streams events to **Firehose → S3** for Athena querying.
- On **hard bounce / complaint**, adds the address to the **suppression list**
  and flips the subscription status; monitors complaint rate and **auto-throttles**
  if it approaches SES thresholds.

### 4.6 Automations (`services/automations`)

Step Functions state machines model drip sequences: `Wait` states for delays,
`Choice` states for branching on engagement/attributes, tasks that enqueue sends
through the same sender pipeline. Triggers: subscription confirmed (welcome
series), inactivity (re-engagement), attribute change, or manual enrollment.
EventBridge Scheduler drives time-based enrollment and scheduled/recurring
campaigns.

### 4.7 Importer (`services/importer`)

Ingests **Amazon Pinpoint exports** and **CSV** files:

- Endpoints → subscribers (with attribute mapping)
- Segments → addressium segments (best-effort predicate translation)
- Suppression/opt-out lists → suppression entries

Runs as an async job (S3 upload → Lambda/Step Functions) with a dry-run
preview, dedupe, and an import report (created/updated/skipped/errored).

### 4.8 Reporting & email archive (`services/reporting` + `apps/admin-web`)

Powers the full reporting dashboards and the click-map overlay.

- **Email archive**: the generic rendered body written by the sender (§4.4)
  lives in an immutable, encrypted S3 bucket, one object per campaign /
  automation step. A DynamoDB **EmailArchive** record points to it and stores
  the **link-map** (`link-id → { url template, position, label }`).
- **Click overlay**: the admin SPA renders the archived body in a sandboxed
  iframe and paints per-link badges — total clicks, unique clicks, CTR — from
  the link-id aggregation produced by the events processor (§4.5). This is the
  Mailchimp-style click map.
- **Dashboards**: campaign funnels (sent → delivered → open → click →
  unsub/complaint), link performance tables, list-growth trends, deliverability
  (bounce/complaint) trends, and per-subscriber activity timelines. Real-time
  numbers come from the hot counters; deeper cuts come from Athena over the S3
  event lake (§7).
- **Retention**: archive objects follow an operator-configurable S3 lifecycle
  policy. Because archived bodies are generic (no baked-in recipient PII or
  tokens), they are safe to retain for the life of the reporting window.

### 4.9 Magic-link token service (`services/tokens`)

Mints the signed tokens embedded in newsletter links. **Scope boundary:**
addressium *issues and signs* tokens and *publishes the verification keys*; the
operator's main website *verifies* them and *establishes the session*. The
sign-in / Cognito session-exchange logic on the main site is **out of scope**
(see §12 for the contract).

- **Signing**: an **asymmetric key in KMS** (ES256/RS256). addressium exposes a
  **JWKS endpoint** (via API Gateway/CloudFront) so the main website verifies
  offline, with no shared secret and no callback. Asymmetric is **mandatory**
  here because verification happens **client-side on a cached page** (§8.1) — a
  shared secret would be shipped to the browser and become forgeable.
- **`sub` is the shared Cognito subject** — the same base identity used for
  main-site login and preference management (§4.10). The main site resolves an
  **existing** Cognito user; no JIT provisioning.
- **Token shape** (JWT claims):
  - `sub` — the subscriber's Cognito user-pool subject
  - `scope: "content:read"` — **lite** access only
  - `amr: ["magic_link"]` — marks the session's origin so the main site can
    treat it as lite and force a step-up before anything sensitive
  - `entitlement` — `free` / `paid` (coarse tier / feature flags) from the profile
  - `entitlement_asof` — freshness stamp for the entitlement value
  - `aud` (main site), `iss` (this deployment), `exp` (long-lived, per §11)
  - additional profile claims from an **operator-configurable whitelist**
- **Delivery**: minted per recipient, embedded in the **URL fragment** of
  editorial links (§4.4), so it is client-side only and never hits the CDN,
  origin, or logs.
- **Claim minimisation**: only whitelisted, coarse values ride in the token —
  never private account detail — because the token travels in a URL.
- **Statelessness**: tokens are reusable within their TTL; addressium keeps no
  redemption state, keeping the two systems decoupled. Safety comes from the
  lite scope + bounded TTL + graceful fallback to the wall, not from single-use
  tracking.
- **Issued only to confirmed subscribers.**

See §8.1 for the security model (why lite + forwardable + soft-paywall is safe)
and §12 for the main-site integration contract.

### 4.10 Subscriber identity & preference center (`apps/subscriber-web` + Cognito)

Every subscriber is a **Cognito user** in the pool **shared with the main
website** — the single base identity everything associates to.

- **Signup** creates the Cognito user, records the DynamoDB subscriber profile
  (keyed by Cognito `sub`), and runs **double opt-in** confirmation.
- **Preference center**: authenticated with the subscriber's own Cognito login,
  to manage list subscriptions, attributes, and unsubscribe. (Tokenized no-login
  links remain for one-click unsubscribe and email-driven confirmation.)
- **Two session tiers for one account**: a **full** session (real Cognito login →
  profile + preference management) versus a **lite** session (magic-link origin →
  content read + reg/paywall bypass, no profile). The same person can upgrade
  from lite to full by logging in normally.
- Because the pool is shared, `entitlement` on the profile and the `sub` in the
  magic-link token line up with the main site's own view of the user with no
  mapping layer.

---

## 5. Data model

DynamoDB **single-table** design with targeted GSIs. Entities:

| Entity | Purpose | Key notes |
|---|---|---|
| **Subscriber** | Durable person record | **keyed by Cognito `sub`** (shared pool); email (normalized), attributes, locale, source, consent {timestamp, ip, url}, global status, `entitlement` (free/paid) + `entitlement_asof` |
| **List** | A named audience | opt-in policy, from-address, reply-to, compliance footer, physical address |
| **Subscription** | Subscriber ↔ List join | per-list status: `pending`/`confirmed`/`unsubscribed`/`bounced`/`complained` |
| **Segment** | Saved filter | predicate over attributes + engagement; resolved at send time |
| **Campaign** | A send | content ref, audience (list/segment), schedule, sending config, hot counters |
| **Template** | Reusable content | MJML source, merge variables, versioned; store shaped for future visual editor |
| **Event** | Engagement log | append-only: sent/delivered/open/click/bounce/complaint/unsub, attributed by tags; magic-link tokens redacted |
| **SuppressionEntry** | Do-not-send | source (hard-bounce/complaint/manual), enforced pre-send |
| **EmailArchive** | Generic rendered copy | S3 pointer + link-map (`link-id → url template, position, label`); one per campaign/step |
| **EntitlementSync** | Sync audit | last inbound entitlement update per subscriber (source, value, timestamp) for freshness/debugging |

### Access patterns → GSIs

- List membership & status: GSI on `(listId, status)` → paginated list views and
  segment base sets.
- Engagement recency: GSI on `(subscriberId, lastEngagedAt)` for
  "hasn't opened in N days" style predicates.
- Email lookup: GSI on normalized email for import dedupe and unsubscribe.
- **Materialized tags**: common segment memberships precomputed as
  attributes/tags on the subscriber so frequent segments are O(query), not
  O(scan).

### Segmentation strategy (and its escape hatch)

The segment engine lives behind an interface (`packages/segment`). The v1
implementation uses **GSIs + materialized tags**, which covers the large
majority of real list filters cheaply and with zero idle cost. When an operator
needs full ad-hoc, arbitrary-attribute segmentation at scale, a documented
**OpenSearch Serverless mirror** (fed by DynamoDB Streams) drops in behind the
same interface — this is the single "adds an always-billed component" upgrade,
and it is opt-in.

---

## 6. Email sending & deliverability

Meeting bulk-sender requirements (Gmail/Yahoo 2024+) is mandatory, so these are
built in and enforced, not optional:

- **Authentication**: SES Easy DKIM plus guided SPF and DMARC setup in the
  setup wizard; the console surfaces authentication status per domain.
- **One-click unsubscribe**: RFC 8058 `List-Unsubscribe` and
  `List-Unsubscribe-Post` headers on every campaign message.
- **CAN-SPAM**: enforced physical mailing address and unsubscribe link in every
  template's footer; campaigns cannot send without them configured.
- **Suppression**: account-level + list-level suppression enforced before every
  send; hard bounces and complaints auto-suppress.
- **Complaint-rate protection**: monitor complaint/bounce rates and auto-throttle
  or halt sending as they approach SES thresholds, protecting the operator's
  reputation.
- **Tracking**: SES configuration-set open/click tracking via an operator-owned
  tracking domain.

---

## 7. Analytics

Two tiers, matching how Pinpoint analytics were actually used:

1. **Hot counters** in DynamoDB on campaign/subscriber records power the
   real-time dashboard (sends, deliveries, opens, clicks, bounces, unsubs).
2. **Full event firehose** lands in **S3** for **Athena** ad-hoc analysis:
   per-campaign funnels, cohort/engagement analysis, list growth over time,
   and export.

This keeps day-to-day dashboards instant and cheap while making deep analysis
available without an always-on analytics cluster.

---

## 8. Security & compliance

- **Least-privilege IAM** per Lambda; no shared broad roles.
- **Encryption** at rest (KMS) and in transit throughout.
- **WAF** on public endpoints; per-IP rate limiting and CAPTCHA on signup to
  prevent list-bombing and abuse.
- **Tokenized public actions**: confirm/preference/unsubscribe links are signed
  and scoped so a request can only affect its own subscriber.
- **Consent provenance**: signup timestamp, IP, and source URL captured for
  GDPR/audit; double opt-in default strengthens proof of consent.
- **Data residency**: everything stays in the operator's account and chosen
  region.

### 8.1 Magic-link security model

A login link sitting in an inbox is a **bearer credential**, and email is
forwardable, so the design assumes a magic link *will* sometimes reach someone
other than the intended subscriber. Safety comes from strictly limiting what the
link can ever grant, not from assuming it stays private:

- **Lite scope, enforced by the main site.** The token asserts
  `scope: "content:read"` and `amr: ["magic_link"]`. A magic-link session may
  log the reader in and unlock paywalled/registration-wall **content only**. It
  must **never** reach the profile / private-account pages — those require a
  **step-up to full authentication**. addressium *declares* lite in the token;
  the main website *enforces* lite. This split is the core forwarding
  protection: even a forwarded link can only ever read content, never expose or
  change the original subscriber's account.
- **Entitlement is content-only.** The `entitlement` claim unlocks content
  tiers, never account control, so a stale or forwarded entitlement cannot cause
  real harm; `entitlement_asof` lets the main site re-validate for anything
  high-value.
- **Asymmetric signing, verified client-side.** Verification happens **in the
  browser on a CloudFront-cached page**, so the verifying key is exposed to the
  client. A symmetric/shared secret would therefore be extractable and forgeable
  — disqualified. With asymmetric signing the page holds only the **public** key
  (or fetches JWKS); it can verify but not forge. **The client must _verify_ the
  signature, not merely decode the JWT** — an unverified decode is trivially
  hand-forged.
- **Soft / cosmetic paywall (deliberate).** The article content stays in the
  page so Google can index it (flexible-sampling SEO). The reg/paywall is a
  **client-side overlay**; a valid token removes it. Because the content is
  intentionally in the page, forging a token to drop the overlay yields nothing
  that isn't already in view-source — so **the wall itself is not a hard security
  boundary**. Verification matters for what the *lite session* then authorizes
  (personalization, ad-lite, any authenticated call), not for the overlay.
- **Graceful degradation.** A missing / expired / invalid token simply leaves
  the normal reg/paywall in place (rendered if the reader qualifies to see it).
  There is no hard-fail path, which is what makes long TTLs and stale entitlement
  safe: a churned or expired user just falls back to the wall.
- **CDN safety.** The token rides in the **URL fragment**, so it never reaches
  CloudFront/origin, never appears in access logs, and never leaks via `Referer`.
  It must also be **excluded from the CloudFront cache key** so full-page caching
  stays shared and a personalized response is never cached and served to another
  reader. (Fallback: if the fragment can't survive the SES click-tracking
  redirect, use a query param excluded from the cache key with logging redacted.)
- **No tokens at rest in analytics.** The events processor strips the token
  before persisting click events (§4.5).
- **Claim minimisation + whitelist.** Only coarse, operator-whitelisted profile
  values ride in the URL-borne token.
- **Confirmed subscribers only**, and tokens carry a bounded `exp`. Because the
  scope is lite and failure degrades to the wall, a longer TTL is an acceptable
  UX/security trade (§11); an operator who wants a tighter posture can shorten
  the TTL.

---

## 9. Deployment & operations

- **Monorepo, AWS CDK (TypeScript)** — infra, backend Lambdas, and the React
  frontends share types (`packages/core`) and a single toolchain.
- **One-command deploy**: `cdk deploy`, then a **setup wizard** that walks the
  operator through SES domain verification (DKIM/SPF/DMARC), sandbox-exit
  guidance, the physical mailing address, and creating the first admin user.
- **Environments**: a single deployment per organization/account; multiple
  stacks (e.g., `dev`/`prod`) supported via CDK context.
- **Cost posture**: near-$0 at idle (on-demand DynamoDB, Lambda, S3, no
  always-on compute or DB). Dominant cost is SES (~$0.10 / 1,000 emails) plus
  egress. The optional OpenSearch mirror is the only component that adds a
  standing cost, and it is opt-in.

### Proposed repository layout

```
addressium/
├── apps/
│   ├── admin-web/         # React admin SPA (operator console)
│   ├── subscriber-web/    # subscriber signup + Cognito login + preference center
│   └── public-web/        # embeddable signup snippet + hosted / confirm / unsubscribe pages
├── packages/
│   ├── core/             # shared domain types + zod schemas
│   └── segment/          # segment engine (GSI/tags impl; OpenSearch drop-in)
├── services/
│   ├── api/              # API Gateway Lambda handlers + entitlement-sync endpoint
│   ├── sender/           # SQS consumers → SES SendBulkEmail (throttled) + archive/link-map
│   ├── events/           # SES event processor → counters + link-agg + token redaction + Firehose
│   ├── automations/      # Step Functions drip/journey state machines
│   ├── reporting/        # dashboards + click-overlay data (archive + link aggregation)
│   ├── tokens/           # magic-link JWT minting + KMS signing + JWKS endpoint
│   └── importer/         # Pinpoint / CSV migration importer
├── infra/
│   └── cdk/              # all CDK stacks + setup wizard
└── docs/
    └── ARCHITECTURE.md   # this document
```

---

## 10. Roadmap (indicative)

- **v1 — Core email platform**: lists, signup + double opt-in, subscribers,
  MJML templates, broadcasts (send-now/scheduled/recurring), suppression,
  deliverability (DKIM/DMARC/one-click unsubscribe), analytics + reporting
  dashboards, email archive + click overlay, Cognito admin, Pinpoint/CSV
  importer, CDK deploy + setup wizard.
- **v1.x**: drip automations (Step Functions), materialized-tag segment builder,
  magic-link token service (JWKS + entitlement sync + lite-scope tokens),
  preference center polish.
- **v2 — Extensibility**: OpenSearch segmentation drop-in, visual template
  block editor, visual automation/journey builder.
- **v3 — Multichannel**: activate the channel-agnostic seams for SMS
  (SNS / AWS End User Messaging) and push.

---

## 11. Open questions for later phases

- **Sending IPs**: shared SES IPs by default; document dedicated-IP setup for
  high-volume operators.
- **Rendering fidelity**: whether to add a rendering-preview service (multiple
  client previews) or rely on test sends in v1.
- **Backups/export**: point-in-time recovery on DynamoDB plus a scheduled full
  export to S3 for portability.
- **Webhooks/API for operators**: an outbound webhook + public API so operators
  can integrate addressium with their own systems.
- **Magic-link TTL default**: ship a sensible default (e.g. 7–30 days) with a
  clear knob; revisit once real forwarding/abuse data exists.

---

## 12. Main-site integration contract (magic-link, out of scope to build)

addressium's responsibility ends at **minting a signed token and publishing the
keys to verify it**. The operator's main website implements the other half. This
section defines the boundary so both sides can be built independently.

The two systems **share a Cognito user pool**, so the token references an
**existing** user — no JIT provisioning.

**addressium provides:**
- Editorial newsletter links containing a per-recipient magic-link JWT (per
  §4.9) in the **URL fragment**, signed by a KMS asymmetric key.
- A **JWKS endpoint** for offline (in-browser) verification, with key rotation.
- A published **claim contract**: `sub` (shared Cognito subject),
  `scope: "content:read"`, `amr: ["magic_link"]`, `entitlement` (`free`/`paid`),
  `entitlement_asof`, `aud`, `iss`, `exp`, plus whitelisted profile claims.

**The main website implements (out of scope here):**
1. Read the token from the inbound URL **fragment** client-side (the page itself
   is CloudFront-cached; the token must be **excluded from the cache key**).
2. **Verify** the signature and `exp`/`aud`/`iss` against the JWKS — a bare
   decode is forgeable and must not be trusted.
3. Establish a **lite** session for the existing shared-pool user — e.g. a
   **Cognito custom-auth (`CUSTOM_AUTH`) challenge** whose Define/Verify Auth
   Challenge Lambdas validate the token against `sub`.
4. **Apply entitlement to the soft paywall**: remove the reg/paywall overlay when
   the token is valid and `entitlement` qualifies; otherwise leave the wall in
   place (**graceful fallback**). The content itself stays in the page for SEO.
5. **Enforce lite scope**: content read only; gate profile / private-account
   pages behind a **step-up to full authentication**; never elevate a
   `magic_link`-origin session.
6. Optionally **re-validate `entitlement`** against its own source of truth for
   anything beyond the cosmetic wall, using `entitlement_asof` to decide when.

This contract is the reason a forwarded newsletter is safe: the token can only
ever mint a lite content session, the private profile page is unreachable
without a real login the forwardee does not have, and any token failure simply
degrades to the normal wall.

---

*This document is the source of truth for addressium's design. Implementation PRs
should reference and, where they deviate, update it.*
