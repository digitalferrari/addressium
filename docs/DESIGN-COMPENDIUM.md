# Addressium — Design Compendium

**Status: for review.** Every numbered item below is a thing we build, keep, or
cut. Reply with the numbers you reject and I'll write the README to the surviving
spec.

Counts and costs are read from the **currently synthesized CloudFormation
template**, not from memory. Where something is aspirational rather than built,
it says so.

---

## 0. What this is

A self-hosted replacement for the **email capabilities of AWS Pinpoint**, which
sunsets **30 October 2026**. Not an API-compatible clone — a feature replacement
with a migration path.

**Who consumes it, and how:**

| Consumer | Surface | Auth |
|---|---|---|
| Operator (marketer/admin) | Admin console SPA | Cognito Hosted UI → JWT |
| Subscriber | Signup form, preference centre, unsubscribe | Magic-link token or none |
| Publisher's website | Embedded signup widget, JWKS endpoint | None (public) |
| Billing/CRM systems | Entitlement + identity webhooks | HMAC signature |
| The operator's own AWS account | Everything runs here | — |

**The core promise:** subscriber data never leaves the operator's AWS account,
and they can export it at any time.

---

## 1. The permanent core

These structures are **frozen by the problem domain**, not by our choices. They
are 474 lines of the 13,000-line codebase.

| # | Structure | Why it cannot change |
|---|---|---|
| 1 | `EventType` = sent, delivered, open, click, bounce, complaint, unsubscribe | SES emits a fixed set. You cannot invent a new measurement of an email. |
| 2 | `Subscriber` — email, attributes map, status, consent | Attributes are an open map, so new fields are additive, never structural |
| 3 | `Subscription` — subscriber × list × status | The opt-in relation. Binary by nature. |
| 4 | `SuppressionEntry` — email, source, scope | Legal requirement; shape fixed by CAN-SPAM/GDPR |
| 5 | `Campaign` + `HotCounters` | Counters are one integer per `EventType` — see #1 |
| 6 | `EngagementEvent` — org, subscriber, campaign, type, eventId, at | Append-only fact |

**Consequence:** schema migrations should be near-zero after 1.0. The rule is
additive-optional fields and tolerant reads, not a migration framework.

---

## 2. AWS services

### Data

| # | Service | Why this and not an alternative | Holds | Standing cost |
|---|---|---|---|---|
| 7 | **DynamoDB** — 1 table, 2 GSIs, on-demand, PITR, `deletionProtection` | Single-digit-ms reads at any list size; no capacity planning; no idle cost. A relational DB would need an always-on instance. | Every subscriber, subscription, campaign, event, suppression | ~$0.25/GB + per-request |
| 8 | **S3 — ArchiveBucket** (versioned) | Stores the generic rendered email body once per campaign, powering the click-map overlay without re-rendering | Rendered bodies + link maps | pennies |
| 9 | **S3 — AuditBucket** (Object Lock, COMPLIANCE) | WORM: an admin cannot rewrite audit history. Required to prove consent handling. | Audit log | pennies |
| 10 | **S3 — AnalyticsBucket** (versioned, lifecycle) | Event archive for future analytics. **Recommend keeping the bucket, dropping the Athena/Glue/Firehose pipeline.** | Exported events | pennies |
| 11 | **S3 ×2 — AdminSite / PublicSite** | SPA hosting behind CloudFront OAC; private buckets, no public access | Built frontend assets | pennies |

### Identity & secrets

| # | Service | Why | Notes |
|---|---|---|---|
| 12 | **Cognito user pool** (admin) — MFA required, code grant only, `custom:role`/`custom:orgs` | Operator login. MFA-required and self-signup disabled. RBAC claims drive server-side authorization. | RETAIN in every stage |
| 13 | **Cognito pools (per-org, runtime)** — optional | Subscriber accounts, only if an org opts in. Off by default; addressium normally never writes to your pool. | Created by provisioning |
| 14 | **KMS — per-org asymmetric key (ES256)** | Signs magic-link tokens. Per-org so one org's key compromise can't forge another's tokens. Public half published as JWKS. | ~$1/key/month |
| 15 | **Secrets Manager ×2** — confirm-token HMAC, webhook signing | Passed to Lambdas by ARN, never value, so no plaintext lands in the template | $0.40 each |

### Email

