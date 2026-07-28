# addressium — Architecture & Design

> An open-source, self-hostable replacement for the email capabilities of
> **Amazon Pinpoint**. Deploy it into your own AWS account, verify a sending
> domain, and run email lists, signup forms, broadcasts, and drip automations —
> all serverless, at near-zero idle cost.

- **Status:** Built, never deployed. Most of §4 and all of §6 ships in the repo
  and is tested; **no AWS account has ever run it**. See §13 for the honest list
  of what is not yet proven.
- **Audience:** Contributors and operators evaluating or building addressium
- **Scope of this document:** the canonical system design, aligned to
  [`DESIGN-COMPENDIUM.md`](./DESIGN-COMPENDIUM.md) (revision 2), which is the
  authoritative decision record. This document describes the **target state**.
  Where a decision is not yet in the code, it is tagged inline
  **[Decided r2 — not yet built]** — so no reader mistakes a decision for a
  deployed fact.

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
5. **A deploy an operator can trust** — a one-time bootstrap stack and a
   permissions boundary, then a single gated `npm run deploy` (§9). An operator
   should get to "verified domain, first list, first send" quickly, without ever
   handing admin credentials to a pipeline.
6. **Multi-org by design** — one deployment runs many isolated publications: a
   shared control plane (admin, API, console) over per-org data, identity and
   sending silos, with role-based access scoped to each org.

---

## 2. Scope

### In scope (v1)

- Email channel via **Amazon SES v2**
- Subscriber & list management with per-list subscription status
- Public **signup forms** (embeddable snippet + hosted landing pages)
- **Double opt-in** confirmation (configurable per list), one-click unsubscribe,
  and a token-based preference center (**[Decided r2 — not yet built]**, §4.10)
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
- **Sandbox / test mode** (§4.17), **deliverability alerts to SNS** (§4.18), and
  **GDPR/CCPA export & erasure + audit log** (§4.19)
- **Engagement analytics & reporting dashboards**: sends, deliveries, opens,
  clicks, bounces, complaints, unsubscribes — real-time counters, queryable
  event history, per-campaign funnels, and link performance
- **Email archive + click overlay**: a copy of every generic (per-campaign)
  rendered email is stored, so reporting can overlay per-link click data on the
  actual email — a click map
- **Subscriber identity owned by addressium**: the **subscriber record is the
  primary identity**. `Subscriber.sub` is a durable id addressium mints at
  signup and keys the profile, subscriptions and entitlement off. A per-org
  Cognito pool is **optional and read-only** — an org that already runs one for
  its own website can link it, joined on `Subscriber.externalId`; addressium
  never owns or writes to it (see §4.10)
- **Magic-link SSO tokens**: editorial newsletter links carry a per-recipient
  signed token that logs the reader into a *lite, content-only* session on the
  main website and removes the reg/paywall overlay (soft paywall — see §8.1),
  carrying an `entitlement` (free/paid). addressium mints and signs the token
  with a per-org **KMS ES256** key and publishes the **public half as JWKS**; the
  main site verifies and applies it (client-side, on a CloudFront-cached page —
  that sign-in logic is out of scope, see §12). No shared secret is ever
  distributed
- **Editorial vs advertising link handling**: the sender adds tokens + click
  tracking to **editorial** links only; **LiveIntent advertising** links are left
  untouched (no token, no tracking)
- **Migration importer**: generic CSV ingest today; reading a real Pinpoint
  export — dotted-column CSV *and* gzipped JSON Lines, with
  `OptOut`/`EndpointStatus` honored and `Attributes.*` mapped to audiences — is
  §4.7 and **[Decided r2 — not yet built]**
- **Admin console** (React SPA) protected by Cognito
- **Infrastructure as code** via AWS CDK (TypeScript), behind a one-time
  bootstrap stack and a permissions boundary (§9)

### Out of scope (v1, designed for later)

- SMS, push, voice, in-app channels (seams exist; not built)
- Ad-hoc arbitrary segmentation at scale (the OpenSearch mirror is a documented
  drop-in, **opt-in and off by default** — §5)
- Deep ad-hoc analytics (the Kinesis/Firehose/Glue/Athena read-model is
  **opt-in and off by default** — §4.23)
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
| Migration | CSV importer now, Pinpoint export next (§4.7) | Adoption hook for the "Pinpoint is ending" moment |
| Email archive | Generic copy per campaign | Powers the click overlay; tiny storage; no recipient PII or tokens at rest |
| Subscriber identity | addressium's own subscriber record | Works with Cognito, Auth0, custom JWT or no accounts at all; a pool is an optional link, never a dependency |
| Cognito linkage | Optional, read-only, joined on `externalId` | Coupling to a pool would make the product only work for Cognito shops; the pool is the org's, not ours |
| Magic-link token | Asymmetric JWT + JWKS | Verified **client-side** on a cached page — a shared secret would leak and be forgeable; asymmetric ships only the public key |
| Token placement | URL fragment (`#tok=`) | Never sent to CDN/origin, no logs/Referer leak, never in the cache key; fall back to query param only if it can't survive the SES redirect |
| Paywall model | Soft / cosmetic (client overlay) | Content stays in the page for SEO/Google indexing; token removes the overlay; graceful fallback to the wall on any token failure |
| Entitlement | free/paid, staleness bounded by TTL | Client trusts the token's entitlement for its lifetime; churn self-corrects at expiry |
| Token posture | Long-lived, low-privilege (lite scope) | Best newsletter UX; forwarded links can only ever read content, never touch account |
| Token redemption | Reusable within TTL, stateless | No callback to addressium; keeps the two systems decoupled |
| Entitlement freshness | Synced from system of record | addressium's entitlement copy stays current; token also stamps `entitlement_asof` |
| Tenancy | Multi-org, one AWS account, logical silos | Run many publications from one deployment; not account-per-org |
| Org isolation | Per-org KMS key + SES identity (+ optional linked subscriber pool); pooled DynamoDB by `orgId` | Isolate signing/sending/identity; keep data infra cheap and shared |
| Account-wide services | Consume, don't create (WAF, ops alerting) | A production account already runs these; a second competing copy duplicates cost and bypasses the operator's own posture |
| Analytics posture | DynamoDB always on; columnar lake opt-in, off by default | No standing analytics bill for a system whose core job is sending email |
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
   Public visitors ──▶  Signup / confirm / unsubscribe pages                │
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
             Hot counters + append-only Events log (DynamoDB)
