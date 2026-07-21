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
via SES).

A single deployment can run **multiple organizations (silos)** — e.g. several
publications like Northwind Times and Lakeside Ledger — each isolated in its own data
partition, subscriber pool, signing key and sending identity (see §4.11). What
it is **not** is a public multi-tenant SaaS you rent to unrelated third parties:
every org in a deployment is operated by the same owner.

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
6. **Multi-org by design** — one deployment runs many isolated publications: a
   shared control plane (admin, API, console) over per-org data, identity and
   sending silos, with role-based access scoped to each org.

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
- **Multi-organization silos** (§4.11): one deployment runs many publications,
  each isolated in its own data partition, subscriber pool, signing key and
  sending identity — one AWS account, logical silos
- **Role-based access** (§4.12): Developer Admin / Editor / Analyst (Sales) /
  Support, enforced server-side and scoped per organization
- **Segmentation** over subscriber attributes and engagement, via DynamoDB GSIs
  and materialized tags
- **Templates** in three authoring modes (§4.15) — a visual drag-and-drop builder
  (GrapesJS→MJML), MJML source, and raw-HTML blasts — one responsive pipeline
  with the compliance footer auto-injected
- **Merge tags & ad tags** (§4.14): per-recipient merge variables, plus named
  LiveIntent **ad slots** (bound at the series/template level for recurring
  newsletters, per-campaign for one-offs) inserted verbatim and never tracked
- **Campaign types & series reporting** (§4.16): one-off vs ongoing (daily /
  weekly / biweekly), with aggregate reporting across a recurring series' editions
- **Sandbox / test mode** (§4.17), **deliverability alerts to SNS** (§4.18),
  **GDPR/CCPA export & erasure + audit log** (§4.19), and **A/B subject
  testing** (§4.20)
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
- Ad-hoc arbitrary segmentation at scale (OpenSearch mirror is a documented
  drop-in when needed)
- Full visual journey builder (v1 ships code/config-defined drip automations)
- **Public multi-tenant SaaS** (renting addressium to unrelated third parties);
  multi-**org silos** for a single owner *are* supported (§4.11)
- SSO / SAML for the admin pool (deferred; Cognito + MFA for now)

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
| Tenancy | Multi-org, one AWS account, logical silos | Run many publications from one deployment; not account-per-org |
| Org isolation | Per-org subscriber pool + KMS key + SES identity; pooled DynamoDB by `orgId` | Isolate identity/signing/sending; keep data infra cheap and shared |
| Sending reputation | Per-org configuration sets; dedicated IP pool optional | Metrics isolated always; reputation isolation opt-in (added cost) |
| Access control | RBAC, 4 roles, org-scoped, server-enforced | Sales read-only, Editor no delete/close, destructive = admin-only |
| Suppression scope | Hybrid default (bounces/complaints global, unsubscribes per-org) | Protect shared reputation; keep unsubscribes brand-specific |
| Template authoring | 3 modes: GrapesJS visual · MJML · raw HTML | Right tool per team; one MJML render pipeline; footer auto-injected |
| Ad tags | Named slots, bound at series/template level (recurring) | LiveIntent HTML inserted verbatim, never tracked |
| Campaign model | One-off vs ongoing series with aggregate reporting | Group recurring editions for trend reporting |
| Alerts | Deliverability rules → operator SNS topic | Fan out to email/SMS/Slack/PagerDuty/Lambda; auto-halt thresholds |
| Privacy | GDPR/CCPA export + erase-to-tombstone; immutable audit log | Compliance built in, not bolted on |
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
- **Subscriber plane** (Cognito-authenticated, **per-org shared pool**): the
  subscriber logs in with their own account to manage list preferences and
  attributes (§4.10).
- **Admin plane** (Cognito-authenticated via a **separate admin pool**, staff):
  list/subscriber/segment/campaign/template/automation management, analytics, and
  settings. Every request carries a **role + organization scope**, enforced
  server-side (§4.12); all data access is partitioned by `orgId` (§4.11).
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

