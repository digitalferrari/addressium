# addressium

A self-hosted replacement for the **email capabilities of Amazon Pinpoint**,
which [sunsets on 30 October 2026](https://docs.aws.amazon.com/general/latest/gr/sunset_services.html).

Runs entirely in **your** AWS account. You own the subscriber data (DynamoDB in
your account) and you own the sending reputation (your own SES identity). Not a
hosted SaaS — one deployment runs one or many **organizations**, all operated by
the same owner.

![addressium admin console](docs/images/screenshot.png)

> **Live demo:** the click-through UI at **<https://addressium.com/>** (or
> [`demo/index.html`](demo/index.html) locally) — a static, no-backend prototype
> with sample data.

> ### ⚠️ Status: pre-1.0, not production-ready
> This has **never been deployed to a real AWS account**. See
> [Status](#status) before putting a real list near it.

---

## What it does

| | |
|---|---|
| **Lists & subscribers** | Double opt-in with consent provenance (timestamp, IP, source URL) |
| **Campaigns** | Compose, schedule (now / at / recurring), send, pause, resume — never delete |
| **RSS → newsletter** | Point it at an XML feed; each edition is built and sent automatically |
| **Segments** | Dynamic predicates over attributes and engagement |
| **Drip sequences** | Multi-step journeys with waits measured in days |
| **Re-engagement & sunset** | Win-back sequence, then a clean unsubscribe for the unreachable |
| **Reporting** | Opens, clicks, bounces, complaints, unsubscribes, delivery rates, per-link click maps. Rejects, rendering failures and delivery delays are counted too, so a broken template alarms mid-send instead of surfacing after it. |
| **Suppression** | Automatic on bounce/complaint. Bounces suppress globally, unsubscribes per-org. Your existing SES account suppression list imports in bulk, so a migration does not re-mail addresses you already knew were dead. |
| **One-click unsubscribe** | RFC 8058 — required by Gmail and Yahoo for bulk senders |
| **Deliverability auto-halt** | Stops a campaign mid-flight when bounce/complaint rates breach your thresholds |
| **Multi-org silos** | Per-org KMS key, SES identity and config set. Dev orgs are fail-closed to an allowlist, so a test blast cannot reach a live list. |
| **Brandable subscriber site** | Per-org logo, theme, background; per-list presentation toggles, no rebuild |
| **RBAC** | Developer Admin / Editor / Analyst / Support, org-scoped, enforced server-side via Cedar |
| **Import & export** | CSV in, through an interactive field mapper. CSV/JSONL out including consent provenance, and the export re-imports through that same mapper — so leaving is a round trip, not just a download. |

### What Pinpoint did that addressium does not

The bar here is **feature fidelity plus a migration path**, not a wire-compatible
API clone — the routes are console-shaped, and there are no Pinpoint REST paths
or SDK compatibility. Against that bar the core list → campaign → send loop is
faithful and in places better. These are the gaps, checked against the code
rather than remembered:

| Pinpoint capability | Here |
|---|---|
| **Endpoints** (subscribers) | Flat attributes only — no multi-valued attributes, metrics, or Location/Demographic model |
| **Dynamic segments** | Attribute predicates only. The v1 engine **requires a base list** and throws on engagement predicates; the OpenSearch mirror is the escape hatch |
| **Imported segments** | Not supported — import creates subscribers, not segments |
| **Campaign scheduling** | No per-recipient local-time send, quiet hours, frequency caps, or campaign end dates |
| **Journeys** | Linear drip only — no conditional splits, multivariate branches, holdout activities, goal exits or re-entry rules |
| **Event-triggered campaigns** | No custom-event ingestion, no event-triggered entry |
| **Transactional send API** | No `SendMessages` analogue. Transactional mail exists (§4.2, and `EmailClass` gates its eligibility) but has no public API |
| **Templates** | No Handlebars, no version-history retention, no default substitutions. MJML compiles browser-side, so a drip step on an MJML template fails loudly rather than silently |
| **Sending** | Per-recipient `SendEmail`; `SendBulkEmail` 50-destination batching is not implemented. No attachments |
| **Recommenders, SMS/push/voice/in-app** | Out of scope by design — see below |

And the other direction, because a migration is a trade in both: double opt-in
with per-list consent provenance, RFC 8058 one-click unsubscribe, hybrid
suppression scoping, the per-link click map, DST-aware recurring scheduling, a
send lifecycle whose idempotency claims survive pausing, Cedar-backed
server-side RBAC, token redaction before analytics, an SSRF guard on feeds, and
a preference centre reachable without a password.

Anything in the first table that someone commits to building gets its own issue.

**Deliberately not included:** SMS, push, voice, in-app, recommender models, or
A/B testing. Pinpoint's surviving non-email channels moved to AWS End User
Messaging; this is email only, on purpose.

**There is no AI layer** (#62, #227). AI report narratives were cut and the code
is gone — an external provider plus a third-party API key inside a
compliance-sensitive mail system, unrelated to sending email. Nothing to
configure and nothing to leave switched off. Its API-key upsert was also the only
code in the product that ever wrote a secret, so no role now holds
`secretsmanager:CreateSecret` or `PutSecretValue` at all; a CDK assertion fails
the build if one reappears.

---

## Architecture

```
                     ┌──────────────┐
  Operator ─────────▶│ Admin console│──┐
                     └──────────────┘  │
                                       ▼
  Subscriber ───────▶┌─────────────────────────┐
  Publisher site ───▶│  API Gateway HTTP API   │
                     │  JWT authorizer PER     │
                     │  route; public routes   │
                     │  have none              │
                     └───────────┬─────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        AdminApiFn        Public functions    ProvisioningFn
     (one router,        (signup, confirm,   (per-org KMS key,
      27 routes)          unsubscribe, …)     SES identity)
              │                  │                  │
              └──────────────────┴─────────┬────────┘
                                           ▼
                                   ┌───────────────┐
   Schedule ─▶ EventBridge ─▶ LaunchFn ─▶│  DynamoDB   │
                                   │  single table │
   Send ─────▶ SQS ─▶ SenderFn ─▶ SES ──▶│  RETAIN +   │
                                   │  deletion     │
   Results ◀─ EventsFn ◀───── SNS ◀──────│  protection │
                        (SES event dest) └───────────────┘
```

**21 Lambda functions, 252 CloudFormation resources** — the default `dev` synth;
`prod` is 20 and 248, because non-prod adds a bucket auto-delete custom resource.
One function serves 27 of the 33 authenticated routes; the unauthenticated
functions stay separate because they hold genuinely different privileges —
merging them would give one internet-facing function the union of "can create
Cognito users", "can send mail", and "holds the webhook signing secret".

### Why each service

| Service | Why this one |
|---|---|
| **DynamoDB** | Single-digit-ms reads at any list size, no capacity planning, no idle cost. A relational DB needs an always-on instance. |
| **SES** | The mail transport. Per-org configuration sets isolate deliverability reputation between tenants. |
| **SQS** | Decouples "schedule a campaign" from "send 500,000 emails" — retries, backpressure, partial-batch failure reporting. |
| **SNS → SQS → Lambda** for events | An SNS→Lambda subscription is an *asynchronous* invoke: two retries, then the event is discarded. A dropped bounce is an address you keep mailing, so the queue sits in the middle — durable delivery, a dead-letter queue, and partial batch failure so one poison event does not fail its nine peers. |
| **EventBridge Scheduler** | Timezone-aware recurring sends that track DST correctly. Plain cron does not. |
| **Step Functions** | Drip steps wait days. Lambda cannot wait; Step Functions can, for fractions of a cent. |
| **KMS (asymmetric, per org)** | Signs magic-link tokens. Per-org so one key's compromise cannot forge another org's tokens. The public half is published as JWKS, verifiable by any JWT library. |
| **Cognito** | Operator login, MFA required, self-signup disabled. `custom:role` / `custom:orgs` claims drive server-side RBAC. |
| **S3** | Rendered-body archive (powers click maps), audit log under Object Lock (GOVERNANCE, 7-year default retention), analytics archive. |
| **CloudFront + OAC** | SPA delivery over HTTPS from private buckets. |

### Services addressium does **not** create

Your account probably already runs these. Creating our own would duplicate cost,
fight your existing rules, or quietly bypass your security posture.

| Service | What you do | Why |
|---|---|---|
| **WAF** | Attach your own WebACL and set `apiWebAclArn` / `cloudfrontWebAclArn`. The stack outputs `ApiStageArn`, `AdminDistributionId` and `PublicDistributionId` to associate against. | A resource carries only one WebACL, so ours would displace yours — and silently reattach on the next deploy. It was also ~$17/month against a ~$4 idle bill, and a CloudFront-scope ACL is only creatable in `us-east-1`, so it broke deploys in every other region. |
| **Ops alerting** | Set `opsAlertTopicArn` (an existing SNS topic) or `opsAlertEmail`. Alert routing is your infrastructure. | Consumes yours when set; creates and subscribes a topic when given only an email. Set neither and `deploy:check` warns. |

`npm run deploy:check` warns when no WAF association or alert target is
configured — shipping silently unprotected is worse than shipping without them.
A standalone `doctor` command is still **[Decided r2 — not yet built]**; today
those preflight checks live in `deploy:check` alongside its data-safety guard.

---

## Install

**Once, by the account owner, with admin credentials:**

```bash
aws cloudformation deploy \
  --template-file infra/bootstrap/addressium-bootstrap.yaml \
  --stack-name addressium-dev-bootstrap \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AdminEmail=you@example.com Stage=dev

npx cdk bootstrap aws://<account>/<region> \
  --custom-permissions-boundary addressium-dev-boundary
```

This creates a deploy identity that can deploy and operate addressium **and
nothing else**, constrained by a permissions boundary. Admin credentials never
have to be handed to a pipeline, a teammate, or an agent.

**Then, as the deployer:**

```bash
npm install
npm run build
npm run deploy          # deploy:check runs first and cannot be skipped
```

Details: [`scripts/README.md`](scripts/README.md) ·
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

---

## Upgrades

```bash
npm test                # 724 tests; 720 pass, 4 skip without LocalStack
npm run deploy:check    # dry run — refuses anything that would destroy data
npm run deploy          # in place; CloudFormation rolls back on failure
curl $API/version       # running build; nothing writes the deploy marker yet
```

### How you find out a fix exists

You do not, yet, and that is worth stating plainly rather than leaving as an
implied capability. An install today is "clone the repo and deploy", so it is
pinned to whatever commit was cloned, there is no notification channel, and
`curl $API/version` compares a running build against a marker nothing writes.

The intended shape is designed and **deliberately not built yet** (#213):
versioned, immutable release artifacts rather than a git checkout; a schema
version marker with ordered idempotent migrations run by a deploy-time custom
resource, refusing to skip a major version; and a CLI whose `status`, `doctor`
and `upgrade` are the whole user-facing surface — `doctor` mattering most,
because nearly everything that has broken in this repo was *configuration* no
test could see (a missing event destination, an unverified identity, an absent
MX record).

Why not now: the argument for building a migration framework early is that
shapes accumulate in the wild. **Nothing has ever been deployed**, so there are
zero installs and zero shapes — which makes right after the first real
deployment (#212) the moment this is worth most, not before it. Building an
upgrade path for installs that do not exist would be designing against guesses.
Explicitly rejected either way: Terraform (a second IaC tool and a state
distribution problem, for no gain over CDK), SAM (overlaps CDK), and storing
deploy credentials in Secrets Manager (circular — reading it needs credentials).

`deploy:check` creates a CloudFormation **change set** without executing it, and
fails if any data-holding resource would be replaced or removed:

```
✗ REFUSING: this change would destroy or replace data-holding resources
  Modify  replace=True  AWS::DynamoDB::Table  TableCD117FA1
     cause: Properties.KeySchema (RequiresRecreation=Always)
```

**Why this exists:** `RemovalPolicy.RETAIN` only prevents deletion when a *stack*
is torn down. It does **not** prevent *replacement*. Change a partition key and
CloudFormation creates a new, empty table and orphans the old one — nothing is
"deleted", so RETAIN is satisfied, and every subscriber disappears from the
application's view. Only a pre-flight check catches that.

Merging to `main` does not deploy. Deploying a mail system is a deliberate act.

### Schema changes

The data model is frozen by the problem domain — `EventType` is
`sent | delivered | open | click | bounce | complaint | unsubscribe`, because SES
emits a fixed set and you cannot invent a new measurement of an email. So this is
a rule, not a framework:

- new fields are **optional and additive** — never required, never renamed
- reads **tolerate absence** and fall back
- a genuine backfill gets a one-off script for that release

---

## Cost

Modelled in `packages/domain/src/cost.ts`, unit-tested, and driving the **Cost
estimator** page in the admin console — so these numbers and the ones on screen
cannot drift. us-east-1 on-demand list prices.

### One send to 40,000 subscribers — **$5.29**

| Line | Cost | Basis |
|---|---:|---|
| SES — outbound messages | $4.00 | 40,000 × $0.10/1,000 |
| KMS — magic-link signing | $0.60 | one asymmetric Sign per recipient |
| DynamoDB — engagement event writes | $0.29 | 58,800 events × 4 WRU |
| DynamoDB — send-path writes | $0.25 | 5 WRU/recipient |
| SQS + SNS — event transport | $0.10 | 3 SQS requests + 1 SNS publish per event |
| Lambda — events handler | $0.02 | 58,800 invocations |
| DynamoDB — send-path reads | $0.02 | 2 RRU/recipient |
| Lambda — sender | $0.01 | 20 invocations over 2,000-recipient slices |

One send generates **58,800 engagement events** (one delivery per recipient, plus
opens, clicks and bounces at 40% / 5% / 2%). Everything downstream of SES is ~24%
of the total.

### Fixed — **$4.20/month**, whether or not you send

24 CloudWatch alarms ($2.40) · 1 KMS key per org ($1.00) · 2 secrets ($0.80)

### Annual, 40,000 subscribers

| Cadence | Sends | Annual |
|---|---:|---:|
| Once | $5.29 | **$55.72** |
| Weekly | $275.12 | **$326.80** |
| Daily | $1,931.11 | **$1,990.50** |

Daily sending is **$0.136 per 1,000 emails** all-in — 36% above SES's raw $0.10,
for the whole platform around it. A hosted ESP at 40,000 contacts sending daily
is commonly $400–600/month.

Excludes WAF — including the two WebACLs the stack currently creates itself —
data transfer, and the free tiers most accounts still have.

---

## Repository layout

```
packages/core             entity types, zod schemas, version marker
packages/domain           business logic — pure, no AWS imports
packages/adapters-aws     DynamoDB / SES / KMS / SQS implementations of the ports
packages/rbac             Cedar-backed authorization
packages/segment          segment predicate evaluation
packages/magiclink-verify hardened reference verifier for publisher sites
services/*                Lambda entry points — thin wiring over the domain
apps/admin-web            operator console
apps/subscriber-web       subscriber directory, confirm & unsubscribe
apps/public-web           public list pages
infra/bootstrap           one-time account bootstrap (CloudFormation)
infra/cdk                 the application stack
demo/                     static UI prototype (addressium.com)
```

The domain layer imports no AWS SDK. It runs against in-memory adapters in tests
and DynamoDB in production, with no rewrite.

## Development

Node 20+, npm workspaces.

```bash
npm install
npm run build
npm test          # 724 tests: in-memory + real DynamoDB API via dynalite
                  # 720 pass; 4 skip without LocalStack
npm run test:web  # component tests for the three SPAs
npm run dev       # the API on :4000 over dynalite — no AWS, no credentials
npm run test:e2e  # the live smoke suite (needs a real account — never yet run)
```

Integration tests run the full journey — signup → double opt-in → send →
open/click → click map — against a **real DynamoDB API** (dynalite, no
Java/Docker).

## Security

Built to OWASP ASVS (L2) & API Top 10, NIST SP 800-63B, RFC 8725 (JWT), and CIS
AWS Foundations. The most security-sensitive integration point — the magic-link
verifier — ships as a hardened module, `packages/magiclink-verify`, plus a
browser drop-in that reads the token, verifies it, cleans the URL and hands back
a session object: a `<script>` tag and a public key, no build step, no network
call.

[Security design & threat model](docs/SECURITY.md) ·
[Reporting a vulnerability](SECURITY.md)

## Documentation

- [Design compendium](docs/DESIGN-COMPENDIUM.md) — every service, why it exists, what it costs
- [Architecture](docs/ARCHITECTURE.md) — canonical system design
- [Deployment](docs/DEPLOYMENT.md) — empty AWS account to running deployment
- [Security](docs/SECURITY.md) — STRIDE model and standards mapping

---

## Status

**Honest state, because a README that reads "done" is worse than useless:**

- **Nothing has ever been deployed.** No AWS account has run this, and that is
  the single largest thing not known about this codebase. A large class of
  defects here were invisible to `npm test` — the SES event plane was dead at
  three independent layers and every unit test passed.
- What `npm test` *can* now see is much wider than it was: `npm run dev` runs the
  full public journey — signup → confirmation mail → confirm → send → one-click
  unsubscribe — against the **real** SES/SQS/Scheduler adapters, over local
  stand-ins spoken to over the wire. It has already caught two live defects.
- What it still cannot see is anything where **AWS itself** has to behave: SES
  publishing to SNS, a real SES-shaped event payload, a mailbox provider issuing
  the one-click POST, a real Cognito JWT, EventBridge firing on consecutive days,
  real bounces tripping the halt gate. `npm run test:e2e` is written for exactly
  those and **has never been run**.
- `deploy:check` gates every deploy and now fails **closed** on a change-set
  shape it cannot interpret — but it has still never seen a real
  `describe-change-set` payload, so the first symptom of a shape mismatch will be
  "every deploy is blocked", not a silent miss.
- The version marker is readable, but nothing writes it on deploy yet, so
  `GET /version` cannot tell you whether you are running the build you deployed.
- There is **no upgrade path**. An install is pinned to whatever commit was
  cloned, and there is no channel to tell anyone a fix exists. Designed, not
  built — see Upgrades above for why that waits for a first real install.
- **Bulk export returns inline rather than streaming to S3.** Fine for an
  ordinary list; an org large enough to exceed a Lambda response is exactly the
  org most likely to be migrating.
- The importer reads a real Pinpoint export **through the field mapper** — a
  verified sample is CSV with 73 dotted columns (`Address`, `EndpointStatus`,
  `OptOut`, `Attributes.*`, `User.UserAttributes.*`), and list membership rides
  in the `Attributes.*` columns as `true`/`false`/empty where empty means *never
  asked*. Gzipped JSON Lines exports are still unsupported, and a saved mapping
  is not yet re-offered on the next file with the same headers.
- The audit log is still dead code: the WORM bucket is provisioned and correctly
  moded, and nothing has ever written an object to it.

**1.0 is gated on** `npm run test:e2e` passing against a real AWS account and one
install running for 30 days. That gate is the whole of it — everything else on
this list is either done or deliberately deferred, and the first live deployment
is what turns the rest of this README from "asserted" into "observed".

The runbook for that first deployment is in
[`docs/DEPLOYMENT.md` §11](docs/DEPLOYMENT.md).

Do not migrate a real list onto this yet. A mail system that has never sent an
email can cost you a sending reputation that takes months to rebuild.

## License

See [LICENSE](LICENSE).