```

That is the whole always-on system. The columnar analytics lake (Kinesis →
Firehose → S3 → Athena/Glue) and the OpenSearch segmentation mirror are
deliberately **not** in this diagram: both are opt-in, off by default, and no
core path depends on either (§4.23, §5, §7).

Two gaps between the diagram and the deployed stack, each marked
**Now built** (#218): the **SQS hop between SNS
and the events Lambda** (§4.5 — today the Lambda is subscribed directly to the
topic) and the **hot counters** (§7 — today every figure is derived by folding
the event log on read).

### Request/data planes

- **Public plane** (unauthenticated, behind an **operator-supplied WAF** (§4.3),
  rate-limited, honeypot + optional CAPTCHA on signup): signup, double-opt-in
  confirmation, one-click unsubscribe. Tokenized/signed so a request can only
  affect the acting subscriber.
- **Subscriber plane** (unauthenticated, **token-based**): signed confirm and
  unsubscribe links let a subscriber act on their own record with no account and
  no login. Signed **preference** links, which would let them manage list
  memberships and attributes the same way, are
  **[Decided r2 — not yet built]** (§4.10).
- **Admin plane** (Cognito-authenticated via a **separate admin pool**, staff):
  list/subscriber/segment/campaign/template/automation management, analytics, and
  settings. Every request carries a **role + organization scope**, enforced
  server-side (§4.12); all data access is partitioned by `orgId` (§4.11).
- **Sending plane** (async): campaign launch → segment resolution → suppression
  filter → SQS fan-out → throttled SES send.
- **Event plane** (async): SES events → SNS → SQS → processor → event log +
  counters + suppression + link aggregation (magic-link tokens redacted).
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
  click-map overlay, plus a single derived **system health: OK / degraded**
  badge (§9.2). Raw CloudWatch alarms deliberately do not surface here — a
  marketer does not care about Lambda throttles (§9.2)
  **[Decided r2 — not yet built]**
- **Audience** — newsletters (create, open/close signups), subscribers (detail +
  manual unsubscribe/suppress), segments, and suppression (§4.13)
- **Messaging** — campaigns (compose → audience → review; one-off vs series),
  templates (3 authoring modes), automations
- **Developer** — feeds, merge tags, ad tags, identity & pools, data & exports,
  API keys & webhooks
- **Configure** — organizations (silo management + setup), roles & access,
  settings (domains/DKIM/DMARC, magic-link & entitlement, alerts & SNS,
  privacy & data, team), audit log. **Creating** an org is not one of these
  screens: today it is an authenticated `POST /orgs` made with the JWT the
  console holds, and `apps/admin-web` has no call for it
  **[Decided r2 — not yet built]**
- A **Live/Sandbox** toggle (§4.17) is always visible in the top bar

### 4.2 Public site (`apps/public-web`)

Static pages + minimal JS on S3/CloudFront:

- **Embeddable signup snippet** — a `<script>` operators drop on any site;
  posts to the public API.
- **Hosted signup pages** — for operators without their own site.
- **Confirmation page** — landing target for the double-opt-in link.
- **Preference center** — subscriber self-manages list memberships and
  attributes via a signed, tokenized link (no login).
  **[Decided r2 — not yet built]** (§4.10).
- **Unsubscribe page** — one-click, honored globally or per-list.

### 4.3 API (`services/api`)

API Gateway HTTP API → Lambda. Two authorizer scopes:

- **Admin routes**: Cognito JWT authorizer. 33 routes carry it; 27 of those are
  the admin-console routes, which all dispatch through **one** router function
  (§9.4).
- **Public routes**: 10 routes with no auth — signup, batch signup, confirm,
  unsubscribe, version, public list, public branding, the JWKS endpoint, and the
  two HMAC-signed webhooks. They are defended by an operator-supplied WAF, a
  server-side honeypot and optional reCAPTCHA on signup, and tokenized/signed
  links for confirm/unsubscribe so a request can only affect the subscriber the
  token encodes.

Handlers are thin: validate (zod schemas from `packages/core`), authorize,
mutate DynamoDB, enqueue async work. No business logic in the frontend.

- **Entitlement sync endpoint**: a dedicated, authenticated **operator API /
  webhook** receives entitlement updates from the operator's billing /
  subscription **system of record** and writes `entitlement` + `entitlement_asof`
  onto the subscriber. This keeps the value addressium mints into magic-link
  tokens near-real-time. Authenticated with a scoped machine credential (API
  key / signed webhook), separate from the Cognito operator auth. Idempotent by
  `(subscriber, source, version)`.

**WAF is operator-supplied, not created here** (compendium #30/#31/#66). A
production AWS account very likely already runs a WebACL with tuned rules;
shipping our own would be a second, competing ACL that duplicates cost, fights
the operator's existing rules, and at ~$17/month was 77% of idle cost. The
operator attaches a **REGIONAL** ACL to the HTTP API stage and a
**CLOUDFRONT**-scope ACL (which must live in `us-east-1`) to the two
distributions, with the AWS managed common + known-bad-inputs rule sets, a per-IP
rate limit, and optionally a CAPTCHA rule on `/signup`.
**Now built** (#225) — the stack creates no WebACL; `infra/cdk/lib/waf.ts` is retained only as the source of the managed-rule exclusions the operator runbook needs
and the stack still associates them, unconditionally, in every stage; and the
stack emits **no** API stage ARN or distribution ARN for an operator to attach
their own to.

**Signup bot protection** (#40, #170, #230). The server-side honeypot check runs
before any work is done, and a tripped trap returns a silent `202 pending` so a
scraper cannot tell it was caught. **Both** first-party clients render the trap:
the embed widget always did, and the hosted signup page — the one addressium
itself serves and links from the subscriber directory — was the gap #230 closed.
That asymmetry is what made it easy to miss, since anyone testing the embed saw
the protection work.

The field is off-screen rather than `display:none` (a bot that skips obviously
hidden inputs still fills it) with `aria-hidden` and `tabindex="-1"` keeping
humans out instead. Its name comes from `HONEYPOT_FIELD` in `@addressium/core`,
consumed by the check and by both React clients; `embed.js` is served as a plain
static script with no build step and cannot import it, so a test asserts the two
still agree. A drifted name fails **open** — the trap stops matching, every bot
passes, and the silent `202` means nothing reports it.

reCAPTCHA verification runs when — and only when — the org configures
`signupProtection.recaptchaSecretArn`, so it is **off by default** and does not
compensate for a missing trap.

### 4.4 Sender (`services/sender`)

- Campaign launch resolves the target segment to a recipient stream.
- Each recipient is checked against the **suppression list** (account + list
  level) before enqueue — **and** against their own `Subscriber.status` (#193).
  Two checks because they fail in opposite directions. The suppression list is
  keyed by EMAIL: authoritative and cross-org, but blind the moment an address
  changes, so renaming a complainer used to make them mailable again while their
  own record still read `suppressed`. `status` is keyed by the durable `sub` and
  survives every rename, but is org-local and knows nothing of a global
  complaint against an address this org has not seen. Each covers the other's
  gap. On an identity-sync email change the tombstone is **copied** to the new
  address, keeping its original `source` and `addedAt` — "suppressed since the
  complaint" is what a deliverability dispute turns on — and the old entry is
  deliberately left in place, because deleting it would make a complainer
  mailable if the rename itself turns out to be the mistake.
- Recipients are batched onto **SQS**; sender Lambdas consume batches, render
  the MJML template with per-recipient merge variables, and call SES
  `SendBulkEmail` (up to 50 destinations/call).
- **Fan-out slices are KEY RANGES over subscriber ids, never offsets** (#171).
  The recipient set changes while a large send runs — people confirm and
  unsubscribe — and DynamoDB returns rows ordered by subscriber id, so a new
  signup lands at a random position and shifts every later index. Slices planned
  as `{offset, limit}` at T0 and re-sliced against the set at T1..Tn therefore
  skipped and duplicated recipients silently: an unsubscribe before a window
  dropped the previous window's last recipient, a confirmation before it sent
  them twice. A range's boundaries are ids fixed at plan time, so a mutation
  elsewhere cannot move them; the windows are disjoint and contiguous, and the
  last is open-ended so someone confirming mid-send is picked up rather than
  dropped past the final boundary.
- A **token-bucket throttle** keeps aggregate send rate within the account's SES
  quota. The bucket is per-INVOCATION, and SQS→Lambda scales the sender out, so
  the cap and the rate have to be set together (#176): the event source bounds
  concurrency, and the sender divides the account rate by that same number. One
  CDK value feeds both — a cap of 5 with the sender told 10 is worse than
  neither, because it looks configured. Drip and re-engagement pace themselves
  from a fraction of the same quota, since they run alongside campaigns.
- **Public routes reserve concurrency** so a large send cannot starve them.
  `/unsubscribe` gets the largest reservation: "we could not process your
  unsubscribe because we were busy sending you email" is a compliance failure,
  not a slow page.
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

- Appends to the **Events** table (append-only engagement log). Redelivery is
  harmless: the sort key carries a **deterministic `eventId`**, so a repeated
  event overwrites its own row rather than double-counting.
- Updates **hot counters** on the campaign record.
  **[Decided r2 — not yet built]** — nothing increments them today.
  `Campaign.counters` is zero-initialized and never advanced, so the campaigns
  list reports `sent: 0` and usage rollups sum zeros; every real figure is
  derived by folding the full event log on read (§7). Compendium #57 closes this
  by writing the event and incrementing the counter in **one
  `TransactWriteItems`**, made exactly-once by the deterministic `eventId` above
  — which is the half that already exists.
- **Aggregates clicks by link-id** (resolving the clicked URL back to the
  link-id assigned at archive time) so the click overlay has per-link totals and
  unique counts.
- **Redacts magic-link tokens before persistence.** SES click tracking reports
  the full destination URL of an editorial link, which carries the bearer token
  (in the URL fragment, or a query param on the fallback path). The processor
  **strips the token** before anything is written, so magic-link credentials
  never land at rest — not in the Events table, and not in the opt-in analytics
  tier if an operator enables it.
- On **hard bounce / complaint**, adds the address to the **suppression list**
  and flips the subscription status; monitors complaint rate and **auto-throttles**
  if it approaches SES thresholds.

**Why SQS sits between SNS and the Lambda** (compendium #20/#44). Subscribing a
Lambda straight to an SNS topic is an **asynchronous** invocation: AWS retries
twice and then **discards the event permanently**, with no dead-letter queue. A
dropped bounce is an address you keep mailing — reputation damage that compounds
silently and is invisible until deliverability is already gone. Throughput was
never the concern here; at the paced SES send rate, events arrive well inside
Lambda's capacity. **Durability is.** An SQS queue in the middle gives durable
buffering when the handler is broken or throttled, a real **DLQ** for events that
fail repeatedly, batching with **partial-batch-failure reporting** — the same
mechanism the sender already uses, so one poison event no longer fails its batch
peers — and burst absorption without leaning on Lambda concurrency. Cost at this
volume is effectively zero. This is strictly better than both the SNS→Lambda
wiring and a Kinesis pipeline, which is the real answer to "do we need Kinesis to
accept bounces?" (no).

**[Decided r2 — not yet built]** — the deployed stack still does
`sesEvents.addSubscription(new LambdaSubscription(eventsFn))`. There is no events
queue and no events DLQ; the only queues in the template are the send queue and
its DLQ, and the only event-source mapping is SendQueue → SenderFn.

**Analytics streaming is opt-in.** With the `enableAnalytics` context flag set,
the table also streams to Kinesis → Firehose → S3 for Athena (§4.23). It is
**off by default**, and nothing in the event plane depends on it.

### 4.6 Automations (`services/automations`)

Step Functions state machines model drip sequences: `Wait` states for delays,
`Choice` states for branching on engagement/attributes, tasks that enqueue sends
through the same sender pipeline. Triggers: subscription confirmed (welcome
series), inactivity (re-engagement), attribute change, or manual enrollment.
EventBridge Scheduler drives time-based enrollment and scheduled/recurring
campaigns.

**Scheduling policy — every send goes through a schedule, and one-offs keep a
lead window.** Both "send now" and "send at" create a **one-off schedule placed
at least 5 minutes in the future** (`MIN_ONEOFF_LEAD_MS`), so an operator has a
window to pause before anything leaves. A requested time further out is honored
as-is. Recurring series use a timezone-aware cron (§4.21).

**Composing a send.** The console's **Compose & schedule** screen builds a send
inline — newsletter, subject, and a body of text + editorial-link blocks — and
`POST /campaigns/schedule` (validated by `scheduleCampaignSchema`) dispatches it
now, at an instant, or on a recurring cron. The scheduled send then shows up in
the Schedules screen below, where its lifecycle is managed.

**Send lifecycle — start · pause · archive, never delete.** Every scheduled send
carries a `SendScheduleState` record (`active` | `paused` | `archived`) that is
the **source of truth** for whether it may fire. `POST /campaigns/lifecycle`
transitions it; the console's **Schedules** screen exposes the three actions.

- **Recurring series** are gated in the launch handler: a paused/archived series
  keeps its EventBridge schedule ticking but builds and enqueues **no edition**,
  so `close a newsletter` is no longer the only lever — you can stop a daily send
  outright and resume it later.
- **One-off** sends are gated in the campaign sender **before** the idempotency
  claim, so pausing doesn't burn the claim — and the send is **parked on its
  lifecycle record**, then re-enqueued on resume (#179).

  The parking is what makes "a resumed send still goes out" true, and it was not
  true before. A one-off's EventBridge schedule fires once and deletes itself, so
  by the time the sender sees `paused` the schedule is already gone; returning
  `skipped` let SQS delete the message too, and the send simply ceased to exist.
  Resume-then-Start produced nothing, silently. The parked descriptor carries the
  template, so the resumed send does not have to be reconstructed from a draft
  that may have changed since; its fan-out **slice is dropped**, so it re-fans
  against the recipient set as it stands on resume rather than one snapshotted
  before the pause.

  **Archive discards the parked send.** A terminal state that leaves something
  waiting to fire is not terminal.
- We **never delete** the EventBridge schedule or the record — pause is
  reversible and archive is a terminal "put it away" that retains history. (This
  is why scheduling needs only `scheduler:CreateSchedule`, not `DeleteSchedule`.)

### 4.7 Importer (`services/importer`)

**Today it reads CSV, and only CSV.** The parser splits on newlines and commas;
recognised columns map to the subscriber, everything else lands in the generic
attribute bag. It runs behind the admin API with a **dry-run preview**, dedupe by
normalized email, and an import report (created/updated/skipped/errored). Every
imported subscription defaults to **`pending`** (#192), so an import can never
silently start mailing a list.

**Reading a real Pinpoint export** (compendium #59, #216). A verified real-world
export is **CSV with dotted column paths**, not the gzipped JSON Lines an export
*job* produces — the CSV is what operators actually hold, and it is the shape the
mapper targets. The sample carries 73 columns: `Id`, `ChannelType`, `Address`,
`EndpointStatus`, `OptOut`, `EffectiveDate`, `Location.*`, `Attributes.*` and
`User.UserAttributes.*`. The original parser looked for a lowercase `email`
header and read that file as one unusable row; the mapper below replaces it and
is not Pinpoint-specific — any CSV maps the same way.

Four structural facts that shape the work, each verified against the sample:

- **List membership lives in `Attributes.*`**, one boolean column per newsletter —
  not in a separate segment file. So the importer's job is largely
  column-to-audience mapping, which is what makes the wizard below load-bearing.
- **Those columns are three-state: `true`, `false`, and empty** — 26 of 50 were
  empty in the sample. **Empty means never asked; `false` means declined.**
  Collapsing them loses the distinction consent rests on.
- **A prefix denotes the publication** (`SD_`, `SH_`, `SP_`), and 13 unprefixed
  names *also* exist in prefixed form — `Sports` and `SD_Sports` both appear. One
  file can therefore span several orgs, and the duplicate pairs need an explicit
  precedence rule rather than a silent last-write-wins.
- **Not every `Attributes.*` column is a list.** `audiences`, `companyname`,
  `contactOwner` and `promotionsTest` are ordinary attributes; treating every
  column as an audience would invent newsletters.

`User.UserAttributes.*` carries real PII — `birthDate`, `gender`, name, address —
so an import writes far more personal data than an email address, which the
retention and erasure paths (§4.19) must account for. `EffectiveDate` is the only
date available, but it is an endpoint-update stamp, **not** proof of opt-in, and
must never be presented as consent provenance.

The hard requirement stands: **`OptOut` / `EndpointStatus` must never become
mailable.** `import-mapping.ts` detects both columns from their value shape and
marks the row non-mailable; `import-run.ts` then writes it as a subscriber with
no active subscription, so the record is kept — dropping it would lose the very
opt-out being declared — while nothing can mail it. A row-level opt-out outranks
a per-list `true`. Segment translation and suppression-list ingest remain
unbuilt: do not read "Pinpoint importer" as "your Pinpoint *suppression list*
survives the migration", because that file is imported separately.

**Import wizard** (compendium #60, #216 / #220 / #223). Before any row is
written, the admin declares:

- **(a) consent basis** — *explicit* (double opt-in evidence) or *implicit*
  (existing relationship), recorded on **every** imported subscription as the
  same `SubscriptionConsent` a double-opt-in signup writes, so a later dispute is
  answered per row rather than per file;
- **(b) a batch id** identifying this import run;
- **(c) target audiences** per column, choosing an existing list or creating one
  inline — a created list requires a from-address, compliance footer and physical
  address, since defaulting them would ship a CAN-SPAM violation.

`statusFor` derives the subscription status from the basis rather than trusting
the caller: only `explicit` can produce `confirmed`, so `implicit` plus
`status: "confirmed"` yields `pending`, not a mailable list that never opted in.
Three-state columns are honoured — `true` subscribes, `false` writes an
`unsubscribed` row so the decline survives the next import, and empty writes
nothing, because the subscriber was never asked.

Column plans are fingerprinted on the header set (order-insensitive) and saved,
so a re-export of the same shape is offered its previous mapping. Each run leaves
an **ImportBatch** record plus one pointer per membership it wrote, in a
partition of its own — so "what did that bad file do?" is a query rather than an
org-wide scan, and a run that dies halfway is still findable because the record
is written before the first row.

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
  (bounce/complaint) trends, and per-subscriber activity timelines. Numbers come
  from the DynamoDB event log (§7); deeper ad-hoc cuts come from the **opt-in**
  Athena tier if an operator turns it on (§4.23).
- **Retention**: archive objects follow an operator-configurable S3 lifecycle
  policy. Because archived bodies are generic (no baked-in recipient PII or
  tokens), they are safe to retain for the life of the reporting window.

### 4.9 Magic-link token service (`services/tokens`)

Mints the signed tokens embedded in newsletter links. **Scope boundary:**
addressium *issues and signs* tokens and *publishes the verification keys*; the
operator's main website *verifies* them and *establishes the session*. The
sign-in / Cognito session-exchange logic on the main site is **out of scope**
(see §12 for the contract).

- **Signing**: a **per-org asymmetric key in KMS** — `ECC_NIST_P256`,
  `SIGN_VERIFY`, signed with `ECDSA_SHA_256`, i.e. **ES256**, with the JWS `alg`
  header hard-coded rather than caller-supplied. The private half never leaves
  KMS. addressium publishes the public half at an unauthenticated **JWKS
  endpoint**, `GET /orgs/{org}/.well-known/jwks.json`, so the main website
  verifies offline with no shared secret and no callback. Asymmetric is
  **mandatory** here because verification happens **client-side on a cached
  page** (§8.1) — a shared secret would be shipped to the browser and become
  forgeable. Per-org keys mean one org's compromised key cannot forge another
  org's tokens.
- **`sub` is addressium's own subscriber id** — `Subscriber.sub`, the durable
  UUID minted at signup (§4.10), not a Cognito subject. The subscriber record is
  the primary identity. An org that runs a Cognito pool joins to it through the
  separate, optional `Subscriber.externalId`, which the token never carries.
  This is deliberate: it is what lets a site on Auth0, a custom JWT scheme, or no
  accounts at all consume magic links unchanged.
- **Token shape** (JWT claims):
  - `sub` — addressium's durable subscriber id
  - `scope: "content:read"` — **lite** access only
  - `amr: ["magic_link"]` — marks the session's origin so the main site can
    treat it as lite and force a step-up before anything sensitive
  - `entitlement` — `free` / `paid` (coarse tier) from the profile
  - `entitlement_asof` — freshness stamp for the entitlement value
  - `aud` (main site), `iss` (this deployment), `iat`, `exp` (long-lived, per §11)
- **The claim set is closed.** `mint()` takes `(orgId, sub, entitlement,
  entitlementAsof)` and both signers emit exactly the claims above — there is no
  extension point, so claim minimisation is enforced by construction rather than
  by policy. An **operator-configurable whitelist** of extra profile claims is
  **[Decided r2 — not yet built]**, and is worth weighing against the fact that
  the closed set is the stronger privacy posture.
- **Delivery**: minted per recipient, embedded in the **URL fragment** of
  editorial links (§4.4), so it is client-side only and never hits the CDN,
  origin, or logs.
- **Signing cost at volume** (compendium #14/#45): `mint()` is called **per
  recipient**, so a 500,000-recipient campaign makes 500,000 KMS `Sign` calls —
  roughly **$1.50** and measurable added latency on the send path. Not urgent at
  newsletter scale, and the fix is not a format change: cache a short-lived data
  key, or sign locally with a KMS-wrapped key.
- **Statelessness**: tokens are reusable within their TTL; addressium keeps no
  redemption state, keeping the two systems decoupled. Safety comes from the
  lite scope + bounded TTL + graceful fallback to the wall, not from single-use
  tracking.
- **Issued only to confirmed subscribers.**

See §8.1 for the security model (why lite + forwardable + soft-paywall is safe)
and §12 for the main-site integration contract.

### 4.10 Subscriber identity & self-service (`apps/subscriber-web`)

**The addressium subscriber record is the primary identity.** `Subscriber.sub` is
a UUID addressium mints at signup and never changes; it keys the profile, the
subscriptions, the entitlement, and the `sub` claim in every magic-link token
(§4.9). No user pool has to exist anywhere for addressium to run a list.

- **Signup is unauthenticated and pool-independent.** It records the subscriber
  profile keyed by `Subscriber.sub` and runs **double opt-in** confirmation. No
  account is created, and none is required.
- **Self-service is token-based, not login-based.** Signed, tokenized links let a
  subscriber act on their own record with no password. `apps/subscriber-web`
  ships no auth module and sends no `Authorization` header on any call. Built
  today: the newsletter directory, the subscribe-to-all view, **confirm** and
  **one-click unsubscribe** — four routes, no more. A **preference** link, which
  would let a subscriber manage list memberships and attributes the same
  tokenized way, is **[Decided r2 — not yet built]**: there is no preference
  route on the API and no preference page in any SPA.
- **Cognito linkage is optional and link-only.** An org that already runs a
  Cognito pool for its own website can **link** it, so addressium's subscribers
  line up with the site's users. addressium *references* that pool; it does not
  own it and never creates it. `Organization.subscriberPoolId` is optional and
  present **if and only if** `magicLink` is: an org with magic links off never
  touches Cognito at all, and the stack holds no `cognito-idp:CreateUserPool`
  permission anywhere. The join key is `Subscriber.externalId`, the pool's `sub`.

  The one write addressium performs is creating a **subscriber** in the linked
  pool, after that subscriber's double opt-in, with a random permanent password
  and Cognito's own welcome email suppressed — because the magic-link token
  carries the pool `sub` a paywall resolves against, and a subscriber with no
  pool account would get an unresolvable token. Nothing else is written; the
  pool's configuration is the operator's.

  That write lives in a **function of its own** (`SubscriberAccountFn`, #23),
  reachable from no route. `/confirm` — unauthenticated, linked from every
  confirmation email, the first route an attacker probes — invokes it
  asynchronously and holds `lambda:InvokeFunction` on that one function and
  nothing else. It cannot reach Cognito. The provisioner's grant is three
  enumerated actions, narrowed to the exact pool ARNs when the operator names
  them in `-c subscriberPoolIds=…`, with an explicit `Deny` on the admin pool
  that closes the escalation the wildcard fallback would otherwise leave open
  (#167). The pool id is re-read from the org record inside the provisioner
  rather than trusted from the invocation payload.
- **Identity sync works, in one direction.** The HMAC-verified
  `POST /webhooks/identity` route accepts upsert/delete from the operator's
  system of record, matches on `externalId`, reconciles an email-only subscriber
  created by public signup, re-points the email index when an address changes,
  and routes delete through the GDPR erase path (§4.19). The **other** direction
  — resolving a magic-link token back to the org's existing Cognito user — does
  not exist; nothing downstream reads `externalId` yet.
  **[Decided r2 — not yet built]** (compendium #45: this "needs finishing rather
  than replacing").
- **Two session tiers, owned by different systems.** A **lite** session
  (magic-link origin → content read + reg/paywall bypass, no profile) versus a
  **full** session (a real login). The lite half is built and enforced end to
  end: the token asserts `scope` and `amr`, and the reference verifier rejects
  anything that does not carry them (§8.1). The full half belongs to the
  operator's own site. **There is no subscriber login inside
  `apps/subscriber-web`, and r2 does not call for one** — the pool is the org's,
  not ours. That is a decision against building it, not a gap.

### 4.11 Multi-organization tenancy (silos)

A single deployment hosts **multiple organizations** (e.g. Northwind Times, Lakeside
Daily), each an isolated silo, all operated by the same owner.

- **One AWS account, logical silos.** A shared control plane (one admin pool, one
  API, one console, one CDK deployment) over per-org data and identity resources.
- **Per-org (siloed):** sending domain(s) + SES identity + **configuration set**,
  **KMS signing key + JWKS**, entitlement/billing sync, an **optional linked
  subscriber Cognito pool** (§4.10), and all
  subscriber/list/campaign/archive/event data.
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
- **Dev vs prod silos.** Each org carries an `environment` flag (`prod` by
  default, or `dev`). A `dev` org — e.g. `devsummitdaily.com` set up as its own
  root-domain silo, structured identically to the prod `summitdaily.com` — runs
  on the **exact same workflows and Lambdas**; nothing new is deployed. The flag
  only (a) surfaces a **DEV badge** in the console so an operator never confuses a
  test publication with a live one, and (b) lets cost/usage rollups **filter test
  spend** out — the `environment` field also rides along into the opt-in
  analytics tier for anyone who enables it (§4.23). Because a dev org is a full
  silo, it has its
  own SES identity, config set and reputation — so a dev blast can never touch a
  prod list or prod deliverability. As a second belt, a dev org enforces a
  **send-time allowlist** (`devAllowlist`: exact emails or `@domain` suffixes) on
  every recipient in both campaign and drip/transactional sends; it is
  **fail-closed** — a dev org with no allowlist sends to no one. Legacy org
  records with no flag are read as `prod` and are never gated.
- **Subscriber pool — optional, and linked when present.** An org may have no
  user pool at all; addressium runs a list fine without one (§4.10). Where the
  org's main website does run a pool, "Add organization" **associates the
  existing pool by ID** and addressium treats it as read-only reference data,
  joined on `Subscriber.externalId`. **[Decided r2 — not yet built]** — today
  the field is required and a `mode: "create"` path issues a real
  `CreateUserPool`.

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

**One send-time HTML pipeline.** Whatever the authoring mode, a body reaches the
sender as either structured **blocks** or an **HTML** string, and the per-recipient
render does the same security-relevant transforms: merge tags are
**escape-substituted**, every `<a>` gets the recipient's magic-link token in the
**fragment** plus a stable `data-linkid`, and a **link-map** is built for click
tracking.

**MJML compiles in the browser.** `visual`/`mjml` templates are compiled to HTML
client-side (`mjml-browser`, lazy-loaded), so no heavy compiler ships in a Lambda.
The compiled HTML is posted as `mjmlHtml` and **trusted as-is** — it is generated
by our own compiler from trusted-operator source and carries the `<!--[if mso]>`
conditional comments Outlook needs, which a sanitizer would strip.

**Raw HTML is hard-sanitized server-side.** Pasted `html` bodies pass a
`sanitize-html`-based allowlist sanitizer (adapters-aws `sanitizeEmailHtml`) at the
API trust boundary — on template save and on schedule — stripping `<script>`,
event handlers, and `javascript:`/`data:` schemes while keeping the tables, inline
styles, links and images email needs. Merge values are HTML-escaped separately at
render.

**Build status.** All three authoring modes are live: block bodies, raw HTML
(hard-sanitized), and **MJML** — authored as source *or* with the **GrapesJS**
drag-and-drop visual builder (`grapesjs` + `grapesjs-mjml`, lazy-loaded, browser
only). The visual builder outputs MJML, so it feeds the exact same client-side
compile → tokenize → send path as hand-written MJML; nothing about the pipeline is
editor-specific. The **Template** screen offers all three (visual mode embeds the
builder with a compile-and-preview), and **Compose** can send any of them.

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

These are **application** alerts about mail — "your complaint rate is climbing" —
and are aimed at the operator running the lists. They are a different concern from
**ops** alerts about the infrastructure ("EventsFn is throwing"), which are routed
per §9.2 — the external ops topic and the CloudWatch dashboard, both
**[Decided r2 — not yet built]**.

### 4.19 Privacy (GDPR/CCPA), export & audit log

- **Data-subject requests:** export one person's record (profile + subscriptions
  + entitlement) as JSON, or **erase / forget** them.
- **What erasure actually does, precisely:** unsubscribe every subscription,
  write a hashed suppression tombstone (§4.13) so the address can never be
  re-added, and anonymize the profile in place (email replaced with
  `erased:<sub>`, attributes cleared, consent dropped, status `suppressed`). It
  is **DynamoDB-only.** It does **not** reach the S3 archive or the analytics
  bucket, and it does **not** delete the engagement-event rows, which keep the
  pseudonymous `subscriberId`. That is defensible — the profile those ids resolve
  to is anonymized — but the honest description is "the profile is anonymized and
  the address is tombstoned", not "the person's data is gone". Erasure reaching
  S3 is **[Decided r2 — not yet built]** (#164).
- **Bulk export / portability** (compendium #58, #224). CSV **and** JSONL,
  including consent provenance, round-trip importable through §4.7 — because
  *users must be able to leave*, and an export nobody can read back is a file
  rather than portability. `GET /orgs/{org}/export` sits behind the destructive
  -tier capability, not the read-only one: taking an entire subscriber base out
  of the system is a privileged act, and it is audited (§4.19).

  **The response is a pointer, not the payload.** The file streams to a
  dedicated S3 bucket as it is produced and the caller gets a presigned URL
  valid for five minutes. Two reasons, both of which bite the largest org first
  — the one most likely to be leaving. An API Gateway response is capped at
  **6MB**, so returning the file inline failed for exactly that org; and holding
  the whole export in Lambda memory to return it is the OOM #182 is about.
  Subscribers are read one Dynamo page at a time (`SubscriberStore.stream`), and
  CSV takes a deliberate second pass to learn the attribute columns rather than
  buffering every row to discover them — the key set is bounded by the org's
  schema, the row set by nothing.

  The presigned URL is a **bearer credential for the whole subscriber base** and
  cannot be revoked, so its short lifetime is the control; object keys carry a
  random segment so one org's URL reveals nothing about another's, and the
  bucket expires every object after seven days regardless.
- **Consent provenance** (timestamp / IP / source URL) is captured on signup
  (#220) and on import as the same `SubscriptionConsent` shape (#223);
  configurable **event retention** (e.g. 13 / 25 months) supports compliance.
- **Audit log** (#29, #191): every privileged admin action (team changes,
  erasure, DSAR and bulk export, suppression edits, alert thresholds, org
  provisioning) is recorded **immutably** with member + org + timestamp, into a
  dedicated S3 bucket under **Object Lock**. Appending is best-effort by design —
  an audit write that fails must not roll back an action the operator already
  completed — and a failure is logged loudly rather than swallowed.

  **It is readable from the console.** `GET /orgs/{org}/audit`, gated on
  `team:manage`: the log names members and their actions, so it is the same
  administrative surface as Team & access, not a report an analyst may browse.
  `org=GLOBAL` reads the cross-org scope (org creation, pool linking) — a scope
  of its own rather than "every org", since merging them would let an operator
  scoped to one org read deployment-wide actions. A log nobody can read is a
  compliance artifact rather than a control: until this landed, "who exported
  subscriber data on the 14th?" was answerable only by an AWS console login,
  which is the dependency this section exists to remove.

  Keys are `audit/<scope>/<ISO timestamp>-<uuid>.json`, so they sort
  chronologically — but S3 lists only ASCENDING, and the question is always
  "what happened most recently". The reader therefore walks **day prefixes
  backwards** and stops once it has enough, so a recent page costs a handful of
  list calls no matter how much history sits behind it. The IAM grant is Put and
  Read, never Delete.

  Objects transition to **Glacier Instant Retrieval** after 90 days, not Deep
  Archive: a Deep Archive object cannot be fetched without a restore taking
  hours, so the viewer would fail outright on anything past the transition — the
  log retained and unreadable, which is the worst of both.
- **The Object Lock mode is GOVERNANCE, not COMPLIANCE** (compendium #9, #219).
  Both make a written object immutable for its retention window; the difference
  is recoverability. Under GOVERNANCE a sufficiently privileged principal can
  still remove an object with `s3:BypassGovernanceRetention`, so a
  misconfiguration — wrong retention, wrong bucket, an accidental flood — stays
  fixable, and it is the escape hatch erasure (§4.19) depends on. COMPLIANCE
  cannot be undone by anyone, including AWS, for the full window. The deployed
  default is a 2,555-day (7-year) retention with a `Retain` removal policy. Both
  the mode and `auditRetentionYears` are **set-once**: they fix what is stamped
  on every object written from then on, and cannot be relaxed afterwards.

### 4.20 A/B subject testing — future, not built

**Not in v1, and not in the codebase.** Compendium #63 cut it ("not required")
and the implementation was removed. Nothing in the API, the console, the data
model or the infrastructure creates, schedules or decides an A/B test. This
section keeps its number because §4.21–§4.23 are cross-referenced from code.

If it ever returns, the shape is two subject variants sent to a holdout split,
with a winner picked by open or click rate after a decision window and auto-sent
to the remainder. Note what that needs and never had: a scheduler to fire phase
two, an authoring surface, and a validated request contract.

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

### 4.23 Reporting read-model — opt-in, off by default

The DynamoDB table is tuned for the **sending** path. Cross-campaign cohort
questions ("how many subscribers engaged with ≥K of the last N editions",
funnels, retention) are the opposite access pattern — wide scans that would be
slow against DynamoDB and would put reporting load on the sending path. So there
is an optional CQRS read-model: an append-mostly columnar copy in S3 that
reporting owns and can rebuild at any time.

**It is not part of the core design, and it is deliberately kept** (compendium
#64 / #68, #228). #64 removed the streaming analytics stack from the *default*
posture — which is not the same as removing it from the codebase, a distinction
that was never written down and left this tier looking like an oversight. It
stays because standing cost when unused is genuinely zero and cross-campaign
cohort questions are the one access pattern DynamoDB cannot serve. Two CDK
context flags gate it, **off unless you set them**, and neither is set anywhere
in the repo:

| Context flag | What it adds |
|---|---|
| `enableAnalytics` | DynamoDB → Kinesis → Firehose → S3 (`events/org_id=…/event_date=…/`), a **Glue** table with partition projection (no crawler), an **Athena** workgroup, and two Lambdas — the Firehose transform and the on-demand table export |
| `enableOpenSearchMirror` | DynamoDB Streams → an **OpenSearch Serverless** collection and its indexer Lambda, the segmentation escape hatch (§5) |

A default synth contains **zero** Kinesis, Firehose, Glue, Athena and OpenSearch
resources, and the table carries no stream — asserted by a CDK test rather than
claimed here, so "off by default" fails the build if it stops being true. The
always-on analytics path is §7.

If you do turn it on: **Athena** SQL against the `events` table in a
per-deployment workgroup (`docs/reporting/queries.sql` holds the canonical
cohort/funnel queries), with partition pruning on `org_id` + `event_date` to
bound scan cost. Facts run seconds-to-minutes behind (Firehose buffering) and
dimension snapshots up to a day — that lag is the price of keeping the analytics
plane off the sending path. Reporting weights **clicks** over MPP-inflated opens
(§4.22). GDPR erasure (§4.19) must reach the lake too: rewrite or rebuild the
affected partitions.

---

## 5. Data model

DynamoDB **single-table** design with targeted GSIs. **Every item carries an
`orgId`** as (part of) its partition key so silos never intermix (§4.11).
Entities:

| Entity | Purpose | Key notes |
|---|---|---|
**Concurrency (#194).** Most writes are last-writer-wins by intent — a status
bump, an engagement stamp. Four are not, and each failed silently by telling the
caller it had succeeded:

- **Erasure** is a read-modify-write. A concurrent identity-sync upsert or CSV
  import landing between the read and the write restored the PII while the data
  subject was told their data was erased. `Subscriber.rev` is stamped by the
  store on every write — never accepted from a caller, so a lost race cannot be
  won by forging one — and `eraseSubscriber` writes conditionally on the rev it
  read. A lost race raises `ConcurrentModificationError` rather than reporting
  success.
- **`saveTemplate`** computes `version = existing + 1`. Two concurrent saves both
  wrote N+1, one body was lost, and the archive believed it had pinned two
  distinct versions. `version` is itself the revision, so the write is
  conditional on it and no second counter is needed.
- **`applyEntitlementSync`** recorded `version` and never compared it, so two
  webhooks delivered out of order — routine on any at-least-once transport —
  silently downgraded a paying subscriber, the only symptom being a paywall
  appearing for someone who had just paid. `version` is an opaque string from
  someone else's system, so the ordering rule is stated rather than assumed:
  numeric when both sides parse as finite numbers (otherwise `"10"` sorts before
  `"9"` and every tenth update from a counter-based feed is rejected),
  lexicographic otherwise, which is right for the ISO timestamps most providers
  send. Equality is **not** newer — reapplying a redelivery would restamp
  `entitlementAsof` and make stale data look fresh to every token minted after.
- **Signup** resolved by `findByEmail`, an eventually-consistent GSI read with no
  uniqueness constraint, so two concurrent signups for one address both saw "no
  such subscriber" and both created a record. Later lookups then resolved
  non-deterministically and an erasure could report success while a complete
  duplicate profile survived. A single conditional write on an `EMAILRESV`
  reservation item now decides the race; the loser is handed the winner's id and
  reads it with `ConsistentRead`, because the winner's record is milliseconds old
  and an eventually-consistent read would send it straight back to creating the
  duplicate.

| **Organization** | A silo | name, domain(s), **optional** linked subscriber pool ID (§4.10), `magicLink` {kmsKeyArn, kid, issuer, audience}, SES config set, IP mode (shared/dedicated), suppression scope, **defaultTimezone** (IANA), setup state |
| **AdminMember** | Staff ↔ role ↔ orgs | admin-pool `sub`, role, org-scope list, MFA state (in admin pool) |
| **Role** | Capability set | named set of capabilities (built-in + custom) |
| **Subscriber** | Durable person record | **keyed by (`orgId`, addressium `sub`)** — a UUID minted at signup, never a Cognito subject; optional **`externalId`** links an org's own user pool (§4.10); email (normalized), attributes, locale, source, consent {timestamp, ip, url}, global status, `entitlement` (free/paid) + `entitlement_asof` |
| **List (Newsletter)** | A named audience | opt-in policy, from-address, reply-to, compliance footer, physical address, **access** (free/paid), **visibility** (open/closed on the opt-in page) |
| **Subscription** | Subscriber ↔ List join | per-list status: `pending`/`confirmed`/`unsubscribed`/`bounced`/`complained` |
| **Segment** | Saved filter | predicate over attributes + engagement; resolved at send time |
| **CampaignSeries** | Recurring newsletter | cadence, **owns template + ad-tag fills**, aggregate counters across editions |
| **Campaign** | A send (edition or one-off) | type (one-off / series edition), series ref, audience, schedule, sending config, hot counters (§7 — not yet incremented) |
| **Template** | Reusable content | authoring mode (visual/MJML/raw-HTML), MJML/HTML source, versioned, declared merge-tags + **ad slots** |
| **MergeTag** | Replacement variable | source (profile/feed/system/token-claim), scope, example, fallback |
| **AdSlotFill** | LiveIntent HTML in a slot | slot id, HTML, binding (series or campaign), edition/version |
| **Feed** | Content source | RSS/Atom/JSON URL, field→merge-tag mapping, pull interval, target list |
| ~~**ABTest**~~ | Subject test | **Removed from the code; future only (§4.20).** No entity, no zod schema, no field on `Campaign` |
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
needs full ad-hoc, arbitrary-attribute segmentation at scale, an **OpenSearch
Serverless mirror** (fed by DynamoDB Streams) drops in behind the same
interface — this is the single "adds an always-billed component" upgrade.

It is **opt-in and off by default**, gated on the CDK context flag
`enableOpenSearchMirror` (§4.23). With the flag unset — which is the shipped
state — the table has no stream, there is no indexer Lambda, and a synthesized
template contains no OpenSearch resources at all. The escape hatch stays
documented precisely because it should stay shut until someone needs it.

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

Two tiers, matching how Pinpoint analytics were actually used — and **only the
first is on by default**.

1. **Always on — DynamoDB.** **Hot counters** on the campaign record power the
   real-time dashboard (sends, deliveries, opens, clicks, bounces, unsubs), and
   the append-only **Events** log is the queryable history behind per-campaign
   funnels, link performance and per-subscriber timelines. Nothing streams
   anywhere; there is no standing analytics infrastructure to pay for. For "keep
   it for later", an **on-demand DynamoDB export** writes the table to the
   analytics S3 bucket (compendium #10) — it reads continuous backups, so it
   costs no table read capacity and never touches send-path throughput.
2. **Opt-in — the columnar lake (§4.23).** Kinesis → Firehose → S3 → Glue →
   Athena, behind the `enableAnalytics` context flag, **off by default**. Deep
   ad-hoc analysis lives here if an operator wants it. No core feature depends on
   it, and with the flag unset none of it is deployed.

This keeps day-to-day dashboards instant and cheap, and makes deep analysis
available without an always-on analytics cluster that most deployments would
never query.

**Two honest gaps in tier 1**, both **[Decided r2 — not yet built]**. Nothing
increments the hot counters (compendium #57, §4.5), so every figure is currently
derived by folding the full event log on read — correct, but O(events) per
request, and `Campaign.counters` reads as zero wherever it is surfaced raw. And
the on-demand export exists in code but its Lambda is created only when
`enableAnalytics` is set, so the analytics bucket ships empty by default; making
the export the default path is the r2 target.

---

## 8. Security & compliance

> Full threat model, standards mapping (OWASP ASVS / API Top 10, NIST 800-63B,
> RFC 8725, CIS, SLSA), and the hardened magic-link reference verifier live in
> [`SECURITY.md`](./SECURITY.md). This section is the summary.

- **Least-privilege IAM** per Lambda; no shared broad roles.
- **Encryption** at rest (KMS) and in transit throughout.
- **WAF** on public endpoints — **operator-supplied, not created by addressium**
  (§4.3) — plus per-IP rate limiting, a server-side honeypot, and optional
  reCAPTCHA on signup to prevent list-bombing and abuse.
  **[Decided r2 — not yet built]** for the operator-supplied half: the stack
  still creates and associates its own WebACLs.
- **Tokenized public actions**: confirm/unsubscribe links are signed and scoped
  so a request can only affect its own subscriber.
- **Consent provenance**: signup timestamp, IP, and source URL captured for
  GDPR/audit; double opt-in default strengthens proof of consent.
- **Data residency**: everything stays in the operator's account and chosen
  region.
- **Server-side RBAC**: capability + org scope checked on every mutating handler
  (§4.12); the console UI is a convenience, never the boundary.
- **Tenant isolation**: `orgId`-partitioned data + per-org KMS signing keys and
  SES identities mean silos can't read each other's data or verify each other's
  tokens (§4.11). Where an org links its own Cognito pool, that pool is a
  further boundary addressium only reads (§4.10).
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
- **Claim minimisation.** Only coarse values ride in the URL-borne token, and
  the claim set is **closed** — there is no extension point through which an
  operator could put private account detail into a URL (§4.9).
- **Confirmed subscribers only**, and tokens carry a bounded `exp`. Because the
  scope is lite and failure degrades to the wall, a longer TTL is an acceptable
  UX/security trade (§11); an operator who wants a tighter posture can shorten
  the TTL.

---

## 9. Deployment & operations

- **Monorepo, AWS CDK (TypeScript)** — infra, backend Lambdas, and the React
  frontends share types (`packages/core`) and a single toolchain.
- **Install is two stages, and neither of them is a bare `cdk deploy`.** First,
  **once**, the account owner runs the CloudFormation **bootstrap stack**
  (`infra/bootstrap/addressium-bootstrap.yaml`) with admin credentials, then
  `cdk bootstrap` with `--custom-permissions-boundary addressium-<stage>-boundary`.
  That produces a deploy identity which can deploy and operate addressium **and
  nothing else**, so admin credentials never have to be handed to a pipeline, a
  teammate, or an agent. Then, as the deployer:
  `npm install && npm run build && npm run deploy`, where `deploy:check` runs
  first as a `predeploy` hook and **cannot be skipped**. The exact sequence lives
  in the README's Install section and in [`DEPLOYMENT.md`](./DEPLOYMENT.md) —
  follow those, not a remembered `cdk deploy`.
- **`deploy:check` is a data-destruction guard, not a health check.** It creates
  a CloudFormation **change set without executing it** and exits non-zero if any
  data-holding resource would be replaced or removed. This exists because
  `RemovalPolicy.RETAIN` prevents *deletion* but not *replacement*: change a
  partition key and CloudFormation builds a new empty table, orphans the old one,
  satisfies RETAIN, and every subscriber vanishes from the application's view.
  Only a pre-flight change-set diff catches that.
- **Setup wizard**: after the first deploy, the console walks the operator
  through SES domain verification (DKIM/SPF/DMARC), sandbox-exit guidance, the
  physical mailing address, and the first admin user (§9.1).
- **Environments**: one deployment hosts **multiple organizations** (§4.11);
  `dev`/`prod` stacks via CDK context. Adding an org provisions its per-org
  resources (KMS key, SES identity, config set, JWKS) at runtime via the
  `provisioning` service. Note the stage test is **literal string equality**
  against `"prod"` — a stage named `staging` or `prod-eu` silently gets the
  non-prod settings (§9.2).
- **Cost posture**: near-$0 at idle — no always-on compute or database. The
  standing bill for a one-org install is **$4.20/month**: 24 CloudWatch alarms
  ($2.40), one KMS signing key per org ($1.00), 2 Secrets Manager secrets
  ($0.80). That is the tested model in
  [`packages/domain/src/cost.ts`](../packages/domain/src/cost.ts), and the same
  numbers the console's Cost estimator renders, so the figure here cannot drift
  from the one on screen. DynamoDB/S3/Lambda/SQS/SNS add roughly $1 at test
  volume, unmodelled and on top of that. Sending adds SES at ~$0.10 per 1,000
  emails plus one KMS `Sign` per recipient (§4.9). Under r2 **WAF is external
  and is the operator's own bill** (§4.3) **[Decided r2 — not yet built]** — the
  stack still creates and associates two WebACLs, so today's idle bill carries
  them too, at ~$17/month: about 77% of what an idle install really costs, and
  the reason for the decision. Two components add cost only when opted in, and
  both are **off by default**: the OpenSearch mirror (§5) and the reporting
  read-model (§4.23 — Kinesis, Firehose, Athena scan at ~$5/TB, and the lake's
  own S3). The Athena workgroup carries a per-query bytes-scanned cutoff so a bad
  query cannot run up a bill. All of these drivers are metered per org (§11).

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

This is deliberately different from the **per-org subscriber pool**, which is
**not** in the bootstrap config, is **optional**, and — per §4.10 — should be a
**link to an existing pool** supplied when the org is created, never one
addressium builds. Org creation is an authenticated `POST /orgs` call; there is
no "Add organization" screen in the console (§4.1). The admin pool is created
once and belongs to us; a subscriber pool belongs to the org's own website.

### 9.2 Observability & ops alerting

Two audiences, two surfaces, and they are deliberately not the same surface
(compendium #29). **Alarms are operational** — *is the system broken?* — and
belong to an on-call engineer, who should not have to log into a marketing
console to see them. **The console's reporting screen is campaign performance** —
*how did my email do?* — and belongs to a marketer, who does not care about
Lambda throttles.

- **Logs.** 20 CloudWatch log groups, one per application handler, with
  **explicit retention** — 90 days in prod, 7 days elsewhere — because Lambda's
  default is *never expire*, i.e. unbounded cost forever. The stage test is
  literal string equality against `"prod"`, so a `staging` or `prod-eu`
  deployment silently gets 7 days. All 20 are `DESTROY` on stack removal.
- **Alarms.** 24 CloudWatch alarms, identical in every stage and unconditional:
  2 on the send queue (DLQ not empty, oldest-message age), 20 on Lambdas (errors
  and throttles across the 10 functions on the send and event paths), and 2 on
  DynamoDB (throttles, system errors).
- **Ops alerting is an external topic** (compendium #22/#32/#67). Alert routing —
  PagerDuty, Slack, an on-call rotation — is org infrastructure that a production
  account already runs; creating our own topic competes with it. The operator
  supplies `opsAlertTopicArn`, or `opsAlertEmail` for a simple setup. With an ARN
  supplied, no topic is created and none is exported. With neither set the stack
  still deploys, and `deploy:check` warns — 26 alarms publishing to a topic with
  no subscribers is monitoring in appearance only (#222).
- **CloudWatch dashboard** (compendium #29) — **[Decided r2 — not yet built]**.
  There are currently **zero** dashboard resources in the template.
- **System health in the console** — a single derived **OK / degraded** badge on
  the Overview screen (§4.1), not raw alarm state.
  **[Decided r2 — not yet built]**.
- **No preflight `doctor` command exists.** The only real preflight is
  `npm run deploy:check`, and it checks a different thing entirely — data
  destruction, not configuration. Nothing today warns an operator that no WAF is
  associated or no alert target is set, which is exactly the warning that matters
  most once WAF and ops alerting become operator-supplied.
  **[Decided r2 — not yet built]**.

### 9.3 Local development

`npm install`, `npm run build`, `npm test`, `npm run test:web`. The domain layer
imports no AWS SDK, so the full business logic runs against in-memory adapters,
and the integration suite runs the whole journey — signup → double opt-in → send
→ open/click → click map — against a real DynamoDB API via dynalite, with no Java
or Docker. `docker-compose.localstack.yml` un-skips three adapter tests (SQS,
KMS, EventBridge Scheduler) for anyone who wants them. The suite's fourth skip is
a placeholder that is only registered when LocalStack is *unreachable*, so it is
never un-skipped — it disappears instead, and the total drops from 254 to 253.

**A local dev mode is not built** (compendium #61)
**[Decided r2 — not yet built]**. The target is `npm run dev` running the *same*
router on a port — the single biggest maintainability lever available, because it
makes bugs reproducible without AWS. Today there is no `dev` script at the repo
root and no HTTP server anywhere that mounts the router; the only `dev` scripts
in the workspace are the three Vite frontends.

### 9.4 Repository layout

```
addressium/
├── apps/
│   ├── admin-web/            # React admin SPA (operator console)
│   ├── subscriber-web/       # directory / confirm / unsubscribe — token-based, no login
│   └── public-web/           # embeddable signup snippet + hosted list/confirm/unsubscribe pages
├── packages/
│   ├── core/                 # entity types, zod schemas, version marker
│   ├── domain/               # business logic — pure, no AWS imports
│   ├── adapters-aws/         # DynamoDB / SES / KMS / SQS / Cognito implementations of the ports
│   ├── rbac/                 # Cedar-backed authorization
│   ├── segment/              # segment predicate evaluation
│   ├── magiclink-verify/     # hardened reference verifier for publisher sites
│   └── integration-tests/    # full-journey tests against a real DynamoDB API (dynalite)
├── services/                 # Lambda entry points — thin wiring over the domain
│   ├── api/                  # AdminApiFn (one router) + the public handlers
│   ├── sender/               # SQS consumers → SES SendBulkEmail (throttled) + archive/link-map
│   ├── events/               # SES event processor → event log + link-agg + token redaction
│   ├── automations/          # Step Functions drip steps + recurring sweeps
│   ├── reporting/            # dashboards + click overlay + series aggregation
│   ├── tokens/               # magic-link JWT minting + KMS signing + JWKS endpoint
│   ├── provisioning/         # "Add organization" — per-org KMS key, SES identity, config set
│   ├── feeds/                # RSS/Atom/JSON pull → merge-tag mapping
│   ├── privacy/              # GDPR/CCPA export + erase-to-tombstone; audit log
│   ├── importer/             # CSV migration importer (§4.7)
│   ├── segment-indexer/      # OpenSearch mirror indexer — opt-in only (§5)
│   └── analytics-export/     # Firehose transform + table export — opt-in only (§4.23)
├── infra/
│   ├── bootstrap/            # one-time account bootstrap: deploy role + permissions boundary
│   └── cdk/                  # the application stack
├── demo/                     # static UI prototype (addressium.com)
└── docs/
    └── ARCHITECTURE.md       # this document