React SPA hosted on S3 behind CloudFront, authenticated against the **admin**
Cognito pool (Authorization Code + PKCE), with an **organization switcher** that
scopes everything to the active silo. Controls are shown/hidden by the member's
role (convenience only — enforcement is server-side, §4.12). Surfaces:

- **Overview** — dashboard (KPIs, deliverability health) and analytics with the
  click-map overlay and A/B results
- **Audience** — newsletters (create, open/close signups), subscribers (detail +
  manual unsubscribe/suppress), segments, and suppression (§4.13)
- **Messaging** — campaigns (compose → audience → review; one-off vs series),
  templates (3 authoring modes), automations
- **Developer** — feeds, merge tags, ad tags, identity & pools, data & exports,
  API keys & webhooks
- **Configure** — organizations (silo management + setup), roles & access,
  settings (domains/DKIM/DMARC, magic-link & entitlement, alerts & SNS,
  privacy & data, team), audit log
- A **Live/Sandbox** toggle (§4.17) is always visible in the top bar

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

**Scheduling policy — every send goes through a schedule, and one-offs keep a
cancel window.** Both "send now" and "send at" create a **one-off schedule
placed at least 5 minutes in the future** (`MIN_ONEOFF_LEAD_MS`), so an operator
can hit **cancel** (`POST /campaigns/cancel` → `DeleteSchedule`) before anything
leaves. A requested time further out is honored as-is. Recurring series use a
timezone-aware cron (§4.21).

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

### 4.11 Multi-organization tenancy (silos)

A single deployment hosts **multiple organizations** (e.g. Northwind Times, Lakeside
Daily), each an isolated silo, all operated by the same owner.

- **One AWS account, logical silos.** A shared control plane (one admin pool, one
  API, one console, one CDK deployment) over per-org data and identity resources.