| # | Service | Why | Notes |
|---|---|---|---|
| 16 | **SES v2 — send** | The actual mail transport. Per-org configuration set isolates deliverability reputation between tenants. | $0.10/1000 |
| 17 | **SES — per-org configuration set + event destination → SNS** | The *only* way to learn what happened to a message. Without the event destination the entire analytics plane is dead (this was broken; fixed in #208). | free |
| 18 | **SES — domain identity + DKIM per org** | Authentication. Required for Gmail/Yahoo bulk-sender rules. | free |
| 19 | **SES inbound → S3** *(test environments only)* | Lets the E2E suite read real delivered mail and assert on `List-Unsubscribe` headers. Not needed in production. | pennies |

### Messaging & orchestration

| # | Service | Why | Notes |
|---|---|---|---|
| 20 | **SQS — SendQueue + DLQ** | Decouples "schedule a campaign" from "send 500k emails". Retries, backpressure, and partial-batch failure reporting. | free tier |
| 21 | **SNS — SesEventsTopic** | SES publishes engagement events here; the events Lambda subscribes | free tier |
| 22 | **SNS — OpsAlerts** | CloudWatch alarms publish here. **Currently has no subscriber — alarms fire into a void.** Needs an email/Slack subscription. | free tier |
| 23 | **EventBridge Scheduler** | Timezone-aware recurring sends (`ScheduleExpressionTimezone`) that track DST correctly. Cron alone does not. | free tier |
| 24 | **Step Functions — drip state machine** | Long waits (days) between drip steps. Lambda cannot wait; Step Functions can, cheaply. | $0.025/1000 transitions |

### Edge & protection

| # | Service | Why | Standing cost |
|---|---|---|---|
| 25 | **API Gateway HTTP API** | Cheaper and simpler than REST API; native JWT authorizer against Cognito, applied **per route** | per-request |
| 26 | **CloudFront ×2 + OAC** | SPA delivery, HTTPS, SPA routing (403/404 → index.html) | free tier 1TB |
| 27 | **WAF ×2 WebACL, 7 rules total** | Managed rule sets, per-IP rate limit, signup CAPTCHA | **~$17/month** ⚠️ |

### Observability

| # | Service | Why | Cost |
|---|---|---|---|
| 28 | **CloudWatch Logs** — 20 groups, explicit retention (90d prod / 7d dev) | Lambda's default is *never expire*; that is unbounded cost forever | $0.50/GB |
| 29 | **CloudWatch Alarms ×24** | DLQ depth, queue age, per-function errors/throttles, DynamoDB throttles | **$2.40/month** |

---

## 3. Compute — 21 Lambda functions

Consolidated from 47. The 27 single-route admin Lambdas are now one router.

| # | Function | Trigger | Does | Notes |
|---|---|---|---|---|
| 30 | **AdminApiFn** | 27 API routes | All authenticated console operations, dispatched on `routeKey` | Behind JWT authorizer; every handler also checks RBAC |
| 31 | **SenderFn** | SQS | Renders per recipient, mints magic-link token, calls SES, records `sent` | Per-recipient idempotency claims; fan-out for large lists |
| 32 | **EventsFn** | SNS | Unwraps SES events, records opens/clicks/bounces/complaints, drives suppression + auto-halt | The analytics plane |
| 33 | **LaunchFn** | EventBridge | Builds each recurring edition (incl. RSS feed fetch) and enqueues it | |
| 34 | **DripStepFn** | Step Functions | One drip step send | |
| 35 | **ProvisioningFn** | `POST /orgs` | Creates per-org KMS key, SES identity, config set, event destination | |
| 36 | **TokensFn** | `GET …/jwks.json` | Publishes the org's public key so publishers can verify magic links | Public |
| 37 | **SignupFn / SignupBatchFn** | `POST /signup*` | Public signup + double opt-in email | Honeypot + optional CAPTCHA |
| 38 | **ConfirmFn** | `GET /confirm` | Verifies the opt-in token, confirms subscriptions | Can create Cognito users (opt-in) |
| 39 | **UnsubscribeFn** | `POST /unsubscribe` | RFC 8058 one-click unsubscribe | Signed token |
| 40 | **PublicListFn / PublicBrandingFn** | public GETs | Data the subscriber-facing site renders | Read-only |
| 41 | **EntitlementFn / IdentityFn** | webhooks | Sync paid status and identity from the operator's systems | HMAC-verified |
| 42 | **VersionFn** | `GET /version` | Reports running vs deployed version | Upgrade verification |
| 43 | **ReportFn / UsageFn / AnalyzeFn / ScheduleFn** | API routes | Campaign reports, usage metering, scheduling | |

**Deliberately not consolidated:** the public functions have *different sensitive
permissions* (ConfirmFn can create Cognito users; SignupFn can send mail and read
org secrets; webhook handlers hold the signing secret). Merging them would give
one internet-facing function the union of all three.

---

## 4. Business logic

| # | Domain | Why it exists | Status |
|---|---|---|---|
| 44 | **Double opt-in with consent provenance** (timestamp, IP, source URL) | Pinpoint had no native DOI. Proof of consent is a legal requirement and a deliverability asset. | Built |
| 45 | **Hybrid suppression** — bounces global, unsubscribes per-org | More correct than Pinpoint's single account-level list | Built |
| 46 | **Send pipeline with per-recipient idempotency** | SQS is at-least-once; without this, retries either double-send or silently drop recipients | Built |
| 47 | **Deliverability auto-halt** | Stops a campaign mid-flight when bounce/complaint rates breach thresholds. Protects the sending domain. | Built |
| 48 | **RFC 8058 one-click unsubscribe** | Mandatory for Gmail/Yahoo bulk senders since 2024 | Built |
| 49 | **Click-map overlay** | Per-link click attribution against the archived body, with the magic-link token redacted before storage | Built |
| 50 | **RSS feed → newsletter editions** | Ingest an XML feed and populate the template. **Priority feature.** | Built |
| 51 | **Re-engagement / sunset automation** | Win-back sequence then unsubscribe. **Go-to-market feature.** | Built |
| 52 | **Dynamic segments** | Attribute + engagement predicates over subscribers | Built (engagement predicates limited) |
| 53 | **Multi-org isolation** | Per-org KMS key, SES identity, config set, dev/prod silos with fail-closed allowlist | Built |
| 54 | **Cedar-backed RBAC** | Server-side authorization, 4 roles, org-scoped | Built |
| 55 | **Import from CSV** | Migration entry path | Built, but **cannot read a real Pinpoint export** (#209) |
| 56 | **Transactional counters** | O(1) campaign reporting instead of reading every event | **To build** |
| 57 | **Export / portability** — CSV + JSONL with consent provenance | Users must be able to leave. Round-trip importable. | **To build** |
| 58 | **Import into a selected or new audience** | Pick an existing list or create one at import time | **To build** |
| 59 | **Local dev mode** (`npm run dev`) | Run the same router on a port. The single biggest maintainability lever — bugs become reproducible without AWS. | **To build** |

---

## 5. Cost — correcting an earlier estimate

I told you "under $2/month". **That was wrong.** Reading the actual template:

| Item | Monthly |
|---|---|
| WAF — 2 WebACLs × $5 + 7 rules × $1 | **$17.00** |
| CloudWatch alarms — 24 × $0.10 | $2.40 |
| Secrets Manager — 2 × $0.40 | $0.80 |
| KMS — 1 key per org | $1.00 |
| DynamoDB / S3 / Lambda / SQS / SNS at test volume | ~$1.00 |
| **Baseline, sending nothing** | **≈ $22** |

Plus $0.10 per 1,000 emails and a domain (~$12–15/yr).

**WAF is 77% of the idle cost.** Decision needed — see #63.

---

## 6. Cut list (your calls, confirming)

| # | Item | Rationale |
|---|---|---|
| 60 | **AI report narratives** | Needs an external AI provider + third-party secret inside a compliance-sensitive mail system. Unrelated to sending email. |
| 61 | **A/B testing** | Not required. Removes ~220 lines and a class of drift bugs. |
| 62 | **Kinesis + Firehose + Glue + Athena + OpenSearch** | Advanced analytics deferred. Events are still retained in DynamoDB; export to S3 on demand covers "store it for later" with zero standing infrastructure. |

---

## 7. Decisions I need from you

| # | Question | My recommendation |
|---|---|---|
| 63 | **WAF — keep, or make optional?** $17/mo is most of the idle cost. It provides managed rule sets, rate limiting, and signup CAPTCHA. | **Make it a config flag, default ON for prod, OFF for dev.** Keeps the protection where it matters and removes $17/mo from every test install. |
| 64 | **OpsAlerts topic has no subscriber.** 24 alarms currently fire into nothing. | Add an `opsAlertEmail` config parameter. Without it the entire alarm suite is decorative. |
| 65 | **Reduce alarm count?** 24 alarms × $0.10. | Keep. $2.40 for knowing your mail system broke is the best value in the stack. |
| 66 | **Per-org KMS key at $1/mo each** — 100 orgs = $100/mo. | Keep for isolation, but document the per-org cost so operators can plan. |
| 67 | **Audit bucket uses Object Lock COMPLIANCE mode** — objects are immutable for 7 years and *cannot be deleted by anyone, including you*. | Confirm you want COMPLIANCE and not GOVERNANCE. COMPLIANCE cannot be undone. |
| 68 | **`GET /orgs/{org}/branding` is public.** The subscriber site needs it. | Confirm branding contains nothing sensitive. |

---

## 8. What is not yet proven

Honest status, because the compendium is worthless if it reads as "done":

- **Nothing has ever been deployed.** No AWS account has run this.
- The event plane was dead at three layers until this week; the fix is verified in
  the synthesized template but not against real SES traffic.
- `deploy-check.sh` is validated against fixtures, never against real
  CloudFormation.
- The version marker is readable but nothing writes it on deploy yet.
- GDPR erasure does not reach the S3 archive (#164).

1.0 should be gated on the end-to-end suite passing against a real account.