```

**`services/api` is one router, not 27 functions.** This design originally implied
a Lambda per route; the build collapsed all **27 authenticated console routes**
into a single **AdminApiFn** dispatching on `routeKey`, with a build-time parity
test asserting that the CDK's route list and the handler's dispatch table agree.
The unauthenticated handlers stay separate **on purpose** — they hold genuinely
different privileges, and merging them would hand one internet-facing function
the union of "can create Cognito users", "can send mail", and "holds the webhook
signing secret".

---

## 10. Roadmap (indicative)

- **v1 — Core email platform**: multi-org silos + RBAC, lists (open/close),
  signup + double opt-in, subscribers, templates (visual/MJML/raw-HTML),
  merge tags + ad tags, broadcasts + ongoing series with aggregate reporting,
  suppression (hybrid), deliverability (DKIM/DMARC/one-click unsubscribe) + SNS
  alerts, analytics + click overlay, sandbox mode, GDPR/CCPA + audit log, CSV
  importer, bootstrap + gated deploy + per-org provisioning.
- **v1.x**: drip automations (Step Functions), materialized-tag segment builder,
  magic-link token service (JWKS + entitlement sync + lite-scope tokens),
  feeds → campaign auto-build, the token-based preference center (§4.10).
- **Next, per compendium §6/§8** — the named gaps this document tags
  **[Decided r2 — not yet built]**: SQS in the event plane (§4.5), transactional
  counters (§7), bulk export/portability (§4.19), the real Pinpoint-export reader
  and the import wizard (§4.7), operator-supplied WAF and ops topic (§4.3, §9.2),
  and local dev mode (§9.3).
- **v2 — Extensibility**: visual automation/journey builder, SSO/SAML for the
  admin pool. (The OpenSearch segmentation drop-in already ships behind
  `enableOpenSearchMirror` — the v2 work is making it a supported posture rather
  than an escape hatch, not writing it.)
- **v3 — Multichannel**: activate the channel-agnostic seams for SMS
  (SNS / AWS End User Messaging) and push.

---

## 11. Open questions for later phases

- **Rendering fidelity**: whether to add a rendering-preview service (multiple
  client previews) or rely on test sends in v1.
- **Per-org billing/usage metering** *(implemented)*: a per-org/period cost
  model (`estimateCost`/`recordUsage`) meters **email** (SES), **storage** (S3)
  and **dedicated IPs**; a scheduled job feeds the AWS-metric drivers and the
  admin **Usage & cost** screen surfaces the breakdown + history. Rates are
  per-deployment overridable (`CostRates`). The model also carries an **Athena
  bytes-scanned** line, which is **zero in a default deployment** — the Athena
  tier only exists when `enableAnalytics` is set (§4.23), so that driver meters
  an opt-in component and should be presented as such rather than as a standing
  cost. Kinesis/Firehose throughput and the lake's own S3 storage are folded into
  the streaming/storage lines and are likewise zero by default. Separately, the
  model **prices a per-recipient transactional event+counter write that is not
  yet implemented** (§4.5) — treat that line as a forecast, not a bill.
- **Backups/export**: point-in-time recovery, deletion protection and a `RETAIN`
  removal policy are on the DynamoDB table in **every** stage, not just prod. The
  scheduled full export to S3 for portability is §4.19 and not yet built.
- **Webhooks/API for operators**: an outbound webhook + public API so operators
  can integrate addressium with their own systems.
- **Magic-link TTL default**: ship a sensible default (e.g. 7–30 days) with a
  clear knob; revisit once real forwarding/abuse data exists.

---

## 12. Main-site integration contract (magic-link, out of scope to build)

addressium's responsibility ends at **minting a signed token and publishing the
keys to verify it**. The operator's main website — in practice, its paywall
plugin — implements the other half. This section defines the boundary so both
sides can be built independently.

**What crosses the boundary is a public key, never a secret.** The plugin is
given the org's **JWKS** (or the raw public key) and verifies with it. **No
shared secret is ever distributed.** This is not a preference — see §8.1:
verification happens client-side on a CloudFront-cached page, so anything the
page holds is extractable, and a symmetric key would therefore be forgeable.

**The token identifies an addressium subscriber, not a directory user.** `sub` is
`Subscriber.sub`, addressium's own durable id (§4.9). Nothing has to exist in any
user pool for a magic link to work. A site that *does* run Cognito can map the
subscriber to its own user through `Subscriber.externalId` and the identity-sync
webhook (§4.10); a site on Auth0, a custom JWT scheme, or no accounts at all
needs no mapping layer at all. That is deliberate — coupling magic links to
Cognito would make the product work only for Cognito shops.

**addressium provides:**
- Editorial newsletter links containing a per-recipient magic-link JWT (per
  §4.9) in the **URL fragment**, signed by a per-org **KMS ES256** key.
- A public **JWKS endpoint** for offline (in-browser) verification, with key
  rotation: `GET /orgs/{org}/.well-known/jwks.json`.
- A published **claim contract**: `sub` (addressium's subscriber id),
  `scope: "content:read"`, `amr: ["magic_link"]`, `entitlement` (`free`/`paid`),
  `entitlement_asof`, `aud`, `iss`, `iat`, `exp`. The set is **closed** — there
  are no additional profile claims (§4.9).
- A hardened reference verifier, `packages/magiclink-verify`, so a plugin author
  does not have to get JWT verification right from first principles.
- **A browser drop-in** (#215): `@addressium/magiclink-verify/browser`, shipped
  as ESM and IIFE bundles with `jose` included and an SRI hash published for
  each. `consume({issuer, audience, jwks})` does steps 1–3 below and returns a
  plain session object. The verifier alone was not the integration — it returns
  raw claims and throws, so every site still had to find the token, decide what
  a throw meant, remove the credential from the address bar, and re-derive all
  of it on the next page. That half is where the mistakes are, and it is not
  cryptographic: an unhandled rejection blanks the article, a token left in
  `location.hash` gets copy-pasted around, and a cached session that outlives
  its token keeps a revoked reader reading.

**The main website implements** — all three steps are what the drop-in does, so
"out of scope" now means "you may use ours or write your own", not "you are on
your own":
1. Read the token from the inbound URL **fragment** client-side (the page itself
   is CloudFront-cached; the token must be **excluded from the cache key**).
2. **Verify** the signature and `exp`/`aud`/`iss` against the JWKS, with the
   algorithm **pinned to ES256** — a bare decode is forgeable and must not be
   trusted, and a verifier that honors the header's `alg` accepts `alg: none`
   and HMAC-confusion forgeries.
3. Establish a **lite** session for the subscriber the token names, keyed on the
   addressium `sub`. *Resolving the token to an existing Cognito user* — e.g. a
   **`CUSTOM_AUTH` challenge** whose Define/Verify Auth Challenge Lambdas match
   on `externalId` — is the **optional** path for orgs that run a pool, and is
   **[Decided r2 — not yet built]**: nothing downstream reads `externalId` yet
   (§4.10).
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

## 13. What is not yet proven

A design document that reads "done" is worse than useless. Everything above
describes the target; this is the part that is still unearned. It mirrors
[`DESIGN-COMPENDIUM.md`](./DESIGN-COMPENDIUM.md) §9.

- **Nothing has ever been deployed.** No AWS account has run this. Every count,
  every alarm, every wiring claim in this document is read from a **synthesized
  CloudFormation template**, not from a running system.
- **The event plane was dead at three independent layers** until recently. The
  fix is verified against the synthesized template — **never against real SES
  traffic**. Until a real bounce arrives from a real mailbox provider, treat
  §4.5 as designed rather than demonstrated.
- **`deploy-check.sh` is fixture-validated**, never run against real
  CloudFormation. It is the one thing standing between a key-schema change and
  an empty table (§9), and it has never faced a live change set.
- **The version marker is readable, but nothing writes it on deploy.** `GET
  /version` returns the running version and a `deployed` of `null` on every real
  install, forever, so it cannot yet confirm that a deploy landed. There is no
  migration runner either, despite what a couple of source comments imply.
- **GDPR erasure does not reach the S3 archive** (#164), and does not delete
  engagement-event rows (§4.19).
- **The counts that are safe to quote** — 24 alarms, 20 log groups, 27 admin
  routes, 252 resources in a default dev synth (248 in prod) — are reproducible
  with `npm run build && npx cdk synth`. They are template facts, which is a
  weaker claim than it sounds.

**1.0 is gated on** the end-to-end suite passing against a real AWS account,
GDPR erasure completing, and one install running for 30 days.

---

*This document is the source of truth for addressium's design. Implementation PRs
should reference and, where they deviate, update it.*
