# Addressium — Design Compendium

**Revision 2.** Incorporates the review decisions. Items renumbered sequentially;
where a decision changed something, it is marked **[CHANGED r2]** with the
reason.

Counts and costs are read from the **currently synthesized CloudFormation
template**, not from memory. Items not yet built say so.

---

## 0. What this is

A self-hosted replacement for the **email capabilities of AWS Pinpoint**, which
sunsets **30 October 2026**. Not an API-compatible clone — a feature replacement
with a migration path.

| Consumer | Surface | Auth |
|---|---|---|
| Operator (marketer/admin) | Admin console SPA | Cognito Hosted UI → JWT |
| Subscriber | Signup form, preference centre, unsubscribe | Magic-link token or none |
| Publisher's website | Embedded signup widget, JWKS endpoint, branding | None (public) |
| Billing/CRM systems | Entitlement + identity webhooks | HMAC signature |

**The core promise:** subscriber data never leaves the operator's AWS account,
and they can export it at any time.

**Design principle adopted in r2:** *addressium does not take over
account-wide services.* Where an AWS account very likely already runs something
(WAF, ops alerting), addressium **consumes** it via configuration rather than
creating a competing copy.

---

## 1. The permanent core

Frozen by the problem domain, not by our choices. 474 lines of a 13,000-line
codebase.

| # | Structure | Why it cannot change |
|---|---|---|
| 1 | `EventType` = sent, delivered, open, click, bounce, complaint, unsubscribe | SES emits a fixed set |
| 2 | `Subscriber` — email, attributes map, status, consent | Attributes are an open map: new fields are additive, never structural |
| 3 | `Subscription` — subscriber × list × status | The opt-in relation |
| 4 | `SuppressionEntry` — email, source, scope | Shape fixed by CAN-SPAM/GDPR |
| 5 | `Campaign` + `HotCounters` | One integer per `EventType` — see #1 |
| 6 | `EngagementEvent` — org, subscriber, campaign, type, eventId, at | Append-only fact |

**Consequence:** schema migrations are near-zero after 1.0. The rule is
additive-optional fields and tolerant reads, not a migration framework.

---

## 2. AWS services we create

### Data

