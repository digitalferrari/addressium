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
- **Engagement analytics**: sends, deliveries, opens, clicks, bounces,
  complaints, unsubscribes — real-time counters + queryable event history
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
  signup, double-opt-in confirmation, preference center, one-click unsubscribe.
  These write to DynamoDB but are strictly scoped to the acting subscriber.
- **Admin plane** (Cognito-authenticated): list/subscriber/segment/campaign/
  template/automation management, analytics, and settings.
- **Sending plane** (async): campaign launch → segment resolution → suppression
  filter → SQS fan-out → throttled SES send.
- **Event plane** (async): SES events → SNS → SQS → processor → counters +
  suppression + Firehose.

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

### 4.5 Events processor (`services/events`)

SES configuration set publishes delivery/bounce/complaint/open/click/reject
events → SNS → SQS → Lambda. The processor:

- Appends to the **Events** table (append-only engagement log).
- Updates **hot counters** on the campaign and subscriber records.
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

---

## 5. Data model

DynamoDB **single-table** design with targeted GSIs. Entities:

| Entity | Purpose | Key notes |
|---|---|---|
| **Subscriber** | Durable person record | email (normalized), attributes, locale, source, consent {timestamp, ip, url}, global status |
| **List** | A named audience | opt-in policy, from-address, reply-to, compliance footer, physical address |
| **Subscription** | Subscriber ↔ List join | per-list status: `pending`/`confirmed`/`unsubscribed`/`bounced`/`complained` |
| **Segment** | Saved filter | predicate over attributes + engagement; resolved at send time |
| **Campaign** | A send | content ref, audience (list/segment), schedule, sending config, hot counters |
| **Template** | Reusable content | MJML source, merge variables, versioned; store shaped for future visual editor |
| **Event** | Engagement log | append-only: sent/delivered/open/click/bounce/complaint/unsub, attributed by tags |
| **SuppressionEntry** | Do-not-send | source (hard-bounce/complaint/manual), enforced pre-send |

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
│   ├── admin-web/         # React admin SPA
│   └── public-web/        # signup / confirm / preference / unsubscribe
├── packages/
│   ├── core/             # shared domain types + zod schemas
│   └── segment/          # segment engine (GSI/tags impl; OpenSearch drop-in)
├── services/
│   ├── api/              # API Gateway Lambda handlers
│   ├── sender/           # SQS consumers → SES SendBulkEmail (throttled)
│   ├── events/           # SES event processor → counters + suppression + Firehose
│   ├── automations/      # Step Functions drip/journey state machines
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
  deliverability (DKIM/DMARC/one-click unsubscribe), analytics, Cognito admin,
  Pinpoint/CSV importer, CDK deploy + setup wizard.
- **v1.x**: drip automations (Step Functions), materialized-tag segment builder,
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

---

*This document is the source of truth for addressium's design. Implementation PRs
should reference and, where they deviate, update it.*