- **Per-org (siloed):** subscriber Cognito pool (shared with that org's site),
  sending domain(s) + SES identity + **configuration set**, **KMS signing key +
  JWKS**, entitlement/billing sync, and all subscriber/list/campaign/archive/event
  data.
- **Shared (control plane):** the **admin** Cognito pool (staff), the console/API,
  Lambdas, and the DynamoDB table.
- **Data isolation:** DynamoDB is **pooled with a hard `orgId` partition prefix**
  on every item; every query is org-scoped and enforced in the handler/IAM.
  Table-per-org is a documented alternative for operators wanting physical
  isolation.
- **SES reputation caveat:** sending reputation and quota are **account-wide**.
  Per-org **configuration sets** isolate metrics/events; an optional **per-org
  dedicated IP pool** isolates reputation (opt-in, added cost). Bounces/complaints
  additionally feed the shared account-protection path (§4.13).
- **"Add organization" provisions a silo**, not just a row: it always creates
  the org's **KMS signing key, SES domain identity (DKIM/SPF/DMARC), JWKS
  endpoint and config set** — driven by the admin API via the AWS SDK (or a
  per-org CDK stack). A per-org **setup checklist** tracks verification state.
- **Subscriber pool — link by default, create optionally.** The subscriber pool
  is **shared with the org's main website**, so most operators already have one
  (behind their site's paywall/login). The default is to **associate an existing
  pool** by ID — this is what makes the magic-link `sub` match the site's
  existing users. Creating a fresh pool is offered only for **greenfield** sites
  with no auth yet (the operator then points their site at it). addressium
  references a linked pool; it does not need to own it.

### 4.12 Roles & access (RBAC)

Staff live in the **separate admin Cognito pool**; each member holds a **role**,
**scoped to one or more organizations**.

| Role | Can | Cannot |
|---|---|---|
| **Developer Admin** | Everything, incl. delete contacts, close newsletters, identity/pools/orgs, API keys, suppression, alerts, roles | — |
| **Editor** | Create/send/schedule campaigns, **modify send times / resend**, templates, segments, manage subscribers | Delete contacts, close newsletters, config/identity |
| **Analyst (Sales)** | **Read-only** reporting & analytics | Any edit, send, delete or config |
| **Support** | Manage individual subscribers (edit, manual unsubscribe, resend confirm) | Send campaigns, any config |

Enforcement is **server-side** in the API (capability + org scope on every
mutating handler); the console hides/disables controls only as a convenience,
never as the security boundary. Destructive actions (delete contacts, close
newsletters) are Developer-Admin-only by design. Custom roles = a named
capability set. All privileged actions are recorded in the audit log (§4.19).

### 4.13 Suppression model

Suppression is enforced before every send (§4.4). Scope is configurable per
deployment, defaulting to **hybrid**:

- **Hybrid (default):** hard **bounces + complaints → global** list (they threaten
  the account/IP reputation shared by all orgs), while **unsubscribes → per-org**
  (brand-specific — leaving one publication shouldn't drop you from another).
- **Global:** one shared list reused by every org.
- **Per-organization:** each org keeps its own list.

Entries carry `source` (bounce / complaint / manual / unsubscribe) and `scope`
(global / org). GDPR erasure (§4.19) writes a hashed tombstone here so a forgotten
address is never re-added.

### 4.14 Merge tags & ad tags

Two distinct replacement systems, both managed in the developer area:

- **Merge tags** — per-recipient/per-campaign variables (`{{first_name}}`,
  `{{editorial_url}}`, `{{entitlement}}`, `{{unsubscribe_url}}`…). Each declares a
  **source** (profile attr / feed field / system / **token claim**), **scope**,
  example and fallback. Token-claim tags ride in the magic link; per-recipient
  tags resolve during bulk send; per-campaign tags are identical for everyone.
- **Ad tags** — named **ad slots** declared by a template (e.g. `{{ad_top}}`,
  `{{ad_inline_1..3}}`, `{{ad_native}}`, up to ~7), filled with **LiveIntent
  HTML**. Fills are inserted **verbatim**, sanitized, and **never** tokenized or
  click-tracked (excluded from the click map). **Binding:** for a **recurring
  series** the template and its ad-tag fills are set **once at the series level**
  and reused unchanged by every edition (only feed-driven article content varies);
  for **one-off** campaigns they are set per campaign.

### 4.15 Template authoring modes

One responsive render pipeline (MJML → HTML), three authoring modes so each team
uses the right tool:

- **Visual builder** — **GrapesJS** + `grapesjs-mjml` (open-source, MIT, embedded
  in the admin SPA), outputs MJML. For editors and ad reps building polished sends
  without code.
- **MJML source** — for developers; full control + live preview.
- **Raw HTML blast** — paste advertiser-supplied HTML as-is; for one-off blasts.

Regardless of mode, addressium **auto-injects** the compliance footer (physical
address + unsubscribe) and `List-Unsubscribe` headers, and **sanitizes** pasted
HTML — a rep cannot send a non-compliant blast. Raw HTML gets a responsiveness
warning. Templates declare their **merge-tag and ad-slot** placeholders (§4.14).

### 4.16 Campaign types & series reporting

Every campaign is **one-off** or part of an **ongoing series** (daily / weekly /
biweekly / recurring). A **CampaignSeries** groups all editions of an ongoing
newsletter and **owns its template and ad-tag fills** (§4.14), so every edition is
an idempotent send of the same shell with fresh feed content. Reporting
**aggregates across editions** (edition count, avg open/click, trend over time) in
addition to per-edition reports. Recurring sends run on **EventBridge Scheduler**;
Editors can **reschedule** or **resend** an edition (role-permitting).

### 4.17 Sandbox / test mode

A deployment/org **sandbox toggle**. In sandbox, campaigns send **only to
seed/test addresses**, real subscribers are never emailed, and stats are
simulated. It is surfaced as a persistent banner in the console so it is
unmistakable. This is distinct from the **SES account sandbox** (which the setup
wizard helps exit); it lets developers and ad reps trial sends safely.

### 4.18 Deliverability alerts (SNS)

Alert rules on **complaint rate, bounce rate, send-failure spikes and SES
reputation**, each with **warn** and **auto-halt** thresholds (auto-halt ties into
the sender's complaint-rate protection, §6). Alerts publish to an
operator-configured **Amazon SNS topic** — fan out to email/SMS/Slack/PagerDuty/
Lambda — plus optional direct notify targets.

### 4.19 Privacy (GDPR/CCPA) & audit log

- **Data-subject requests:** export a person's full record (profile + events) as
  JSON, or **erase / forget** — removing profile + events and writing a hashed
  suppression tombstone (§4.13) so they are never re-added. Available per
  subscriber and by email in Settings.
- **Consent provenance** (timestamp / IP / source URL) and configurable **event
  retention** (e.g. 13 / 25 months) support compliance.
- **Audit log:** every privileged admin action (sends, closes, deletes, key
  rotations, org provisioning, manual unsubscribes) is recorded **immutably** with
  member + org + timestamp.

### 4.20 A/B subject testing

A campaign may define **two subject variants** sent to a holdout split;
addressium picks the **winner** by open or click rate after a configurable window
and auto-sends it to the remainder. Variant rates and the winner surface in the
campaign report.

### 4.21 Time zones

**Storage and compute are UTC everywhere.** Every persisted timestamp is
ISO-8601 `Z` and all logic runs in UTC. A time zone is an interpretation /
presentation layer, set as the organization's **`defaultTimezone`** (an IANA
zone, e.g. `America/Denver`) in org config, with an optional **per-recurring-
campaign override**. Where it applies:

- **Recurring send times (a real behavior, not display).** "Daily 6am ET" is a
  recurring *wall-clock* intent and **cannot** be stored as a fixed UTC offset,
  because DST shifts the actual instant twice a year. It is stored as
  **timezone + cron** and evaluated by EventBridge Scheduler in that zone
  (`ScheduleExpressionTimezone`), so it stays correct across DST. The recurring
  schedule's zone is the **campaign override ?? org `defaultTimezone`**.
- **One-off sends need no zone.** An instant is an instant: the API takes an
  absolute time (with offset/`Z`), converts to UTC, and schedules `at(...)` in
  UTC. No ambiguity.
- **Reporting is presentation only.** Stored UTC is converted to the org zone
  (or a per-admin preference) for display, and day-bucketing (e.g. opens/day)
  uses that zone's local midnight. No local times are ever stored.

Distinct future feature: **per-subscriber send-time optimization** (deliver in
each *recipient's* local zone) — that keys off the subscriber's zone, not the
org's, and is separate from this setting.

### 4.22 Re-engagement & sunset automation

Mailing addresses that never engage drag down deliverability — mailbox providers
weight sender reputation on engagement, so a growing tail of dead addresses hurts
inbox placement for *everyone* on the list. addressium closes the loop with an
opt-in, per-org **win-back → sunset** automation (`Organization.reengagement`).

- **Coldness is click-weighted.** Each subscriber carries a `lastEngagedAt`
  stamp that the events processor advances on **clicks only**. Opens are
  deliberately ignored: Apple Mail Privacy Protection (and similar proxies)
  auto-open messages, so an open no longer proves a human looked. `coldnessAnchor`
  falls back to the consent time when there's no click yet, and subscribers with
  no anchor at all are left alone (never mailed → can't judge).
- **Win-back sequence.** Once someone has not clicked for `coldAfterDays`
  (default 180) and still has an active subscription, a daily sweep enrolls them
  and sends `steps` win-back emails (default 3) spaced `stepIntervalDays` apart
  (default 7). Each step is its own `reengagement:{list}#{n}` sub-campaign, so its
  engagement aggregates separately and the send is idempotent.
- **Graduate or sunset.** A click at any point during the sequence graduates the
  subscriber back to engaged (enrollment cleared). If the sequence completes with
  no click, they're **unsubscribed from every list** and suppressed with
  `source: "inactive"` (org-scoped). Because that source is self-clearable (§4.13,
  #58), a later genuine re-opt-in restores them.
- **How it runs.** The decision is a pure per-subscriber state machine
  (`decideReengagement`); the batch orchestrator (`runReengagementSweep`) is
  invoked by the automations service on a recurring EventBridge schedule, the same
  mechanism recurring editions and drip journeys use.

### 4.23 Reporting read-model (analytics tier)

The DynamoDB table is tuned for the **sending** path — key-based reads/writes,
partitioned by org and campaign. Cross-campaign cohort questions ("how many
subscribers engaged with ≥K of the last N editions", funnels, retention, per-user
history) are the opposite access pattern: wide scans and aggregations that would
be slow and expensive against DynamoDB and would put reporting load on the
sending path. So reporting is a **separate read-model** (CQRS) — an opt-in
(context `enableAnalytics`), append-mostly copy of the data in a columnar data
lake that reporting owns and can be rebuilt from at any time.

- **Fact tier (near-real-time).** The table streams every change to a **Kinesis**
  stream; **Firehose** reads it and invokes a small transformation Lambda that
  keeps only engagement-event inserts and flattens each to a columnar row, landing
  newline-delimited JSON in **S3** under `events/org_id=…/event_date=…/`
  (dynamically partitioned). A **Glue** table with **partition projection**
  catalogues it — no crawler, partitions resolve at query time.
- **Dimension tier (nightly).** A scheduled **point-in-time export** dumps the
  whole table to `entities/` with **zero read-capacity cost** (it reads continuous
  backups, not the table), giving subscriber/campaign/list snapshots to join
  against.
- **Query.** **Athena** SQL against the `events` table, in a per-deployment
  workgroup. See `docs/reporting/queries.sql` for the canonical cohort/funnel
  queries. Partition pruning on `org_id` + `event_date` keeps scans (and cost)
  small; storage is cheap S3 at rest.
- **Clicks over opens.** Reporting weights **clicks**; opens are MPP-inflated and
  reported only for comparison (§4.22).
- **Freshness is deliberately decoupled.** Facts are seconds-to-minutes behind
  (Firehose buffering); dimensions up to a day. That lag is fine for reporting and
  is the price of keeping the analytics plane off the sending path. GDPR erasure
  (§4.19) must also reach the lake — rewrite/rebuild affected partitions.

---

## 5. Data model

DynamoDB **single-table** design with targeted GSIs. **Every item carries an
`orgId`** as (part of) its partition key so silos never intermix (§4.11).
Entities:

| Entity | Purpose | Key notes |
|---|---|---|
| **Organization** | A silo | name, domain(s), subscriber pool ID, `magicLink` {kmsKeyArn, kid, issuer, audience}, SES config set, IP mode (shared/dedicated), suppression scope, **defaultTimezone** (IANA), setup state |
| **AdminMember** | Staff ↔ role ↔ orgs | admin-pool `sub`, role, org-scope list, MFA state (in admin pool) |
| **Role** | Capability set | named set of capabilities (built-in + custom) |
| **Subscriber** | Durable person record | **keyed by (`orgId`, Cognito `sub`)**; email (normalized), attributes, locale, source, consent {timestamp, ip, url}, global status, `entitlement` (free/paid) + `entitlement_asof` |
| **List (Newsletter)** | A named audience | opt-in policy, from-address, reply-to, compliance footer, physical address, **access** (free/paid), **visibility** (open/closed on the opt-in page) |
| **Subscription** | Subscriber ↔ List join | per-list status: `pending`/`confirmed`/`unsubscribed`/`bounced`/`complained` |
| **Segment** | Saved filter | predicate over attributes + engagement; resolved at send time |
| **CampaignSeries** | Recurring newsletter | cadence, **owns template + ad-tag fills**, aggregate counters across editions |
| **Campaign** | A send (edition or one-off) | type (one-off / series edition), series ref, audience, schedule, sending config, A/B config, hot counters |
| **Template** | Reusable content | authoring mode (visual/MJML/raw-HTML), MJML/HTML source, versioned, declared merge-tags + **ad slots** |
| **MergeTag** | Replacement variable | source (profile/feed/system/token-claim), scope, example, fallback |
| **AdSlotFill** | LiveIntent HTML in a slot | slot id, HTML, binding (series or campaign), edition/version |
| **Feed** | Content source | RSS/Atom/JSON URL, field→merge-tag mapping, pull interval, target list |
| **ABTest** | Subject test | variants, split, winner metric, decision window, result |
| **Event** | Engagement log | append-only: sent/delivered/open/click/bounce/complaint/unsub, attributed by tags; magic-link tokens redacted |
| **SuppressionEntry** | Do-not-send | source (bounce/complaint/manual/unsubscribe), **scope** (global/org), enforced pre-send |
| **EmailArchive** | Generic rendered copy | S3 pointer + link-map (`link-id → url template, position, label`); one per campaign/step |
| **EntitlementSync** | Sync audit | last inbound entitlement update per subscriber (source, value, timestamp) |
| **AlertConfig** | Deliverability alerts | SNS topic ARN, rules + warn/halt thresholds, notify targets |
| **AuditEntry** | Immutable action log | member, org, action, target, timestamp |

### Access patterns → GSIs

- **Org scoping**: `orgId` prefixes partition keys, so every access pattern is
  implicitly silo-scoped; cross-org reads are impossible by construction.
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
- **Suppression**: enforced before every send with a configurable scope model
  (hybrid default — §4.13); hard bounces and complaints auto-suppress.
- **Complaint-rate protection**: monitor complaint/bounce rates and auto-throttle
  or halt sending as they approach SES thresholds; breaches also fire alerts to
  the operator's SNS topic (§4.18). Per-org configuration sets isolate metrics;
  an optional per-org dedicated IP pool isolates reputation (§4.11).
- **Tracking**: SES configuration-set open/click tracking on **editorial** links
  via an operator-owned tracking domain; **ad tags are excluded** (§4.14).

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

> Full threat model, standards mapping (OWASP ASVS / API Top 10, NIST 800-63B,
> RFC 8725, CIS, SLSA), and the hardened magic-link reference verifier live in
> [`SECURITY.md`](./SECURITY.md). This section is the summary.

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
- **Server-side RBAC**: capability + org scope checked on every mutating handler
  (§4.12); the console UI is a convenience, never the boundary.
- **Tenant isolation**: `orgId`-partitioned data + per-org Cognito pools and KMS
  signing keys mean silos can't read each other's data or verify each other's
  tokens (§4.11).
- **Immutable audit log** of privileged actions (§4.19).

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
- **Environments**: one deployment hosts **multiple organizations** (§4.11);
  `dev`/`prod` stacks via CDK context. Adding an org provisions its per-org
  resources (pool, KMS key, SES identity, config set, JWKS) at runtime via the
  `provisioning` service.
- **Cost posture**: near-$0 at idle (on-demand DynamoDB, Lambda, S3, no
  always-on compute or DB). Dominant cost is SES (~$0.10 / 1,000 emails) plus
  egress. The optional OpenSearch mirror is the only component that adds a
  standing cost, and it is opt-in.

### 9.1 Bootstrapping the admin pool & first login

The console is authenticated by the **admin Cognito pool**, which creates a
chicken-and-egg: you need to sign in to manage the system, but nobody exists to
sign in until something creates the pool and a first user. addressium resolves
this at deploy time, so no manual pool setup is ever required:

- **The admin pool is control-plane infrastructure** created by `cdk deploy` —
  not something the operator builds by hand and pastes in. It is singular and
  shared across all organizations (§4.12).
- **The first admin user is seeded from config.** The operator copies
  `addressium.config.example.json` → `addressium.config.json` and lists one or
  more `adminEmails`. The deploy creates those users in the pool; Cognito emails
  each a **temporary-password invite**. They sign in, set a password + MFA, and
  from there **invite the rest of the team through the console**.
- **Only bootstrap values live in config** (admin email(s), stage, region,
  hosted-UI prefix). Everything else is managed in-app afterward.

This is deliberately different from the **per-org subscriber pools**, which are
**not** in the bootstrap config: each is either **created** or **linked to an
existing pool** (the one shared with that org's main website) during "Add
organization" (§4.11). The admin pool is created once; subscriber pools come and
go with organizations.

### Proposed repository layout

```
addressium/
├── apps/
│   ├── admin-web/         # React admin SPA (operator console)
│   ├── subscriber-web/    # subscriber signup + Cognito login + preference center
│   └── public-web/        # embeddable signup snippet + hosted / confirm / unsubscribe pages
├── packages/
│   ├── core/             # shared domain types + zod schemas
│   ├── segment/          # segment engine (GSI/tags impl; OpenSearch drop-in)
│   └── rbac/             # capability/role definitions + server-side authorization
├── services/
│   ├── api/              # API Gateway handlers: entitlement-sync, RBAC enforcement, merge/ad tags, alerts
│   ├── sender/           # SQS consumers → SES SendBulkEmail (throttled) + archive/link-map + ad-tag inject
│   ├── events/           # SES event processor → counters + link-agg + token redaction + Firehose + alerts
│   ├── automations/      # Step Functions drip/journey state machines
│   ├── reporting/        # dashboards + click-overlay + series aggregation + A/B results
│   ├── tokens/           # magic-link JWT minting + KMS signing + JWKS endpoint
│   ├── provisioning/     # "Add organization" — creates per-org pool, KMS key, SES identity, config set, JWKS
│   ├── feeds/            # RSS/Atom/JSON pull → merge-tag mapping
│   ├── privacy/          # GDPR/CCPA export + erase-to-tombstone; audit log
│   └── importer/         # Pinpoint / CSV migration importer
├── infra/
│   └── cdk/              # all CDK stacks + setup wizard (per-org provisioning)
└── docs/
    └── ARCHITECTURE.md   # this document
```

---

## 10. Roadmap (indicative)

- **v1 — Core email platform**: multi-org silos + RBAC, lists (open/close),
  signup + double opt-in, subscribers, templates (visual/MJML/raw-HTML),
  merge tags + ad tags, broadcasts + ongoing series with aggregate reporting,
  suppression (hybrid), deliverability (DKIM/DMARC/one-click unsubscribe) + SNS
  alerts, analytics + click overlay + A/B, sandbox mode, GDPR/CCPA + audit log,
  Pinpoint/CSV importer, CDK deploy + per-org provisioning.
- **v1.x**: drip automations (Step Functions), materialized-tag segment builder,
  magic-link token service (JWKS + entitlement sync + lite-scope tokens),
  feeds → campaign auto-build, preference center polish.
- **v2 — Extensibility**: OpenSearch segmentation drop-in, visual
  automation/journey builder, SSO/SAML for the admin pool.
- **v3 — Multichannel**: activate the channel-agnostic seams for SMS
  (SNS / AWS End User Messaging) and push.

---

## 11. Open questions for later phases

- **Rendering fidelity**: whether to add a rendering-preview service (multiple
  client previews) or rely on test sends in v1.
- **Per-org billing/usage metering**: optional, for operators who want to
  chargeback sending cost across their publications.
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
