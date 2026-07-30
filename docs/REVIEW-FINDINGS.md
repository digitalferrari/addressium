# Codebase review — findings

A full-codebase review across six areas: authentication, outbound API clients,
the analytics/Athena pipeline, the core send pipeline, the data layer, and
infrastructure. Every finding below was verified by reading the code; several
were reproduced empirically. Severities reflect production impact.

**Status legend:** ✅ fixed · ⬜ open

> **Re-verified 2026-07-29** (docs-vs-code audit): every Critical and High
> finding was re-checked against the code. All four P0s, all five Criticals,
> all six High-security items and every High-correctness item are now fixed in
> the codebase — statuses below reflect that pass, with issue refs. Two items
> survive: **no `event_id` in analytics rows** (Medium) and, as residuals, the
> missing API-Gateway-5xx and Step Functions failure alarms. Three of today's
> fixes landed *in* this pass: the `appendEvent` transaction keying (it
> targeted `CAMPAIGN#…` where the record lives at `CAMPAIGNREC#…`, failing
> every counter write on real DynamoDB), halt markers for record-less send ids
> (C5's recurring-edition half), and the remaining audit-call gaps
> (suppress/unsuppress, import runs, org creation).

---

## The headline

As configured today, a deployed stack **cannot send a single campaign** and
**cannot complete a login**. Four independent wiring defects each stop the
system on their own. These are not policy nits — they are the first things to
fix, and all four are cheap.

| # | Defect | Effect |
|---|---|---|
| P0-1 ✅ | `SenderFn` had no `SEND_QUEUE_URL`; `sqs:SendMessage` granted only to `schedulerRole` | Every campaign threw and DLQ'd; launches/drips got `AccessDenied` |
| P0-2 ✅ | Admin Cognito client has no `oAuth` block → `callbackUrls: ["https://example.com"]` | Hosted-UI login fails with `redirect_mismatch`; implicit grant also enabled. **Fixed** (#160): code grant only, real callback/logout URLs |
| P0-3 ✅ | Admin pool declares no `customAttributes`; SPA sends the **access** token but decodes the **id** token | `custom:role`/`custom:orgs` never reach the server → 403 on every RBAC route. **Fixed** (#161): attributes declared, SPA sends the id token, server rejects access tokens |
| P0-4 ✅ | Recurring `editionKey` is hardcoded `"edition"` | A recurring series sends **exactly one edition, ever**. **Fixed** — per-firing edition keys (C2 below) |

---

## Critical

### C1 ✅ Cross-tenant data leak in the campaign report
`services/reporting/src/index.ts` — `handler` took `orgId` from the path and
returned the report with **no `authorize()` call**, while `analyzeHandler` and
`usageHandler` in the same file both check. Any authenticated admin-pool user
could read any org's counters, deliverability rates, click map and A/B results.
Found independently by two reviewers. **Fixed** — added the org-scoped
`reports:view` check.

### C2 ✅ Recurring series send exactly one edition, ever
`services/api` passes a bare `SendDescriptor` as the scheduler payload, so
`normalize()` in `services/automations` always takes the legacy branch and
hardcodes `editionKey: "edition"`. `planLaunchDescriptor` therefore returns a
**constant** campaign id every firing; the first claims it and every subsequent
firing is silently `skipped: true`. A daily newsletter sends once and dies with
`{ok: true}` logs. **Fixed** (#162): the API passes a real
`RecurringLaunchPayload` carrying `<aws.scheduler.scheduled-time>` as the
edition key, the legacy branch derives a per-firing UTC-hour key, and the feed
path stamps `${base}-${editionKey}` into the campaign id.

### C3 ✅ Silent permanent recipient loss on any mid-send failure
`packages/domain/src/send.ts` takes the idempotency claim *before* the send
loop and never releases it. Crash at recipient 500 of 2000 → SQS redelivers →
claim fails → returns `{skipped: true}` → message ACKed. **The remaining 1500
are never sent and nothing reports it.** At `CHUNK_SIZE=2000` and 14 msg/s a
slice takes ~143 s of send time, so timeouts are the expected case. The same
shape affects `sendToSubscriber` (drip/resend/re-engagement), where the claim is
burned before the send. **Fixed** (#163): claims are per-recipient, taken
immediately before each send and explicitly released on failure, so a
redelivery re-sends exactly the remainder.

### C4 ✅ GDPR erasure does not erase
`eraseSubscriber` anonymizes one DynamoDB item. It does not touch: the nightly
full-table PITR export (every snapshot under `entities/` holds the pre-erasure
email, attributes and `consent.ip`), the event log, the S3 analytics lake, the
`externalId` (omitted from the override list, so the Cognito `sub` survives),
the `EXTID` pointer item, or the entitlement record. The analytics bucket has
**no lifecycle rules at all**, so every snapshot is retained forever. As built,
DynamoDB-only erasure is structurally incapable of satisfying Art. 17.
**Fixed** (#164, #199): erasure now strips `externalId`, deletes the `EXTID#`
pointer and the email reservation, strips consent IP/UA/sourceUrl, deletes the
entitlement and **all** event rows for the subscriber, writes an `ERASURE#`
tombstone that flows to the lake as `event_type='erased'`, and the analytics
bucket carries lifecycle rules (730d events / 30d entities + errors / 14d
results). Honest residual, disclosed in SECURITY §4.7: lake rows bearing the
pseudonymous id physically remain until expiry — tombstone + anti-join, not
rewrite.

### C5 ✅ The deliverability halt is decorative
`checkDeliverability` sets `campaign.status = "halted"`, but **nothing in the
send path reads `Campaign.status`** — `sendCampaign` gates only on the schedule
record. A campaign that trips a hard bounce-rate halt keeps sending to
completion. Worse, for recurring editions and A/B sub-campaigns no `Campaign`
record exists under the send-time id, so even the status write is a no-op.
**Fixed**: the send path re-reads halt state before the loop and every 100
recipients (#165), orgs get default halt thresholds at provisioning (#217), and
— for record-less send ids (recurring editions, drip, re-engagement) —
`checkDeliverability` now persists a **halt marker** the send path's gate also
consults (2026-07-29), so a complaint storm on a series can actually stop it.

---

## High

### Security
- **✅ `secretsmanager:GetSecretValue` on `"*"`, reachable unauthenticated.**
  `POST /signup/batch` is public and reads a **tenant-controlled** ARN from the
  org record. The role can read every secret in the account — including the
  confirmation-token HMAC key (forge opt-in confirmations) and the webhook key
  (forge entitlement grants). Names are deterministic (`addressium/*`), so this
  scopes cleanly. **Fixed** (#166): scoped to `addressium/*` in-account.
- **✅ `cognito-idp:AdminCreateUser` on `"*"` from the public `/confirm` route**,
  which includes the control-plane admin pool. Provisioning already tags pools
  `app=addressium` — the same tag-condition pattern used for `kms:Sign` fixes it
  in one line. **Fixed** (#23, #167): a routeless `SubscriberAccountFn` holds
  three enumerated actions narrowed to named pool ARNs, `/confirm` holds only
  `lambda:InvokeFunction` on it, and an explicit `Deny` covers the admin pool.
- **✅ `custom:orgs = "orgA,*"` escalates to every org.** `grantFromClaims` only
  treats `"*"` as a wildcard when it is the whole claim; Cedar then matches
  `principal.orgs.contains("*")` against the list. This **diverges from
  `inScope()`**, which correctly denies — the two authorization paths disagree,
  and no test covers it. **Fixed**: embedded wildcards are rejected outright and
  Cedar uses a dedicated `allOrgs` boolean, with a wildcard test.
- **✅ Sign-out is cosmetic.** `logout()` clears `sessionStorage` only; the
  Cognito Hosted-UI session survives, so the next user clicks "Sign in" and is
  returned fully authenticated **bypassing the pool's required MFA**.
  **Fixed** (#169): logout redirects through the Cognito `/logout` endpoint.
- **✅ HTML attribute injection via `$` expansion in link retagging.**
  `String.replace` with a replacement string expands `$&`; `escapeHtml` does not
  escape `$`, and merge values are substituted before retagging — so `$&` in a
  subscriber attribute re-injected raw quotes, breaking every link *and* turning
  `onerror=` into a real attribute. **Fixed** with replacer functions + test.
- **✅ `/signup` has no honeypot and no CAPTCHA** while `/signup/batch` has both.
  The weaker endpoint is the one embedded in publisher pages — it can be scripted
  to email-bomb arbitrary addresses through your verified SES identity.
  **Fixed** (#40, #170, #230): honeypot on both routes with a shared constant
  rendered by both first-party clients, opt-in reCAPTCHA per org.

### Correctness
- **✅ Fan-out slices skip and duplicate recipients.** Slices are planned by
  numeric offset at T0 and re-resolved against a freshly re-read set at T1..Tn.
  Subscriber ids are UUIDs, so any signup/unsubscribe in between shifts every
  later index — recipients are silently skipped or sent twice. The in-memory test
  double preserves insertion order and therefore **cannot catch this**.
  **Fixed** (#171): slices are key-range windows over ordered ids via the sparse
  confirmed-subscriptions GSI; disjoint, contiguous, last open-ended.
- **✅ Duplicate full-campaign send at the chunk boundary.** The fan-out decision
  takes no claim, so a redelivered parent message that crosses `CHUNK_SIZE`
  claims different keys and sends the entire list a second time.
  **Fixed** (#172): one shared per-recipient claim key space across sliced and
  unsliced paths.
- **✅ A ReDoS in feed parsing.** `blocksBetween` is quadratic; measured 341 ms →
  1,355 ms → 5,412 ms at 64/128/256 KiB (clean O(n²)). The fetch cap is 5 MiB —
  extrapolating to tens of minutes of pegged CPU; ~700 KiB alone exceeds the
  Lambda timeout. The existing ReDoS test exercises a different, linear helper.
  **Fixed** (#173): linear `indexOf` scan.
- **✅ A bad feed sends a blank email to the entire list.** `parseFeed` returns
  `[]` rather than throwing, `[]` is truthy in the launch guard, and there is no
  empty-template guard — so every subscriber gets an empty email with a generic
  subject. Because the edition id is claimed, it **cannot be corrected and
  re-sent**. **Fixed** (#174): empty feed skipped at launch, `templateIsEmpty`
  throws at send.
- **✅ Feed failures retry ~185× against the origin.** `scheduleRecurring` sets no
  `RetryPolicy`, so EventBridge Scheduler defaults apply; permanently-fatal
  errors retry identically. **Fixed** (#175): `MaximumRetryAttempts: 2`,
  `MaximumEventAgeInSeconds: 900`.
- **✅ Throttle is per-invocation.** SQS scales the sender to hundreds of
  concurrent executions, each with a full token bucket — effective rate is
  `concurrency × 14/s`. Drip and re-engagement bypass it entirely.
  **Fixed** (#176): one CDK value feeds both the event-source concurrency cap
  and the rate divisor; drip/re-engagement pace at a fraction.
- **✅ Partial batch failures unconfigured.** The sender returns
  `batchItemFailures` but the event source doesn't set
  `reportBatchItemFailures`, so one throw redelivers the whole batch of 10 —
  **re-sending already-delivered mail**, up to 5×.
  **Fixed**: `reportBatchItemFailures: true` on both SQS sources, per-message
  failure returns, synth-asserted.
- **✅ Campaign one-click unsubscribe points at a `.example` placeholder** with no
  signed token, so Gmail/Yahoo one-click POSTs into the void.
  **Fixed**: signed token + real route; `unsubscribe_url` merge value.
- **✅ Pausing a one-off destroys the send** rather than deferring it: the
  schedule self-deletes on fire, the sender sees `paused` and ACKs the message.
  **Fixed** (#179): parked via `deferSend` and re-enqueued on resume; schedules
  are never deleted.
- **✅ A/B split is recomputed at finalize** from a fresh count, so the remainder
  window shifts — some recipients get nothing, others get the email twice.
  **Moot**: A/B testing was cut (#63); no A/B code exists.
- **✅ Re-engagement sunsets people who were never emailed** — the send result is
  discarded, so a transient failure still advances the sequence to unsubscribe +
  suppress. **Fixed** (#181): the sequence advances only on a real send;
  never-mailed subscribers have no coldness anchor and are skipped.

### Scale
- **✅ Unbounded reads on hot paths.** The admin subscribers endpoint loads
  **every** subscriber then filters in memory; `checkDeliverability` re-reads the
  **entire campaign event log on every bounce/complaint** (quadratic);
  `listConfirmed` filters after reading, so every send pays for unsubscribed and
  bounced rows; the re-engagement sweep is a full org scan plus N+1. None of this
  survives the 500k-subscriber org the platform is designed for.
  **Fixed** (#182, #221, #233): paginated prefix search on the email GSI, the
  sparse confirmed-subscriptions GSI with key-range queries, deliverability
  reads stored counters, and the sweep is paged with checkpoints. Residuals:
  record-less edition ids still fold their event log (their counter is skipped
  by design), and the sweep keeps an N+1 subscription read per subscriber.

---

## Medium (selected)

- ⬜ **No `event_id` in analytics rows** — duplicates are permanently
  unresolvable, and the source UUID is read then discarded. Not retroactively
  fixable: every day it ships is another day of undedupable rows.
  **Still open** (re-verified 2026-07-29): `EventAnalyticsRow` has no
  `event_id`, `toEventAnalyticsRow` drops it, and the Glue table has no column
  for it.
- ✅ **The audit log is dead code.** A WORM Object-Lock bucket is provisioned and
  `AUDIT_BUCKET` injected everywhere, but `recordAudit`/`S3AuditLog` have **zero
  call sites**. No erasure, export, suppression or import is ever recorded.
  **Fixed** (#191; last gaps closed 2026-07-29): team/privacy/export/alerts/
  segment/subscription actions audited at the call sites, and
  suppress/unsuppress, both import-run paths and org creation added in this
  pass.
- ✅ **CSV import defaults to `confirmed`**, contradicting the handler's own docs
  ("default to pending"), with no consent record — a double-opt-in bypass.
  **Fixed** (#192, #223): pending default; `confirmed` refused without an
  explicit per-column consent basis.
- ✅ **Suppression is keyed by mutable email** while subscribers are keyed by
  `sub`. An upstream email change orphans the entry and makes a
  complained/bounced person mailable again.
  **Fixed** (#193): dual gate (`mayMail` checks email-keyed entries and
  `Subscriber.status`); identity-sync carries the tombstone forward.
- ✅ **Every store write is an unconditional `Put`** (only `markEngaged` and the
  send claim are conditional) — a concurrent write can restore erased PII.
  **Mostly fixed** (#194): conditional writes now guard the subscriber profile,
  attributes, templates, the email reservation and send claims; some
  lower-risk writes (subscriptions, schedules) remain unconditional.
- ✅ **Nothing alarms on most of the system**: no API 5xx alarm, no alarm on the
  events Lambda, DDB throttles, Step Functions failures, or the analytics
  Lambdas — and the ops SNS topic **has no subscribers**.
  **Mostly fixed**: 30 alarms in a default synth (both queue/DLQ pairs, every
  handler's errors+throttles, the table, the swallowed drip enrollments on the
  confirm path (#245), analytics + Firehose when enabled),
  a dashboard, and `deploy:check` warns when the topic has no target.
  Residuals: no API-Gateway 5xx alarm and no Step Functions failure alarm.
- ✅ **No log retention on ~40 Lambdas** (never expire), no API access logging, no
  X-Ray, no WAF logging.
  **Fixed for retention** (#187): every log group has explicit retention
  (90d prod / 7d dev). API access logging and X-Ray remain off by design;
  WAF logging is the operator's ACL (the reference ACL logs with the
  `authorization` header redacted).
- ✅ **WAF managed rules will break template/campaign saving**
  (`SizeRestrictions_BODY` at 8 KB and `CrossSiteScripting_BODY` vs HTML email
  bodies). **Moot**: the stack creates no WebACL (#225), and the reference ACL
  puts those rules in COUNT mode for the HTML-body routes.
- ✅ **No CORS on the HTTP API** — the SPAs are on different origins and every
  browser call fails preflight. **Fixed** (#189).
- ✅ **`stage === "prod"` string equality** gates every data-protection decision,
  and `stage` is unvalidated: `"production"` or `"Prod"` deploys a prod stack
  with `DESTROY` removal policies and auto-delete buckets.
  **Fixed** (#190): stage is a closed set validated at synth; RETAIN +
  deletionProtection in every stage.
- ✅ **Athena guardrails are advisory** — `enforceWorkGroupConfiguration` is unset,
  so the 10 GB cutoff and results location are client-overridable.
  **Fixed** (#199): enforced.
- ✅ **Shipped queries have no date predicate** and will fail outright against the
  bytes-scanned cutoff once an org exceeds it.
  **Fixed** (#199): every query in `docs/reporting/queries.sql` bounds
  `event_date` and anti-joins erasures.
- ✅ **`provisioning`, `tokens` and `feeds` services are never deployed** — so no
  per-org KMS key, SES identity or JWKS endpoint is ever created, which is the
  premise the wildcard IAM is justified by.
  **Fixed** (#198): ProvisioningFn and TokensFn are deployed with routes.
  `feeds` is deliberately a library imported by LaunchFn, not a service.
- ✅ **Non-numeric env config silently disables safety**: a `NaN` chunk size makes
  a campaign claim itself and send to **zero** recipients, reporting success.
  **Fixed** (#201): `numEnv` throws on non-positive/non-finite values.

---

## What is genuinely well built

Worth protecting — do not regress these:

- **SSRF defense.** Every resolved address is validated and the socket is
  **pinned to the vetted IP** with `servername` set, so DNS rebinding is closed.
  Redirects aren't followed; no `Accept-Encoding` means no decompression bomb.
  No practical metadata bypass found.
- **Single-table key design.** Composite partitions have disjoint sort-key
  namespaces; no cross-tenant item collision was constructible via `#` injection.
- **Send idempotency primitive.** The send claim is a genuine conditional put —
  the flaw is its lifecycle, not the mechanism.
- **LLM retry policy.** Bounded attempts, exponential backoff with jitter,
  `Retry-After` honored and capped, overall deadline checked, hard response cap —
  and covered by real tests.
- **PKCE.** CSPRNG verifier, `S256`, `state` generated and compared,
  `sessionStorage` over `localStorage`, no refresh token persisted.
- **Analytics schema contract.** Row fields match the Glue columns exactly;
  partition-projection templates match the Firehose prefixes; the streamed and
  exported tiers cannot collide.
- **One recipient per message** — no Cc/Bcc, per-recipient token.

---

## Suggested order

1. **The four P0s** — nothing can be tested end-to-end until login works and the
   send pipeline can execute. (P0-1 done.)
2. **Security**: scope the two wildcard IAM grants, fix the `orgs` wildcard
   parsing, real logout, `/signup` bot protection.
3. **Send correctness**: C2, C3, C5, then fan-out slicing and the ReDoS/blank-feed
   pair.
4. **Observability before scale** — most of the above fails silently today; add
   alarms and log retention so the next problem is visible.
5. **Compliance**: erasure reaching the lake, the audit log, import consent
   defaults.
