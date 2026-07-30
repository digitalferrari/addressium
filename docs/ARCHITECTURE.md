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
  and a token-based preference centre (§4.10, #74)
- **Broadcasts**: send now, scheduled, and recurring campaigns
- **Re-engagement & sunset automation** (§4.22): a weekly sweep emails,
  graduates, or sunsets cold subscribers. Code-defined **drip sequences** run on
  Step Functions with two entry points: a confirmed double opt-in enrolls into
  every sequence triggered by that list, and an operator can hand-enroll into a
  `manual` one (§4.6). Inactivity and attribute-change triggers are designed, not
  built
- **Multi-organization silos** (§4.11): one deployment runs many publications,
  each isolated in its own data partition, subscriber pool, signing key and
  sending identity — one AWS account, logical silos
- **Role-based access** (§4.12): Developer Admin / Editor / Analyst (Sales) /
  Support, enforced server-side and scoped per organization
- **Segmentation** over subscriber attributes and engagement, via DynamoDB GSIs
  and materialized tags
- **Templates** in three authoring modes (§4.15) — a visual drag-and-drop builder
  (GrapesJS→MJML), MJML source, and raw-HTML blasts — one responsive pipeline;
  the compliance footer is a reserved merge value the seed templates carry
- **Merge tags & ad tags** (§4.14): per-recipient merge variables, plus **ad
  blocks** inserted verbatim and never tracked. Named ad-slot *fills* (bound at
  the series/template level) are modeled but nothing consumes them yet
- **Campaign types** (§4.16): one-off vs recurring series (daily / weekly /
  biweekly) with per-edition idempotency. Aggregate reporting across a series'
  editions is designed but not built
- **Deliverability alerts to SNS** (§4.18) and
  **GDPR/CCPA export & erasure + audit log** (§4.19)
- **Engagement analytics & reporting**: sends, deliveries, opens,
  clicks, bounces, complaints, unsubscribes — transactional per-campaign
  counters, deliverability rates, and per-link click performance
- **Email archive record + click table**: per campaign, addressium stores the
  link map and engagement, and reporting renders per-link click totals and
  uniques as a table. The rendered generic body itself is not yet written to
  the archive bucket (§4.8)
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
- **Migration importer**: generic CSV ingest, plus reading a real Pinpoint
  export — dotted-column CSV with `OptOut`/`EndpointStatus` honored and
  `Attributes.*` mapped to audiences (§4.7, #216, #209). Gzipped JSON Lines
  exports are not supported
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
| Automation | Broadcasts + re-engagement sweep + signup/manual drip sequences | Covers the majority of list use without a journey-builder build; inactivity and attribute-change triggers remain designed-only (§4.6) |
| Open/click tracking | SES built-in (config sets) | Reliable, minimal code |
| Opt-in | Double opt-in default (per-list configurable) | Deliverability + consent provenance |
| Templating | One MJML render pipeline, 3 authoring modes | Robust responsive email; visual, source and raw-HTML entry points |
| Migration | CSV + Pinpoint-export importer (§4.7) | Adoption hook for the "Pinpoint is ending" moment |
| Email archive | Archive record + link map per campaign | Powers the click table; no recipient PII or tokens at rest; the rendered body itself is not yet written (§4.8) |
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
| Template authoring | 3 modes: GrapesJS visual · MJML · raw HTML | Right tool per team; one MJML render pipeline; footer is a reserved merge value the seed templates carry |
| Ad tags | Ad blocks inserted verbatim, never tracked | Named-slot fills are modeled but not consumed yet (§4.14) |
| Campaign model | One-off vs recurring series, per-edition idempotency | Aggregate series reporting is designed but not built (§4.16) |
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

### Request/data planes

- **Public plane** (unauthenticated, behind an **operator-supplied WAF** (§4.3),
  rate-limited, honeypot + optional CAPTCHA on signup): signup, double-opt-in
  confirmation, one-click unsubscribe. Tokenized/signed so a request can only
  affect the acting subscriber.
- **Subscriber plane** (unauthenticated, **token-based**): signed confirm and
  unsubscribe links let a subscriber act on their own record with no account and
  no login. Signed **preference** links let them manage list memberships the
  same way (§4.10, #74) — the token-scoped API is built; the preference page
  in the subscriber SPA is still pending.
- **Admin plane** (Cognito-authenticated via a **separate admin pool**, staff):
  list/subscriber/segment/campaign/template/automation management, analytics, and
  settings. Every request carries a **role + organization scope**, enforced
  server-side (§4.12); all data access is partitioned by `orgId` (§4.11).
- **Sending plane** (async): campaign launch → segment resolution → suppression
  filter → SQS fan-out → throttled SES send.
- **Event plane** (async): SES events → SNS → SQS → processor → event log +
  counters + suppression + link aggregation (magic-link tokens redacted).
- **Archive/reporting plane**: the sender stores an archive record + link-map
  per campaign in DynamoDB; the admin SPA renders counters, rates and the
  per-link click table from it.
- **Token plane**: the token service mints KMS-signed magic-link JWTs and serves
  a JWKS endpoint the operator's main website verifies against (§12).

---

## 4. Component design

### 4.1 Admin console (`apps/admin-web`)

React SPA hosted on S3 behind CloudFront, authenticated against the **admin**
Cognito pool (Authorization Code + PKCE), with an **organization switcher** that
scopes everything to the active silo. Controls are shown/hidden by the member's
role (convenience only — enforcement is server-side, §4.12). Surfaces:

- **Overview** — a single derived **system health: OK / degraded** badge
  (§9.2), backed by `GET /orgs/{org}/health`. Raw CloudWatch alarms
  deliberately do not surface here — a marketer does not care about Lambda
  throttles (§9.2). A KPI/analytics dashboard (engagement trends, click map on
  the archived body) is **not yet built**; today's report screen shows
  counters, rates and the per-link click table (§4.8)
- **Audience** — newsletters (create, open/close signups), subscribers (detail +
  manual unsubscribe/suppress), segments, and suppression (§4.13)
- **Messaging** — campaigns (compose → audience → review; one-off vs series),
  templates (3 authoring modes), automations
- **Configure** — organizations (silo management + setup, including an **Add
  organization** screen, #226), roles & access, branding, import/export,
  alerts & SNS, privacy & data, team, audit log
- Console screens for feeds, merge-tag/ad-tag management, and API keys &
  webhooks are **not built** — those surfaces are config/code-driven today

### 4.2 Public site (`apps/public-web`)

Static pages + minimal JS on S3/CloudFront:

- **Embeddable signup snippet** — a `<script>` operators drop on any site;
  posts to the public API.
- **Hosted signup pages** — for operators without their own site.

The **confirmation** and **unsubscribe** pages live in the subscriber SPA
(`apps/subscriber-web`, §4.10); one CloudFront site serves both apps. The
signed **preference centre** API is built (#74); its page in the subscriber
SPA is **not yet built** (§4.10).

### 4.3 API (`services/api`)

API Gateway HTTP API → Lambda. Two authorizer scopes:

- **Admin routes**: Cognito JWT authorizer. 48 routes carry it; 44 of those are
  the admin-console routes, which all dispatch through **one** router function
  (§9.4).
- **Public routes**: 15 route keys (13 paths) with no auth — signup, batch
  signup, confirm, unsubscribe (GET+POST), version, public list, public
  branding, the JWKS endpoint, the public directory, the three
  preference-centre routes (#74), and the two HMAC-signed webhooks. They are
  defended by an operator-supplied WAF, a server-side honeypot and optional
  reCAPTCHA on signup, and tokenized/signed links for confirm/unsubscribe so a
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

**WAF is operator-supplied, not created here** (compendium #30/#31/#66, #225). A
production AWS account very likely already runs a WebACL with tuned rules;
shipping our own would be a second, competing ACL that duplicates cost, fights
the operator's existing rules, and at ~$17/month was 77% of idle cost. The
stack creates **no** WebACL; `infra/cdk/lib/waf.ts` is retained only as the
reference rule library the operator runbook points at. The operator attaches a
**REGIONAL** ACL to the HTTP API stage and a **CLOUDFRONT**-scope ACL (which
must live in `us-east-1`) to the two distributions — the stack emits
`ApiStageArn`, `AdminDistributionId` and `PublicDistributionId` outputs for
exactly that, and associates any ARNs supplied via the `apiWebAclArn` /
`cloudfrontWebAclArn` config keys.

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
  `SendEmail` once per recipient. (`SendBulkEmail` batching of up to 50
  destinations/call is a documented later optimization — per-recipient
  magic-link tokens already make every message distinct.)
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
  no tracking, no rewrite. The link-map records the class so the click table
  reports editorial performance only.
- **Archive at render time** (once per campaign): the first render assigns each
  editorial `<a>` a stable **link-id** and stores an **archive record**
  (link-map + body key) in DynamoDB — this is what the click table is built
  from (see §4.8). Writing the rendered **generic body** itself to the archive
  S3 bucket is **not yet built**: the record carries the key it *would* live
  at, and no per-recipient copies are ever stored.
- **Magic-link tokens are minted per recipient** (see §4.9) and merged into
  that recipient's render. The token rides in the destination URL's
  **fragment** (`#tok=…`), so it stays client-side only (see §8.1). The token is
  the only per-recipient difference in the link; the link's identity for
  reporting is its link-id, not its full URL.

### 4.5 Events processor (`services/events`)

SES configuration set publishes delivery/bounce/complaint/open/click/reject
events → SNS → SQS → Lambda. The processor:

- Appends to the **Events** table (append-only engagement log). Redelivery is
  harmless: the sort key carries a **deterministic `eventId`**, so a repeated
  event overwrites its own row rather than double-counting.
- Updates **hot counters** on the campaign record (#221): the event and the
  counter increment commit in **one `TransactWriteItems`**, made exactly-once
  by the deterministic `eventId` above, and readers prefer the stored counters
  over folding the log (§7). Sends that run under an id with no Campaign
  record (recurring editions, drip, re-engagement) record the event and skip
  the counter — never resurrect a campaign that does not exist; their figures
  still come from folding the log.
- **Aggregates clicks by link-id** (resolving the clicked URL back to the
  link-id assigned at archive time) so the click table has per-link totals and
  unique counts.
- **Redacts magic-link tokens before persistence.** SES click tracking reports
  the full destination URL of an editorial link, which carries the bearer token
  (in the URL fragment, or a query param on the fallback path). The processor
  **strips the token** before anything is written, so magic-link credentials
  never land at rest — not in the Events table, and not in the opt-in analytics
  tier if an operator enables it.
- On **hard bounce / complaint**, adds the address to the **suppression list**
  and flips the subscription status; evaluates the org's deliverability
  thresholds and **warns / auto-halts** the campaign on breach (§4.18).

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
accept bounces?" (no). **Built** (#218): events queue + DLQ, partial-batch-
failure reporting, and the queue alarms to watch both.

**Analytics streaming is opt-in.** With the `enableAnalytics` context flag set,
the table also streams to Kinesis → Firehose → S3 for Athena (§4.23). It is
**off by default**, and nothing in the event plane depends on it.

### 4.6 Automations (`services/automations`)

Step Functions state machines model drip sequences: `Wait` states for delays,
`Choice` states for branching on engagement/attributes, tasks that enqueue sends
through the same sender pipeline. Alongside them run the re-engagement/sunset
sweep (§4.22) and EventBridge Scheduler driving scheduled/recurring campaigns.

**Enrollment (#245).** `DripSequence.trigger` is `signup` or `manual`; inactivity
and attribute-change triggers are still designed, not built. Both implemented
triggers start an execution through the `DripStarter` port
(`SfnDripStarter`/`StartExecution`), and only two Lambdas hold
`states:StartExecution`: the `/confirm` handler and the admin router.

- **signup** — a completed double opt-in enrolls the subscriber into every
  sequence whose trigger names one of the lists just confirmed. One confirmation
  can confirm several lists, so it can start several sequences. Best-effort and
  logged: the confirmation is already durable when enrollment runs, so a Step
  Functions failure costs a welcome sequence, never the subscription. Because that
  swallow makes a broken deploy silent, the log line is a CloudWatch metric filter
  with an alarm on the ops topic — a lost grant must page somebody, not merely
  return 200.
- **manual** — `POST /drip-sequences/enroll` (`campaigns:manage`), for sequences
  whose trigger is `manual`. Hand-enrolling into a signup-triggered sequence is
  refused rather than silently duplicated, and so is enrolling a subscriber who
  has not confirmed the list step 0 mails.

**Consent is checked at every step, not only at the door.** A step sends only when
the subscriber's subscription to *that step's* list is `confirmed`; a missing or
`pending` subscription exits the sequence. A broadcast needs no such check because
it derives its recipients from the list itself (it fans out over the confirmed
index, so consent is implicit in the audience), but a drip step is handed a bare
`subscriberId` by the machine, so it is the one place that has to ask for itself.

The execution input is `{ orgId, sequenceId, subscriberId, nextStepIndex: 0,
nextWaitSeconds, enrollmentId }` — the machine begins at the `Wait`, so step 0's
own delay is honored. Two derived identifiers carry the correctness:

- The **execution name** is a sha256 of `(orgId, sequenceId, subscriberId,
  enrollmentId)` behind a readable `drip.<org>.<sequence>` prefix, because Step
  Functions caps names at 80 characters and rejects the colons an ISO timestamp
  contains. It is the idempotency mechanism: a subscriber who clicks the
  confirmation link three times enrolls once. `ExecutionAlreadyExists` is treated
  as success **when the execution holding that name is running or succeeded** — the
  starter reads its status (`states:DescribeExecution`, scoped to this machine) and
  raises rather than swallows when the previous run ended in failure, because Step
  Functions retains a closed name for 90 days and that enrollment delivered nothing.
- `enrollmentId` is the subscription's `consent.requestedAt` — stable across
  retries of one opt-in, new for a genuine re-subscribe — and it namespaces each
  step's **send claim**. Without it a returning subscriber would start a real
  execution that found every claim burned by their first run and emailed them
  nothing (§4.22 hit exactly this, #207). The other half of that choice: a
  re-signup mid-sequence mints a new identity and therefore a second execution,
  while the first is still running and cannot be cancelled (nothing remembers its
  name). So each step checks whether its own enrollment is still the current one
  for the trigger list and **retires itself** if not — the newest enrollment wins,
  and the two do not both deliver the remaining steps.

None of this has been deployed yet; the assertions above are what the code and
the CDK template do.

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

Powers the campaign report screen.

- **Email archive**: a DynamoDB **EmailArchive** record per campaign stores the
  **link-map** (`link-id → { url template, position, label }`) and the S3 key
  the generic rendered body *would* live at. Writing the body itself to the
  archive bucket is **not yet built** (§4.4), and no per-recipient copies are
  ever stored.
- **Click table**: the admin SPA renders per-link rows — total clicks, unique
  clicks, CTR — from the link-id aggregation produced by the events processor
  (§4.5). Painting those badges onto the archived body in a sandboxed iframe
  (the Mailchimp-style click map) depends on the body write above and is
  equally **not yet built**.
- **Reports**: per-campaign counters and deliverability rates (sent →
  delivered → open → click → unsub/complaint) plus the click table. Numbers
  come from the campaign's transactional counters (falling back to the event
  log, §7); deeper ad-hoc cuts come from the **opt-in** Athena tier if an
  operator turns it on (§4.23). List-growth trends, deliverability trends and
  per-subscriber activity timelines are **not yet built**.
- **Retention**: the archive bucket has no lifecycle rules yet; because
  archived bodies are generic (no baked-in recipient PII or tokens), they will
  be safe to retain for the life of the reporting window once the write lands.

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
  separate, optional `Subscriber.externalId`, which the token carries as
  `external_sub` (below) so a paywall can resolve the pool identity — while
  `sub` itself stays portable across Auth0, a custom JWT scheme, or no accounts
  at all.
- **Token shape** (JWT claims):
  - `sub` — addressium's durable subscriber id
  - `external_sub` — the linked pool's id for this subscriber
    (`Subscriber.externalId`); required by the shipped reference verifier
  - `scope: "content:read"` — **lite** access only
  - `amr: ["magic_link"]` — marks the session's origin so the main site can
    treat it as lite and force a step-up before anything sensitive
  - `entitlement` — `free` / `paid` (coarse tier) from the profile
  - `entitlement_asof` — freshness stamp for the entitlement value
  - `aud` (main site), `iss` (this deployment), `iat`, `exp` (long-lived, per §11)
- **The claim set is closed.** `mint()` takes `(orgId, sub, externalId,
  entitlement, entitlementAsof)` and both signers emit exactly the claims above
  — there is no extension point, so claim minimisation is enforced by
  construction rather than by policy. An **operator-configurable whitelist** of
  extra profile claims is **[Decided r2 — not yet built]**, and is worth
  weighing against the fact that the closed set is the stronger privacy
  posture.
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
  **one-click unsubscribe** — four routes, no more. The **preference centre**
  API is built (#74): `POST /preferences/request` issues a signed,
  `manage`-scoped link, and `GET`/`POST /preferences` read and update list
  memberships behind that token, with enumeration-safe 202s. The preference
  **page** in the subscriber SPA is **not yet built**.
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
  — the token carrying the pool identity back to the org's site — is built:
  every tokenized send reads `externalId` and mints it as `external_sub`
  (§4.9), which the shipped reference verifier requires and resolves against
  the pool (compendium #45).
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
- **"Add organization" provisions a silo**, not just a row: it creates the org's
  **SES domain identity (DKIM/SPF/DMARC) and config set** unconditionally, and
  the **KMS signing key** when magic links are on (an org with the feature off
  gets neither — §4.10). The JWKS endpoint is one shared API route serving all
  orgs, not a per-org resource. A per-org **setup checklist** tracks
  verification state.
- **Dev vs prod silos.** Each org carries an `environment` flag (`prod` by
  default, or `dev`). A `dev` org — e.g. `devsummitdaily.com` set up as its own
  root-domain silo, structured identically to the prod `summitdaily.com` — runs
  on the **exact same workflows and Lambdas**; nothing new is deployed. The flag
  only (a) surfaces a **DEV badge** in the console so an operator never confuses a
  test publication with a live one, and (b) rides along as the `environment`
  field into the opt-in analytics tier for anyone who enables it (§4.23) — the
  built-in usage/cost rollups do not break spend down by environment yet.
  Because a dev org is a full silo, it has its
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
  joined on `Subscriber.externalId`. Pools are link-only (#18, #226): there is
  no `CreateUserPool` call or permission anywhere in the deployment.

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

Entries carry `source` (bounce / complaint / manual / unsubscribe / inactive)
and `scope` (global / org). GDPR erasure (§4.19) writes a tombstone here holding
the address, so a forgotten address is never re-added.

### 4.14 Merge tags & ad tags

Two distinct replacement systems, declared on the template:

- **Merge tags** — per-recipient/per-campaign variables (`{{first_name}}`,
  `{{editorial_url}}`, `{{entitlement}}`, `{{unsubscribe_url}}`…). Each declares a
  **source** (profile attr / feed field / system / **token claim**), **scope**,
  example and fallback. Token-claim tags ride in the magic link; per-recipient
  tags resolve during bulk send; per-campaign tags are identical for everyone.
- **Ad blocks** — block-mode templates can carry `{kind:"ad"}` blocks whose HTML
  (e.g. LiveIntent) is inserted **verbatim** by the operator's own say-so —
  trusted, unsanitized — and is **never** tokenized or click-tracked (excluded
  from the click table). Named **ad-slot fills** (`{{ad_top}}`,
  `{{ad_inline_1..3}}`…) bound at the series/template level are modeled in the
  types (`Template.adSlots`, `CampaignSeries.adSlotFills`) but **nothing
  consumes them yet**, and there is no merge-tag/ad-tag management screen —
  **not yet built**.

### 4.15 Template authoring modes

One responsive render pipeline (MJML → HTML), three authoring modes so each team
uses the right tool:

- **Visual builder** — **GrapesJS** + `grapesjs-mjml` (open-source, MIT, embedded
  in the admin SPA), outputs MJML. For editors and ad reps building polished sends
  without code.
- **MJML source** — for developers; full control + live preview.
- **Raw HTML blast** — paste advertiser-supplied HTML as-is; for one-off blasts.

Regardless of mode, `List-Unsubscribe` headers (incl. RFC 8058 one-click) are
set on every message, and pasted raw HTML is **hard-sanitized** at save and
schedule time. The compliance footer (physical address + unsubscribe link) is
a reserved **merge value** the seed templates carry — it is not enforced by
the pipeline itself, so a hand-built template must include it.
Templates declare their **merge-tag and ad-slot** placeholders (§4.14).

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
biweekly / recurring). Recurring sends run on **EventBridge Scheduler**, and
each firing gets a per-firing **edition key**, so an edition is an idempotent
send of the same shell with fresh feed content (#162). Series-level structure
is **designed, not built**: a `CampaignSeries` type exists but no code writes
one, there is no aggregate reporting across editions (edition count, avg
open/click, trend), no reschedule, and no resend — reporting today is
per-campaign only (§4.8).

### 4.17 Sandbox / test mode — cut

**Dropped.** A sandbox toggle (seed/test addresses only, simulated stats) was
considered and rejected: the safe-testing answer is a **dev org** (§4.11) — a
full silo with its own SES identity and reputation, plus the fail-closed
`devAllowlist` that gates every recipient of every send. Nothing sandbox-
specific is built, and the SES account sandbox (which the setup checklist
helps exit) is a separate AWS concept unrelated to this section.

### 4.18 Deliverability alerts (SNS)

Alert rules on **complaint rate, bounce rate, send-failure spikes and SES
reputation**, each with **warn** and **auto-halt** thresholds (auto-halt ties into
the sender's complaint-rate protection, §6). Alerts publish to an
operator-configured **Amazon SNS topic** — fan out to email/SMS/Slack/PagerDuty/
Lambda — plus optional direct notify targets.

These are **application** alerts about mail — "your complaint rate is climbing" —
and are aimed at the operator running the lists. They are a different concern from
**ops** alerts about the infrastructure ("EventsFn is throwing"), which are routed
per §9.2 — the external ops topic (#222) and the CloudWatch dashboard.

### 4.19 Privacy (GDPR/CCPA), export & audit log

- **Data-subject requests:** export one person's record (profile + subscriptions
  + entitlement) as JSON, or **erase / forget** them.
- **What erasure actually does, precisely** (#164). It anonymizes the profile in
  place (email → `erased:<sub>`, attributes cleared, consent dropped, status
  `suppressed`), unsubscribes every subscription and strips the identifying half
  of each consent record, and **deletes**: the `EXTID#` pointer plus the
  `externalId` field, the email-reservation item, the entitlement record, and
  every `EVENT#` row naming the subject across every campaign. It returns an
  `ErasureReport` of what it reached rather than a bare `true` — the old boolean
  said the same thing whether one item was anonymized or every trace went, which
  is why the gap survived so long.

  Two things are deliberately **kept**, and both are lawful bases rather than
  oversights: the suppression tombstone, which holds the address so the next
  import cannot silently re-add the person (GDPR Art. 17(3)(b) / Recital 65), and
  each subscription's consent timestamps and basis, which are the org's evidence
  it was once entitled to mail the address. Campaign counters are untouched —
  they are aggregates, and decrementing them would rewrite historical reports to
  hide that a send happened.

  For the S3 lake the mechanism is **tombstone plus expiry, not rewriting**: see
  §4.23 below and `SECURITY.md` §4.7 for the anti-join query and the retention
  windows.
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
  (#220) and on import as the same `SubscriptionConsent` shape (#223).
  Retention knobs today: `auditRetentionYears` for the audit log and
  `analyticsEventRetentionDays` for the opt-in lake; a configurable **event
  retention** window for the operational event log (e.g. 13 / 25 months) is
  **not built** — the log is append-only with no TTL.
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

**How it fires (#233).** A single weekly EventBridge rule (Mondays 04:00 UTC)
invokes a dispatcher that finds the orgs with `reengagement.enabled` and sweeps
each. Three things about that are deliberate:

- **Per-org opt-in, never deployment-wide.** The terminal step *unsubscribes*
  cold subscribers. A default-on sweep would start silently shrinking lists on
  installs where nobody asked for it, and a shrunk list is not something an
  operator can undo. `enabled` defaults to `false` and the sweep returns
  immediately without so much as scanning.
- **Weekly, not daily.** Step spacing is measured in days and the default policy
  waits 180 for coldness, so a daily pass would do nothing six days in seven
  while paying for a full org scan each time.
- **`reengagement.listId` is required once enabled, and has no default.** The
  win-back emails are real mail and need a list carrying a from-address and a
  CAN-SPAM footer. An org that enables the policy without naming one is
  *reported* by the dispatcher rather than swept — silence would look identical
  to "no cold subscribers", which is precisely the failure this automation is
  supposed to prevent.

**It checkpoints and resumes** (#182). The sweep enumerates every subscriber in
an org with an N+1 subscription read each, and used to do so with no record of
progress — a retry restarted from zero, so an org large enough to matter was
never fully swept: it burned the same first N subscribers on every attempt and
the tail was never reached. Each invocation now walks a bounded number of
subscribers (1000 by default) and returns a cursor if there is more; the
`SweepCheckpoint` item carries it forward, and the absence of a cursor is how
completion is known. The checkpoint is written *after* the work, so a crash
re-does a page rather than skipping one — every action in the sweep is
idempotent (send claims, step spacing), so a repeat is a near no-op while a skip
would leave people permanently unswept.

Before this the handler existed, was exported, and **no CDK construct referenced
it**: the entire automation was domain logic with no caller, and its unit tests
passed throughout because they exercise the domain function directly.

- **Coldness is click-weighted.** Each subscriber carries a `lastEngagedAt`
  stamp that the events processor advances on **clicks only**. Opens are
  deliberately ignored: Apple Mail Privacy Protection (and similar proxies)
  auto-open messages, so an open no longer proves a human looked. `coldnessAnchor`
  falls back to the consent time when there's no click yet, and subscribers with
  no anchor at all are left alone (never mailed → can't judge).
- **Win-back sequence.** Once someone has not clicked for `coldAfterDays`
  (default 180) and still has an active subscription, the weekly sweep enrolls
  them and sends `steps` win-back emails (default 3) spaced `stepIntervalDays`
  apart (default 7). Each step is its own `reengagement:{list}#{n}` sub-campaign,
  so its engagement aggregates separately and the send is idempotent.
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
| `enableAnalytics` | DynamoDB → Kinesis → Firehose → S3 (`events/org_id=…/event_date=…/`), **two Glue tables** with partition projection (no crawler) — `events` and `entities` — an **Athena** workgroup, and two Lambdas: the Firehose transform and the nightly table export |
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
(§4.22).

**The guardrails are enforced, and the dimension tier is queryable (#199).**
Three things about that paragraph used to be aspirational:

- The workgroup set a 10 GB `bytesScannedCutoffPerQuery` but left
  `enforceWorkGroupConfiguration` at its `false` default, so any client could
  override both the cutoff and the results location — the cost cap was a
  suggestion, and query output (a materialised copy of whatever the query
  selected, i.e. tenant PII) could be steered out of the analytics bucket
  entirely. It is enforced now, and results are encrypted with `SSE_S3`.
- Only `events` was catalogued. The nightly point-in-time export — documented
  here as "the dimension data reporting joins against" — produced data **nobody
  could query**: pure export and storage cost with no capability attached. There
  is now an `entities` Glue table over it. Because the bucket retains 30
  snapshots, the export writes to `entities/export_date=YYYY-MM-DD/` and the
  table is partitioned on that day; a query that does not pin `export_date`
  returns every row thirty times. `item.pk IS NOT NULL` drops the rows the
  export's own `manifest-*.json` files produce.
- The events projection ran `2024-01-01,NOW` — about 940 days, and partition
  projection *enumerates* its range rather than discovering partitions, so a
  query with no `event_date` bound had to resolve every one of them, most
  pointing at prefixes the lifecycle rule had already expired. The range now
  tracks `analyticsEventRetentionDays`, so it ends where the data does. Four of
  the five shipped queries had no date bound at all; every query in
  `queries.sql` now takes an explicit window and anti-joins the erasure
  tombstones.

One thing that is **not** fixed, because it cannot be: Athena's CloudWatch
metrics are dimensioned by **workgroup**, and there is one workgroup per stage.
Per-org attribution of scan cost is not something this stack can derive. §11 says
what happens instead.

**When the pipeline breaks, someone is paged (#186).** Three gaps used to
compound into silent data loss: the transform's `catch` discarded the error
without binding it, so a bundle break produced no log line anywhere; the delivery
stream had no CloudWatch logging configuration at all; and neither analytics
Lambda had an error or throttle alarm, because both were constructed at the
bottom of the stack — after the alarm loop and after the dashboard. A field
rename could send 100% of records to `events-errors/` while Athena kept answering
from older partitions, just progressively emptier, and the gap surfaced weeks
later as "why is last month blank?".

Now: the error is bound and logged with its `recordId` (the handle Firehose files
it under, so the log line points at the object to replay); the stream logs to its
own group; both Lambdas are alarmed alongside every other handler; and two alarms
watch the pipeline rather than its parts — Firehose `DeliveryToS3.DataFreshness`
over an hour (delivery has stopped, whatever the cause) and
`ExecuteProcessingFailure.Records` above zero (records are being parked). All of
it is opt-in with the tier, so a default deploy pays for no alarms on a pipeline
it does not have.

**`events-errors/` can be replayed.** `replayHandler` reads the parked objects,
recovers the original payload from each record's base64 `rawData`, re-runs the
same transform, and writes the rows into the partitions Firehose would have used
— so Athena's partition projection finds them with no catalog change. It is
invoked **on demand, never on a schedule**: a replay is a response to a known,
fixed defect, and running it automatically would re-run the same broken transform
and file the records straight back, turning one incident into a loop. Records
that still fail stay parked rather than being written unprocessed, the written
key derives from the source object so a repeat run overwrites instead of
duplicating, and the source is deleted only after its rows land.

**GDPR erasure and the lake (#164).** Rows already written to `events/` are
GZIP-compressed, dynamically partitioned, append-only objects. Rewriting them per
request is neither cheap nor atomic, and a half-rewritten partition is worse than
an intact one — so erasure does not try. Instead it writes an `ERASURE#` item,
which flows through the same Kinesis → Firehose path and lands in the **same Glue
table** as an `event_type = 'erased'` row. No second delivery stream, no second
table, and no partition an operator's query can forget. Every analytics query
anti-joins against those rows (the query is in `SECURITY.md` §4.7), and the rows
themselves age out: `events/` expires at 730 days by default
(`-c analyticsEventRetentionDays=…`), `entities/` — the nightly full-table
export, which lands *raw* subscriber items — at 30 days. The erasure report
quotes the resulting date back to the operator, read from the same value the
lifecycle rule is built from. Between erasure and expiry a pseudonymous id
survives on disk that nothing can resolve to a person and no query returns.

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
- List membership & status: **`gsi3`, a SPARSE index over confirmed
  subscriptions only** (#182). `gsi3pk = ORG#<org>#LIST#<list>#CONFIRMED` and
  `gsi3sk = <subscriberId>`, and the key attributes are written **only while the
  status is `confirmed`** — so a subscription that lapses stops carrying them and
  DynamoDB drops it from the index. The index *is* the confirmed set.

  This replaced a `FilterExpression`, which DynamoDB applies **after** reading:
  every send paid read capacity for unsubscribed, bounced and complained rows,
  and each of a campaign's fan-out slices re-read the whole list before
  discarding everything outside its window. A 250-slice campaign performed 250
  full-list reads to send 250 windows — quadratic in list size, on the hottest
  path in the system.

  The sort key is the subscriber id because that is the order fan-out expresses
  its key ranges in (#171), so `confirmedRange(orgId, listId, slice)` is a native
  key-range query. The range is half-open `(after, until]`, matching `planFanOut`
  exactly, so a boundary recipient lands in one window rather than two or none.
- Engagement recency: **no GSI** — "hasn't opened in N days" predicates are out
  of scope for the v1 segment engine; the re-engagement sweep tracks
  `lastEngagedAt` on the subscriber record itself (§4.22), and ad-hoc recency
  cuts belong to the opt-in OpenSearch mirror (§5).
- Email lookup: `gsi1` on the normalized email, for import dedupe, unsubscribe,
  and the console's **paginated prefix search** (#182). The admin search used to
  load every subscriber in the org and filter by substring in Node — for a
  500k-subscriber org, hundreds of megabytes across hundreds of sequential
  queries, triggered by typing in a search box, and worse the more valuable the
  org became. It is now one page with an opaque cursor, and the query is a
  `begins_with` key condition on this index.

  That is a deliberate narrowing from substring to **prefix**. A substring match
  cannot use any index, so the only honest options were "prefix, bounded" or
  "substring, unbounded"; the console's search box says which it does rather than
  leaving an operator to discover that `@acme.com` finds nothing.
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

**Two kinds of segment (#203).** A predicate is either a **rule**
(`{match: "all"|"any", conditions: [...]}`) or an **explicit cohort**
(`{match: "explicit", subscriberIds: [...]}`). The rule engine is right for an
audience defined by a property; it is the wrong tool for "these five addresses
are my test cohort", which would otherwise mean inventing a marker attribute and
hoping it stays unique. Both kinds resolve through the same `SegmentEngine`
interface, so the Compose picker and the send path treat them identically.

Three rules govern the explicit kind, and they are the whole design:

- **Members are subscriber ids, not addresses.** An address is mutable — a
  subscriber who changes their email would silently leave the cohort — and
  storing addresses here would put PII in a second place with its own erasure
  path. The console resolves address → id when a member is added; ids that no
  longer resolve are dropped on read, so an erasure takes effect without anyone
  pruning cohorts by hand.
- **Membership is not consent.** The resolved set is *intersected* with the
  list's confirmed subscriptions, never used in their place, and suppression is
  still enforced per recipient by `mayMail` on the send path. A subscriber who
  unsubscribed cannot be reached by being named in a segment.
- **Adding an address that is not already a subscriber is rejected, not
  created.** Every other path that creates a subscriber records consent
  provenance — a signup captures a source URL and timestamp, an import captures
  a consent basis and a batch id. One conjured from a segment-editor text box
  would have none and would be indistinguishable afterwards from one that does.
  The operator imports or adds the address first.

**Segment targeting reaches the sender.** `SendDescriptor.segmentId` is resolved
in `fanOutCampaign` *before* the key ranges are computed, so the slices tile the
cohort rather than the list. A descriptor that names a segment with no resolver
configured, or names a segment that no longer exists, **throws** — it does not
fall back to the whole list. The two failure directions are not symmetric:
sending to nobody is a visible mistake fixed in a minute, and sending a
segment-targeted campaign to every confirmed subscriber is unrecallable.

---

### The primary test template (#204)

Every org is provisioned with one canonical smoke-test body,
`addressium-smoke-test`, in all three modes (`raw_html`, `mjml`, `visual`) from a
single source of truth in `packages/domain/src/seed-template.ts`. Seeded rather
than documented as a copy-paste: the point of a known-good body is that every
deployment has *the same* one, and the first thing anyone does with a new org is
send a test. Re-provisioning never overwrites an edited copy.

It deliberately contains one of each thing that fails silently — a merge tag (so
escaping is exercised), a tracked editorial link (so the click map is), the
compliance footer and physical address, and a visible unsubscribe link. The
editorial link points at `example.com` so a first smoke test does not send click
traffic to a domain the operator does not control. `seedTemplateSmokeCheck()`
asserts the properties a preview cannot show you: no unresolved merge tag, an
unsubscribe link with a real destination, and a non-empty text part.

**Reserved merge values.** Merge values are `subscriber.attributes` plus four the
send path supplies: `unsubscribe_url`, `list_name`, `compliance_footer`,
`physical_address`. The reserved names win over an attribute of the same name —
an imported CSV column called `unsubscribe_url` must not be able to replace the
real one with a working-looking link that opts nobody out. Before this,
`<a href="{{unsubscribe_url}}">` — the obvious way to write the one link a
recipient is entitled to — rendered `href=""`, and looked correct in every
preview because the link was still there and still blue.

**Plain-text parts.** Every campaign and drip send now carries one, derived from
the rendered HTML by `plainTextFrom()` rather than authored twice (two bodies
drift, and the one nobody looks at is the one that drifts). Links become
`label <url>` so a text reader can still reach them — which matters most for the
unsubscribe link. `SentMessage.text` had existed since the port was written with
nothing ever setting it, so every newsletter went out HTML-only.

**Envelope-sender alignment (#200).** Provisioning now sets a custom MAIL FROM —
`bounce.<domain>` — on each org's SES domain identity, and the returned DNS
guidance carries the MX and SPF records for it. This is the difference between
"we publish SPF" and "our SPF counts": SPF authenticates the **envelope** sender,
so with SES's default return path the passing SPF record belongs to
`amazonses.com`, is unaligned with the visible From, and DMARC discards it. DKIM
alignment alone still carries DMARC, but it is a single leg — a forwarder that
rewrites the body breaks the signature and takes the entire authentication result
with it, where an aligned SPF pass would have survived.

`BehaviorOnMxFailure` is `USE_DEFAULT_VALUE`, not `REJECT_MESSAGE`: an operator
who has not published the MX record yet falls back to the amazonses.com return
path rather than having the org's mail halt. The cost of that choice is that a
forgotten record fails **quietly**, which is why the record's DNS row says so
rather than sitting unlabelled among the DKIM CNAMEs.

**DMARC is a path, not a record.** The `_dmarc` policy is now an org setting
(`dmarcPolicy`), still defaulting to `p=none`, and the DNS row states plainly
that `p=none` is monitor-only — receivers report failures and deliver the mail
anyway, so a domain parked there has DMARC records and no DMARC protection. The
default stays `none` because enforcing before reading the aggregate reports
quarantines your own legitimate mail from senders you forgot about; `quarantine`
and `reject` are one field change once those reports are clean.

**From addresses are validated in code.** `saveList` refuses a `fromAddress`
outside the org's own domains (subdomains allowed, since an SES domain identity
covers them). Previously the address was taken verbatim and enforcement was left
to SES — which defers the failure to send time on a scheduled campaign, and in a
multi-tenant deployment is not enforcement at all: SES checks the *account's*
verified identities, so two orgs in one account could each send as the other.

**SES-side suppression.** Each org's configuration set carries
`SuppressedReasons: [BOUNCE, COMPLAINT]`. addressium's own suppression store
still gates every send; this catches what that store cannot — the window between
a bounce arriving and our handler recording it, and any path that skips the
check. Re-mailing an address SES already knows is dead is a direct reputation
cost.

**Marketing vs transactional is now a real distinction (#237).** `EmailClass`
decides *eligibility*, not just labelling, and the line falls between a statement
about the **address** and a statement about **marketing**:

| Suppression source | Marketing | Transactional |
|---|---|---|
| `bounce`, `complaint` | blocked | **blocked** |
| `manual` (an admin acted) | blocked | **blocked** |
| `unsubscribe`, `inactive` | blocked | **allowed** |

Leaving a newsletter says nothing about the receipt or the confirmation the same
person triggers ten minutes later, and withholding those is its own failure. A
hard bounce or a spam complaint binds everything. `manual` is treated as binding
because an admin who reaches for the suppression button means "stop mailing this
person", and reading that as "stop the newsletters only" narrows an instruction
whose reason we cannot see.

Two safety properties are deliberate. Omitting `emailClass` reads as
`marketing` — the **stricter** rules — so a caller that forgets cannot bypass
the gate. And a subscriber flagged `suppressed` with **no** suppression entry to
explain it fails closed even for transactional: the flag carries no source, and
an unexplained suppression is not one to reason past.

Each org now gets **two configuration sets**, `addressium-<org>` and
`addressium-<org>-transactional`, with the same suppression options and the same
event destination — the class changes *whose reputation* a message affects, never
whether a bounce is recorded. Sharing one meant a marketing complaint spike
dragged double opt-in confirmations down with it, and confirmation mail failing
is what stops new subscribers arriving: the reputation problem ate its own
recovery path. An org provisioned before this has only one set, and transactional
falls back to it rather than to *no* set — a message with no configuration set
publishes no events at all, which is the failure mode #208 was.

**`ipMode` now means something.** It was set from a `dedicatedIp` boolean and
read by nobody: no pool in CDK, no `PutDedicatedIpPool`, no assignment anywhere.
An operator could tick "dedicated IP", pay nothing extra, get shared IPs, and
have a database record saying otherwise. It is now **derived** from
`dedicatedIpPoolName` — a pool the operator created themselves, assigned to both
configuration sets at provisioning. addressium does not create pools, for the
same reason it does not create WebACLs (#225): a dedicated IP is a standing
~$25/month charge needing a deliberate warm-up plan, and provisioning one as a
side effect of a checkbox bills someone for infrastructure they did not knowingly
ask for. The IAM grant carries `PutConfigurationSetDeliveryOptions` and
deliberately **not** `CreateDedicatedIpPool`, asserted by a CDK test.

---

## 6. Email sending & deliverability

Meeting bulk-sender requirements (Gmail/Yahoo 2024+) is mandatory, so these are
built in and enforced, not optional:

- **Authentication**: SES Easy DKIM plus guided SPF and DMARC setup in the
  setup wizard; the console surfaces authentication status per domain.
- **One-click unsubscribe**: RFC 8058 `List-Unsubscribe` and
  `List-Unsubscribe-Post` headers on every campaign message.

  `/unsubscribe` answers **both GET and POST**, and they are different
  operations (#234). POST is the machine path a mailbox provider uses, and it
  performs the unsubscribe. GET is the human path: the same URL is also the
  `unsubscribe_url` merge tag — the visible "Unsubscribe" link in the body of
  every message — and a browser click is a GET. The route was POST-only, so the
  header worked and the link everyone actually clicks returned **405**.

  GET renders a one-button confirm page rather than acting directly, because
  mail security scanners and link prefetchers follow GET links; a GET that acted
  would silently unsubscribe anyone whose employer runs a URL scanner. The page
  is self-contained, has no JavaScript (mail is opened in stripped-down
  webviews), and ships `default-src 'none'`.

  A link whose signing key has been retired, or whose token has expired, gets
  its own page and a `410` rather than "invalid link" — see `SECURITY.md` §4.6.
  There is deliberately **no "enter your email" box** on that page: this route
  is unauthenticated, so such a form would be a mass-unsubscribe tool for
  anybody who can guess an address. Proving ownership of an address is what the
  preference centre in #74 is for.
- **Preference centre** (#74): one page where a subscriber sees every newsletter
  they are on and changes any of it, with no password.

  The hard part is not the UI — it is that **anyone can type any address into a
  form**, so a management surface that trusts a submitted address is a
  mass-unsubscribe tool. Access is therefore by emailed token:
  `POST /preferences/request` mails a link *to that address* and answers **202
  with an identical body whether or not the address is on file** (including on
  internal failure — a 500 for a known address and a 202 for an unknown one is
  the same enumeration oracle by another route). `GET`/`POST /preferences` then
  read the subscriber id **from the token**, never from the request body.

  The token carries `scope: "manage"` and is verified with `verifyScoped`. That
  guard is load-bearing rather than decorative: without it the RFC 8058
  unsubscribe token — present in *every message ever sent*, with a five-year TTL
  — would open a management session over every list its holder is on. Absent
  scope reads as `confirm`, so every link minted before this kept working.

  Two asymmetries in what it permits. **Leaving always works**, from any status,
  on any list, including a closed one — nothing may stand between a person and
  leaving. **Re-subscribing does not resurrect a `bounced` or `complained`
  subscription**, and cannot join a closed list: those statuses are statements
  about the address, not preferences, and clearing them through a form would
  undo suppression through the front door. Re-subscribing from `unsubscribed`
  goes straight to `confirmed` with `basis: "explicit"`, because the person is
  holding a token mailed to that address — the same evidence double opt-in
  exists to collect.

  This works identically in both magic-link modes. Nothing here touches Cognito:
  a linked pool changes how a reader proves ownership *on the operator's own
  site*, not how they manage subscriptions.
- **CAN-SPAM**: enforced physical mailing address and unsubscribe link in every
  template's footer; campaigns cannot send without them configured.
- **Suppression**: enforced before every send with a configurable scope model
  (hybrid default — §4.13); hard bounces and complaints auto-suppress.
- **Complaint-rate protection**: monitor complaint/bounce rates against per-org
  warn/auto-halt thresholds and halt sending on breach; breaches also fire
  alerts to
  the operator's SNS topic (§4.18). Per-org configuration sets isolate metrics;
  an optional per-org dedicated IP pool isolates reputation (§4.11).
- **Tracking**: SES configuration-set open/click tracking on **editorial** links
  via an operator-owned tracking domain; **ad tags are excluded** (§4.14).

---

## 7. Analytics

Two tiers, matching how Pinpoint analytics were actually used — and **only the
first is on by default**.

1. **Always on — DynamoDB.** **Hot counters** on the campaign record power the
   per-campaign report (sends, deliveries, opens, clicks, bounces, unsubs), and
   the append-only **Events** log is the durable history those counters are
   maintained from. The console surfaces counters, rates and the per-link click
   table; funnels, trends and per-subscriber timelines are not built (§4.8).
   Nothing streams
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

**One honest gap in tier 1.** The on-demand export exists in code but its
Lambda is created only when `enableAnalytics` is set, so the analytics bucket
ships empty by default; making the export the default path is the r2 target.
(The hot counters it used to share this paragraph with are built — #221, §4.5.)

---

## 8. Security & compliance

> Full threat model, standards mapping (OWASP ASVS / API Top 10, NIST 800-63B,
> RFC 8725, CIS, SLSA), and the hardened magic-link reference verifier live in
> [`SECURITY.md`](./SECURITY.md). This section is the summary.

- **Least-privilege IAM** per Lambda; no shared broad roles.
- **Encryption** at rest (KMS) and in transit throughout.
- **WAF** on public endpoints — **operator-supplied, not created by addressium**
  (§4.3, #225) — plus per-IP rate limiting, a server-side honeypot, and optional
  reCAPTCHA on signup to prevent list-bombing and abuse. The stack creates no
  WebACL and associates the operator's ARNs when configured.
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
  `dev` / `staging` / `prod` stacks via CDK context. Adding an org provisions its
  per-org resources (KMS key, SES identity, config set, JWKS) at runtime via the
  `provisioning` service.

  **`stage` is a closed set, validated at synth** (#190): `dev`, `staging`,
  `prod`, and anything else throws with the valid values named. It used to be a
  free-form string compared with literal equality against `"prod"`, so
  `"production"`, `"Prod"` or `"prod-eu"` silently produced a stack configured as
  a scratch environment while holding production data. The value decides
  termination protection and log retention, so a typo in a JSON file nobody
  compiles was a production incident waiting for a `cdk destroy`.
- **Cost posture**: near-$0 at idle — no always-on compute or database. The
  standing bill for a one-org install is **$5.70/month**: 29 CloudWatch alarms
  ($2.90), the stack's customer-managed data key ($1.00), one KMS signing key
  per org ($1.00), 2 Secrets Manager secrets
  ($0.80). That is the tested model in
  [`packages/domain/src/cost.ts`](../packages/domain/src/cost.ts), and the same
  numbers the console's Cost estimator renders, so the figure here cannot drift
  from the one on screen. DynamoDB/S3/Lambda/SQS/SNS add roughly $1 at test
  volume, unmodelled and on top of that. Sending adds SES at ~$0.10 per 1,000
  emails plus one KMS `Sign` per recipient (§4.9). Under r2 **WAF is external
  and is the operator's own bill** (§4.3, #225) — the stack creates no WebACL,
  so none of that ~$17/month lands here. Two components add cost only when
  opted in, and
  both are **off by default**: the OpenSearch mirror (§5) and the reporting
  read-model (§4.23 — Kinesis, Firehose, Athena scan at ~$5/TB, and the lake's
  own S3). The Athena workgroup carries an **enforced** per-query bytes-scanned
  cutoff so a bad query cannot run up a bill — enforced meaning the client cannot
  raise it, which it could until #199. Most of these drivers are metered per org
  (§11); Athena scan is the exception, and §11 says why.

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
addressium builds. Org creation is the console's **Add organization** screen
(#226), which calls the authenticated `POST /orgs`. The admin pool is created
once and belongs to us; a subscriber pool belongs to the org's own website.

### 9.2 Observability & ops alerting

Two audiences, two surfaces, and they are deliberately not the same surface
(compendium #29). **Alarms are operational** — *is the system broken?* — and
belong to an on-call engineer, who should not have to log into a marketing
console to see them. **The console's reporting screen is campaign performance** —
*how did my email do?* — and belongs to a marketer, who does not care about
Lambda throttles.

- **Logs.** One CloudWatch log group per application handler, with
  **explicit retention** — 90 days in prod, 7 days in dev/staging — because
  Lambda's default is *never expire*, i.e. unbounded cost forever. Retention is
  keyed off the validated `stage` value (#190), so an unrecognised stage fails
  at synth rather than silently misconfiguring it. All groups are `DESTROY` on
  stack removal.
- **Alarms.** 29 CloudWatch alarms, identical in every stage and unconditional:
  4 on the two queue/DLQ pairs (send + events, #218), 22 on Lambdas (errors
  and throttles across the 11 always-on functions), 2 on
  DynamoDB (throttles, system errors), and 1 on a log-metric filter — drip
  enrollments the confirm path swallowed (§4.6, #245), which no Lambda `Errors`
  metric can see because the throw never leaves the handler.
- **Ops alerting is an external topic** (compendium #22/#32/#67). Alert routing —
  PagerDuty, Slack, an on-call rotation — is org infrastructure that a production
  account already runs; creating our own topic competes with it. The operator
  supplies `opsAlertTopicArn`, or `opsAlertEmail` for a simple setup. With an ARN
  supplied, no topic is created and none is exported. With neither set the stack
  still deploys, and `deploy:check` warns — 29 alarms publishing to a topic with
  no subscribers is monitoring in appearance only (#222).
- **CloudWatch dashboard** (compendium #29) — **built**: one ops dashboard per
  stack, exported as the `OpsDashboardUrl` output.
- **System health in the console** — a single derived **OK / degraded** badge on
  the Overview screen (§4.1), backed by `GET /orgs/{org}/health`, not raw alarm
  state. **Built.**
- **No preflight `doctor` command exists.** The only real preflight is
  `npm run deploy:check`, whose primary job is data destruction. It **does**
  also warn when no WAF is associated or no alert target is set (#222, #225) —
  the two configurations an operator is most likely to forget now that both are
  operator-supplied.

### 9.3 Local development

`npm install`, `npm run build`, `npm test`, `npm run test:web`. The domain layer
imports no AWS SDK, so the full business logic runs against in-memory adapters,
and the integration suite runs the whole journey — signup → double opt-in → send
→ open/click → click map — against a real DynamoDB API via dynalite, with no Java
or Docker. `docker-compose.localstack.yml` un-skips three adapter tests (SQS,
KMS, EventBridge Scheduler) for anyone who wants them. The suite's fourth skip is
a placeholder that is only registered when LocalStack is *unreachable*, so it is
never un-skipped — it disappears instead, and the total drops from 734 to 733.

**`npm run dev` — the API on a port, no AWS** (compendium #61, #232).
`scripts/dev-server.mjs` starts an HTTP server on :4000 that mounts the **same
route table** the Lambda router dispatches on, backed by dynalite and an on-disk
mail outbox. No credentials, no egress, no Docker.

Point a console at it with `VITE_API_BASE=http://localhost:4000`. Reproduce a
scoped-role bug with `DEV_ROLE=analyst DEV_ORGS=summit npm run dev` — the four
roles are the ones in `packages/rbac`.

*What is real*: every route handler, verbatim, and everything they call —
domain, adapters, Cedar RBAC, zod validation, CORS. *What is faked*: DynamoDB
(dynalite, in-process, with the same key schema and all three GSIs as the CDK
stack), Secrets Manager (a literal value), SES (NDJSON in `.dev-outbox/`).

**It cannot drift, and that is enforced.** The route table is imported from
`ROUTE_KEYS`, the patterns are compiled from those strings, and dispatch goes
through the same `adminRouter`/`publicRouter` the Lambda uses. A new route is
reachable locally with no change to the dev server.
`packages/integration-tests/test/dev-server.test.ts` fails if the file ever
grows a route literal of its own, stops reading the exported table, reaches past
the router to a handler, opens CORS to `*`, or ungates the local-secret path. A
dev server that mirrors routes by hand rots within a week and is worse than
none, because it answers confidently and wrongly.

**SES, SQS and EventBridge Scheduler are spoken over the wire**, not swapped for
fake adapters — `scripts/dev-aws-stubs.mjs` serves them and the SDK is pointed at
it with `AWS_ENDPOINT_URL_*`. That distinction is the whole design: handing the
handlers an in-memory `EmailSender` would make `npm run dev` a test of the fake,
and the real `SesEmailSender` — where the RFC 8058 headers, the `emailClass`
configuration-set routing and the base64url message tags live — would never run.
Those are precisely the layers this repo's defects have been in. It also means
**zero `ADDRESSIUM_LOCAL` branches in the send path**.

One deliberate behaviour difference: a one-off send is placed five minutes out in
production so it stays cancellable (§4.6), and fires **immediately** locally.
Waiting five minutes to learn whether your send works defeats the point; the
window is a product decision about cancellation, not behaviour under test.

The full public journey runs locally: create list → signup → confirmation mail in
`.dev-outbox/` → confirm → schedule a send → the real sender drains the queue →
campaign mail in the outbox → one-click unsubscribe. The outbox holds the
adapter's actual payload, so you read the headers rather than trust that they
were produced.

**One gap remains.** `POST /orgs` is served by `services/provisioning`, which
holds `kms:CreateKey` and `ses:CreateEmailIdentity`; folding it into the
consolidated API function would put those grants behind every admin route. So the
dev server **seeds** one org on boot (`DEV_ORG`, default `summit`) rather than
routing provisioning. Same for the JWKS route (`services/tokens`) and
report/usage (`services/reporting`) — all five are named in
`route-parity.test.ts` as deliberate splits, so the exceptions are visible rather
than a hole in a regex.

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
│   ├── sender/               # SQS consumers → per-recipient SES SendEmail (throttled) + archive record/link-map
│   ├── events/               # SES event processor → event log + link-agg + token redaction
│   ├── automations/          # Step Functions drip steps + recurring sweeps
│   ├── reporting/            # campaign counters/rates + click table
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
    ├── ARCHITECTURE.md       # this document
    ├── DEPLOYMENT.md         # deploy/operate runbook
    ├── DESIGN-COMPENDIUM.md  # service inventory + decisions
    ├── SECURITY.md           # threat model + controls
    ├── REVIEW-FINDINGS.md    # the full-codebase review, with re-verification
    └── reporting/queries.sql # opt-in analytics-tier queries
```

**`services/api` is one router, not 44 functions.** This design originally implied
a Lambda per route; the build collapsed all **44 authenticated console routes**
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
  merge tags + ad blocks, broadcasts + recurring series (aggregate series
  reporting is §4.16's not-built half), suppression (hybrid), deliverability
  (DKIM/DMARC/one-click unsubscribe) + SNS
  alerts, per-campaign reporting + click table, GDPR/CCPA + audit log, CSV +
  Pinpoint importer, bootstrap + gated deploy + per-org provisioning.
- **v1.x**: materialized-tag segment builder,
  magic-link token service (JWKS + entitlement sync + lite-scope tokens),
  feeds → campaign auto-build, the preference-centre page in the subscriber SPA
  (the API is built — §4.10).
- **Landed since this roadmap was written** — SQS in the event plane (§4.5,
  #218), transactional counters (§7, #221), bulk export/portability (§4.19,
  #224), the real Pinpoint-export reader and the import wizard (§4.7, #216,
  #223), operator-supplied WAF and ops topic (§4.3, §9.2, #225, #222), and
  local dev mode (§9.3, #232). The archive-body write and the Mailchimp-style
  click overlay remain (§4.8). Also the **drip starter** (§4.6, #245): the
  machine had been provisioned with no caller, so signup and manual triggers now
  start executions.
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
  and **dedicated IPs**, and the admin **Usage & cost** screen surfaces the
  breakdown + history. Rates are per-deployment overridable (`CostRates`).

  **Two writers, split by what each can know (#199).** The screen used to read a
  permanent $0 — not because the cost model was wrong, but because *nothing ever
  wrote a usage record*: `usageIngestHandler` existed and was wired to no route
  and no schedule, so the GET routes always answered `null`. The claim above that
  "a scheduled job feeds the AWS-metric drivers" was, until then, false.

  - `usageMeterHandler` runs **daily at 04:00 UTC** over every org and fills in
    **email volume** from the append-only event log. Period-scoped, deliberately:
    campaign counters are *lifetime* totals, so folding them into a month charges
    for every email the org has ever sent, again, every month.
  - `usageIngestHandler` is **invoke-only** and takes the AWS-side figures —
    storage bytes, dedicated IPs, Athena bytes scanned — from a metering job in
    the operator's own account that can read Cost Explorer. It is not behind an
    API route because those numbers do not come from a console user. The stack
    publishes its name as the `UsageIngestFunctionName` output.

  The two **merge** rather than overwrite. A nightly job that wrote
  `storageBytes: 0` would erase the operator's real figures every night and put
  the screen back to $0 — the same defect, running on a schedule.

  The **Athena bytes-scanned** line is **zero in a default deployment**: the
  Athena tier only exists when `enableAnalytics` is set (§4.23). It is also the
  one driver the stack cannot derive even when the tier IS on — Athena's
  CloudWatch metrics are dimensioned by workgroup and there is one workgroup per
  stage, so an operator who wants that line populated must supply it through
  `usageIngestHandler`. Kinesis/Firehose throughput and the lake's own S3 storage
  are folded into the streaming/storage lines and are likewise zero by default.
  Separately, the model **prices a per-recipient transactional event+counter
  write that is not yet implemented** (§4.5) — treat that line as a forecast, not
  a bill.
- **Backups**: point-in-time recovery, deletion protection and a `RETAIN` removal
  policy are on the DynamoDB table in **every** stage, not just prod — and PITR
  is deliberately not called a backup (#190). It is a 35-day continuous window
  that lives *inside* the table and dies with it, so a bad migration, a mass
  overwrite by a runaway import, or an account-level incident takes the recovery
  path with the data.

  A real backup is a separate resource with a separate lifecycle: an **AWS Backup
  plan** writing to a `RETAIN` vault — daily kept 35 days (covering the same
  period as PITR through a different mechanism, rather than leaving a gap), plus
  monthly kept a year for "we noticed in March that something broke in January".
  **On by default in prod only**, since it carries a standing cost proportional
  to table size; `-c enableBackup=true|false` overrides in both directions.

  Both application secrets are `RETAIN` in every stage. `ConfirmSecret` signs
  every outstanding double-opt-in and one-click-unsubscribe token, so losing it
  does not merely break new links — it invalidates every link already sitting in
  someone's inbox, including the unsubscribe link the law requires to work.
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
   **[Decided r2 — not yet built]** on the main site. The addressium half is
   built: the token carries `external_sub` (§4.9, §4.10) and the reference
   verifier surfaces it.
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
- **GDPR erasure reaches the lake by tombstone, not by rewriting** (#164, §4.19).
  Rows bearing a pseudonymous subscriber id survive in `events/` until their
  lifecycle rule expires them — anti-joined out of every query, resolvable by
  nothing, but physically present. Lower `analyticsEventRetentionDays` if that is
  not acceptable for your jurisdiction. The S3 **archive** is not reached either
  — but checked rather than assumed: `EmailArchive.s3Key` is computed and stored
  in DynamoDB while **nothing uploads an object**, and the archived body is the
  GENERIC template carrying merge *tags*, not one recipient's rendered values. So
  there is no subject data there to erase today. If per-recipient bodies are ever
  archived, that changes and this line stops being true.
- **The counts that are safe to quote** — 29 alarms, 27 log groups, 64 API routes
  (49 behind the JWT authorizer), 343 resources in a default synth — are
  reproducible with `npm run build && cd infra/cdk && npx cdk synth`. They are
  template facts,
  which is a weaker claim than it sounds. Dev and prod now synthesize the same
  resource COUNT by coincidence rather than by design: prod adds the backup vault,
  plan and selection (#190) while dev adds the auto-delete custom resources for
  the two site buckets, and the two happen to balance.

**1.0 is gated on** the end-to-end suite passing against a real AWS account,
GDPR erasure completing, and one install running for 30 days.

---

*This document is the source of truth for addressium's design. Implementation PRs
should reference and, where they deviate, update it.*