| # | Service | Why this and not an alternative | Holds |
|---|---|---|---|
| 7 | **DynamoDB** — 1 table, 3 GSIs, on-demand, PITR, `deletionProtection`, RETAIN in every stage | Single-digit-ms reads at any list size, no capacity planning, no idle cost. A relational DB needs an always-on instance. | Every subscriber, subscription, campaign, event, suppression |
| 8 | **S3 — ArchiveBucket** (versioned) | Will store the generic rendered body once per campaign; today it holds nothing — the EmailArchive Dynamo record (link map + body key) exists, the body write does not (ARCHITECTURE §4.8) | Rendered bodies + link maps |
| 9 | **S3 — AuditBucket** (Object Lock, **GOVERNANCE**) **[CHANGED r2]** | WORM audit history. GOVERNANCE rather than COMPLIANCE: a privileged principal can still remove an object with `s3:BypassGovernanceRetention`, so a mistake is recoverable. COMPLIANCE cannot be undone by anyone, including AWS. | Audit log |
| 10 | **S3 — AnalyticsBucket** (versioned, lifecycle) | Event archive for later analytics. Fed by on-demand DynamoDB export, not a streaming pipeline. | Exported events |
| 11 | **S3 ×2 — AdminSite / PublicSite** | SPA hosting behind CloudFront OAC; private buckets | Built frontend assets |
| 11b | **S3 — ExportBucket** (7-day lifecycle, #224) | Staging for bulk subscriber exports; objects expire in 7 days, keys carry a random segment | Export CSV/JSONL |
| 11c | **AWS Backup — vault + plan** (prod-default, `enableBackup` override, #190) | Point-in-time recovery beyond PITR windows | Table backups |

### Identity & secrets

| # | Service | Why |
|---|---|---|
| 12 | **Cognito user pool (admin)** — MFA required, code grant only, `custom:role`/`custom:orgs`, RETAIN | Operator login. RBAC claims drive server-side authorization. |
| 13 | **Cognito pools (per-org, runtime)** — optional, off by default | Subscriber accounts, only if an org opts in |
| 14 | **KMS — per-org asymmetric key (ES256)** | Signs magic-link tokens. Per-org so one key's compromise can't forge another org's tokens. Public half published as JWKS. **See #45 for a volume caveat.** |
| 15 | **Secrets Manager ×2** — confirm-token HMAC, webhook signing | Passed by ARN, never value, so no plaintext lands in the template |

### Email

| # | Service | Why |
|---|---|---|
| 16 | **SES v2 — send** | Mail transport. Per-org configuration set isolates deliverability reputation between tenants. |
| 17 | **SES — per-org configuration set + event destination → SNS** | The only way to learn what happened to a message. Without it the entire analytics plane is dead. |
| 18 | **SES — domain identity + DKIM per org** | Required for Gmail/Yahoo bulk-sender rules |

*(SES inbound → S3 is **not created by the stack** in r2. The live smoke suite
wires it per-run in the disposable account and reads delivered mail from S3 —
see DEPLOYMENT §11.)*

### Messaging & orchestration

| # | Service | Why |
|---|---|---|
| 19 | **SQS — SendQueue + DLQ** | Decouples "schedule a campaign" from "send 500k emails". Retries, backpressure, partial-batch failure reporting. |
| 20 | **SQS — EventsQueue + DLQ** **[NEW r2]** | SES → SNS → **SQS** → Lambda. See #44 — this is the answer to the Kinesis question, and it closes a real event-loss bug. |
| 21 | **SNS — SesEventsTopic** | SES publishes engagement events here |
| 22 | **SNS — ops alerting: consume an EXTERNAL topic ARN when supplied** **[CHANGED r2]** | Config takes `opsAlertTopicArn` and/or `opsAlertEmail`. With an external ARN the stack creates nothing; with only an email it creates a topic and subscribes the address; with neither it creates an unsubscribed topic and `deploy:check` warns. Ops alerting is account-wide infrastructure maintained outside the app; competing with it helps no one. |
| 23 | **EventBridge Scheduler** | Timezone-aware recurring sends (`ScheduleExpressionTimezone`) that track DST. Cron alone does not. |
| 24 | **Step Functions — drip state machine** | Waits of days between drip steps. Lambda cannot wait; Step Functions can, cheaply. |

### Edge

| # | Service | Why |
|---|---|---|
| 25 | **API Gateway HTTP API** | Cheaper than REST API; native JWT authorizer against Cognito, applied **per route** |
| 26 | **CloudFront ×2 + OAC** | SPA delivery, HTTPS, SPA routing (403/404 → index.html) |

### Observability

| # | Service | Why |
|---|---|---|
| 27 | **CloudWatch Logs** — 27 groups, explicit retention (90d prod / 7d dev) | Lambda's default is *never expire* — unbounded cost forever |
| 28 | **CloudWatch Alarms ×28** — kept in full | See #29 for where they surface |
| 29 | **CloudWatch Dashboard** **[NEW r2]** | Answering "UI screen or CloudWatch dashboard?": **both, for different audiences.** Alarms are *operational* (is the system broken?) → CloudWatch dashboard + the external SNS topic, for the engineer. The console's reporting screen is *campaign performance* (how did my email do?) → for the marketer. A marketer does not care about Lambda throttles; an on-call engineer should not have to log into a marketing console. The console shows a single derived **system health: OK / degraded** badge, not raw alarms. |

---

## 3. Services we do NOT create — manual setup required

**[NEW r2]** A production AWS account very likely already runs these. Deploying
our own would duplicate cost, fight existing rules, or silently bypass the
customer's security posture.

| # | Service | Why we don't create it | What the operator must do |
|---|---|---|---|
| 30 | **WAF (REGIONAL, for the HTTP API)** | Most accounts already have a WAF with tuned rules. Ours would be a second, competing ACL — and at ~$17/mo it was 77% of idle cost. | Documented runbook: create/reuse a REGIONAL WebACL, add AWS managed common + known-bad-inputs rule sets, a per-IP rate limit, optionally a CAPTCHA rule on `/signup`, then associate it with the API stage ARN (printed as a stack output). |
| 31 | **WAF (CLOUDFRONT, for the SPAs)** | Same reasoning; CLOUDFRONT-scope ACLs must live in `us-east-1` and are frequently account-wide. | Same runbook, CLOUDFRONT scope, associate with the two distribution ARNs (stack outputs). |
| 32 | **Ops alerting topic + subscriptions** | Alert routing (PagerDuty, Slack, on-call rotation) is org infrastructure. | Provide `opsAlertTopicArn` in config, or `opsAlertEmail` for a simple setup. |

**Consequence:** the stack must emit the ARNs these need as CloudFormation
outputs, and `doctor` should warn when no WAF association or alert target is
configured — silently shipping unprotected is worse than shipping without WAF.

---

## 4. Compute — Lambda functions

| # | Function | Trigger | Does |
|---|---|---|---|
| 33 | **AdminApiFn** | 43 API routes | All authenticated console operations, dispatched on `routeKey`. Behind JWT authorizer; every handler also checks RBAC. |
| 34 | **SenderFn** | SQS | Renders per recipient, mints magic-link token, calls SES, records `sent`. Per-recipient idempotency; fan-out for large lists. |
| 35 | **EventsFn** | **SQS** (was SNS) **[CHANGED r2]** | Unwraps SES events, records opens/clicks/bounces/complaints, drives suppression + auto-halt |
| 36 | **LaunchFn** | EventBridge | Builds each recurring edition (incl. RSS feed fetch) and enqueues it |
| 37 | **DripStepFn** | Step Functions | One drip step send |
| 38 | **ProvisioningFn** | `POST /orgs` | Creates per-org KMS key, SES identity, config set, event destination |
| 39 | **TokensFn** | `GET …/jwks.json` | Publishes the org's public key so publishers can verify magic links |
| 40 | **SignupFn / SignupBatchFn** | `POST /signup*` | Public signup + double opt-in email. Honeypot + optional CAPTCHA. |
| 41 | **ConfirmFn** | `GET /confirm` | Verifies the opt-in token, confirms subscriptions |
| 42 | **UnsubscribeFn** | `POST /unsubscribe` | RFC 8058 one-click unsubscribe, signed token |
| 43 | **PublicListFn / PublicBrandingFn / PublicDirectoryFn** | public GETs | Data the subscriber site and public site render. Branding is intentionally public — the public site uses it. |
| 44 | **EntitlementFn / IdentityFn** | webhooks | Sync paid status and identity from the operator's systems, HMAC-verified |
| 45 | **VersionFn** | `GET /version` | Running vs deployed version |
| 46 | **ReportFn / UsageMeterFn / UsageIngestFn / ScheduleFn** | API routes + daily cron | Campaign reports, usage metering + ingest, scheduling. `AnalyzeFn` was the AI layer's and went with it (#62, #227). |
| 47 | **SubscriberAccountFn** | invoked by ConfirmFn (#23) | The one Cognito write — creates the pool subscriber after double opt-in. Reachable from no route; three enumerated actions; explicit Deny on the admin pool. |
| 48 | **ReengagementSweepFn** | weekly cron (Mon 04:00 UTC, #233) | Paged, checkpointed re-engagement/sunset sweep (ARCHITECTURE §4.22) |
| 49 | **ConfirmSecretRotationFn** | yearly schedule (#234) | Rotates the confirm-token HMAC keyring; the ONE secretsmanager write grant in the stack |
| 50 | **PreferencesFn / PreferenceRequestFn** | `GET`/`POST /preferences`, `POST /preferences/request` (#74) | Token-scoped preference centre API, reserved concurrency |
| — | **SegmentIndexerFn / AnalyticsExportFn / SnapshotFn / ReplayFn** | opt-in only | Exist solely under `enableOpenSearchMirror` / `enableAnalytics` (§4.23) — not in a default synth |

**Deliberately not consolidated:** the public functions hold *different sensitive
permissions* — SubscriberAccountFn can create Cognito users, SignupFn can send
mail and read org secrets, webhook handlers hold the signing secret. Merging
them gives one internet-facing function the union of all three.

---

## 5. Answers to the two open questions

### 44. "Do we need Kinesis or Firehose to accept bounces and complaints?" **[NEW r2]**

**No — but the current wiring loses events, and that needs fixing.**

Kinesis/Firehose was never the ingestion path. The path is SES → SNS → Lambda.
Firehose is a *separate archival* destination, and dropping it (r1 decision) does
not affect bounce handling.

**However**, `sesEvents.addSubscription(new LambdaSubscription(eventsFn))` is an
**async Lambda invocation**. AWS retries twice, then **discards the event
permanently**. There is no DLQ. A dropped bounce means an address that keeps
being mailed — reputation damage that compounds silently.

Throughput is not the concern: at the paced SES send rate, events arrive well
within Lambda's capacity. **Durability is the concern.**

**Fix: SES → SNS → SQS → Lambda** (#20). This gives:
- durable buffering; nothing is lost if the handler is broken or throttled
- a real DLQ for events that fail repeatedly
- batching, and **partial-batch-failure reporting** — the same mechanism already
  built for the sender, so one poison event no longer fails its batch peers
- absorbs bursts without relying on Lambda concurrency

Cost: effectively zero at this volume. This is strictly better than both the
current SNS→Lambda wiring and a Kinesis pipeline.

### 45. "Should magic links use the Cognito user pool's JWKS instead?" **[NEW r2]**

**Recommendation: keep the per-org KMS key + published JWKS.** Three reasons:

1. **Magic links are for people who are not logged in.** A subscriber clicks a
   link in an email and gets access without a password. Cognito cannot mint a
   token for an arbitrary address without an auth flow — we'd need
   `AdminInitiateAuth` against the *publisher's* pool, meaning addressium holds
   admin credentials on their user directory. That is exactly the privilege we
   narrowed in the security work, and a much larger ask than "verify this JWT".
2. **Not every publisher uses Cognito.** Auth0, Firebase, custom JWT, or no auth
   at all are all common. Coupling magic links to Cognito makes the product only
   work for Cognito shops.
3. **The current design is already compatible.** ES256 + a published JWKS is
   standard OIDC shape, verifiable by any JWT library — including on a site that
   also verifies Cognito tokens. Two issuers, one library.

**The observation does point at something real, though:** for orgs that *do* use
Cognito, we should support **identity linking** so a magic link resolves to their
existing Cognito user. `Subscriber.externalId` and the identity-sync webhook
already exist for this; it needs finishing rather than replacing.

**Separate caveat worth flagging (#14):** `magic.mint()` is called **per
recipient**, so a 500k campaign makes 500k KMS `Sign` calls — roughly $1.50 and
measurable added latency per send. Not urgent, but at volume we should consider
caching a short-lived data key or signing locally with a KMS-wrapped key.

---

## 6. Business logic

| # | Domain | Why it exists | Status |
|---|---|---|---|
| 46 | **Double opt-in with consent provenance** (timestamp, IP, source URL) | Pinpoint had no native DOI. Proof of consent is legally required and a deliverability asset. | Built |
| 47 | **Hybrid suppression** — bounces global, unsubscribes per-org | More correct than Pinpoint's single account-level list | Built |
| 48 | **Send pipeline with per-recipient idempotency** | SQS is at-least-once; without this, retries double-send or silently drop | Built |
| 49 | **Deliverability auto-halt** | Stops a campaign mid-flight on bounce/complaint breach. Protects the sending domain. | Built |
| 50 | **RFC 8058 one-click unsubscribe** | Mandatory for Gmail/Yahoo bulk senders | Built |
| 51 | **Click table** | Per-link attribution (totals + uniques), magic-link token redacted before storage. Painting it onto the archived body (the overlay) awaits the body write (ARCHITECTURE §4.8) | Built |
| 52 | **RSS feed → newsletter editions** | Ingest an XML feed into the template. **Priority.** | Built |
| 53 | **Re-engagement / sunset automation** | Win-back sequence then unsubscribe. **Go-to-market.** | Built |
| 54 | **Dynamic segments** | Attribute + engagement predicates. No static segments. | Built |
| 55 | **Multi-org isolation** | Per-org KMS key, SES identity, config set, dev/prod silos, fail-closed allowlist | Built |
| 56 | **Cedar-backed RBAC** | Server-side authorization, 4 roles, org-scoped | Built |
| 57 | **Transactional counters** | O(1) campaign reporting instead of reading every event. Event write + counter increment in one `TransactWriteItems`, made exactly-once by the deterministic `eventId`. | Built (#221) |
| 58 | **Export / portability** — CSV + JSONL incl. consent provenance, round-trip importable | Users must be able to leave | Built (#224) |
| 59 | **Import from a real Pinpoint export** | Dotted-column CSV parser; `OptOut`/`EndpointStatus` must never become mailable. (Gzipped JSON Lines not supported.) | Built (#216, #209) |
| 60 | **Import wizard** **[CHANGED r2]** | Before any row is written, the admin must declare: **(a) consent basis — explicit (double opt-in evidence) or implicit (existing relationship)**, **(b) tags identifying this import batch**, **(c) target audiences via multi-select**, with create-new inline. Consent basis is recorded on every imported subscription, so a later dispute can be answered per-row rather than per-file. Implicit consent should default the subscription to `pending`. | Built (#223) |
| 61 | **Local dev mode** (`npm run dev`) | Same router on a port. Biggest maintainability lever — bugs reproducible without AWS. | Built (#232) |

---

## 7. Cost

Confirmed acceptable. With WAF now external (#30, #31), addressium's own idle
cost is roughly:

| Item | Monthly |
|---|---|
| CloudWatch alarms — 29 × $0.10 | $2.90 |
| Secrets Manager — 2 × $0.40 | $0.80 |
| KMS — $1 for the stack's data key + $1 per org key | $1.00 + $1.00 × orgs |
| DynamoDB / S3 / Lambda / SQS / SNS at test volume | ~$1.00 |
| **Baseline** | **≈ $5.80 + $1/org** |

Plus $0.10 per 1,000 emails. WAF, if the operator adds one, is theirs and
typically already paid for.

---

## 8. Cut

| # | Item | Rationale |
|---|---|---|
| 62 | AI report narratives | External AI provider + third-party secret inside a compliance-sensitive mail system, unrelated to sending email. **Code removed** (#227) — advisor, console screen, `POST /orgs/ai-config`, `AnalyzeFn` and `Organization.aiConfig` are gone. `secretsmanager` is read-only for every role, asserted at synth, with ONE deliberate exception (#234): the ConfirmSecret rotation function writes its own secret. |
| 63 | A/B testing | Not required |
| 64 | Kinesis + Firehose + Glue + Athena + OpenSearch **[CLARIFIED r2]** | Cut from the **default posture**, not from the codebase — see item 68. Events are retained in DynamoDB and on-demand export to S3 covers "store it for later" with zero standing infrastructure. **Does not affect bounce handling — see #44.** |
| 65 | SES inbound → S3 | Not created by the stack; the live smoke suite wires it per-run in the disposable account (DEPLOYMENT §11) |
| 66 | Self-created WAF WebACLs | Now operator-supplied (#30, #31) |
| 67 | Self-created ops alerts topic | Now operator-supplied (#32) |

**Cut from the default posture is not cut from the codebase.** Item 64 means
"nobody gets this unless they ask for it", not "delete it" — and the distinction
was never written down, which left the code looking like an oversight. See item
68.

| # | Item | Decision |
|---|---|---|
| 68 | **Reporting read-model — kept, opt-in** **[NEW r2]** | The Kinesis → Firehose → S3 → Glue → Athena lake and the OpenSearch mirror **stay in the repo**, behind two CDK context flags that are off unless set: `enableAnalytics` and `enableOpenSearchMirror`. Neither is set anywhere in the repo, a default synth contains **zero** Kinesis, Firehose, Glue, Athena and OpenSearch resources, and the table carries no stream — asserted by a CDK test, so "off by default" is enforced rather than asserted in prose. Standing cost when unused is therefore zero, which is what made deleting it the wrong trade: it is working infrastructure that costs nothing to keep, and cross-campaign cohort questions are the one access pattern DynamoDB genuinely cannot serve. Architecture in ARCHITECTURE.md §4.23. GDPR erasure (§4.19) reaches the lake as `erased` tombstone rows in the same Glue table; every shipped query anti-joins them (`docs/reporting/queries.sql`), and the physical rows expire with the bucket lifecycle (#199). |

---

## 9. What is not yet proven

- **Nothing has ever been deployed.** No AWS account has run this.
- The event plane was dead at three layers until this week; verified in the
  synthesized template, never against real SES traffic.
- `deploy-check.sh` is fixture-validated, never run against real CloudFormation.
- The version marker is readable but nothing writes it on deploy yet.
- GDPR erasure's lake story is tombstone + anti-join + lifecycle expiry (#199):
  the pseudonymous rows physically remain until the bucket lifecycle drops
  them — disclosed in SECURITY §4.7 as the honest limit.

1.0 gated on the end-to-end suite passing against a real account.
