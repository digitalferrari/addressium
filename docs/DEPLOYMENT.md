# Deploying & operating addressium

This guide takes you from an empty AWS account to a running deployment with one
or more publisher organizations. addressium runs entirely in **your** account;
there is no addressium-hosted control plane.

> ### ⚠️ Status: this runbook has never been run
> **Nothing here has ever been deployed to a real AWS account.** Every step below
> is written against the source and the synthesized CloudFormation template, not
> against a deployment that happened. Commands may be wrong in ways only a real
> account will reveal. Read [Status](../README.md#status) before you point this
> at a domain you care about.

> **`[Decided r2 — not yet built]`** marks a decision recorded in the
> [design compendium](DESIGN-COMPENDIUM.md) that the CDK does **not** implement
> yet. Where you see it, the surrounding text describes the target state and the
> as-built behaviour is stated next to it. Deploy against the as-built behaviour.

- [Architecture & Design](ARCHITECTURE.md) — the canonical system design.
- [Security Design & Threat Model](SECURITY.md) — STRIDE model + standards.
- [Design compendium](DESIGN-COMPENDIUM.md) — every service, why it exists.

---

## 1. Prerequisites

- **Node 22+** and npm (the repo is an npm-workspaces monorepo; every Lambda
  runs `NODEJS_22_X` and `package.json` requires `node >=22`).
- **An AWS account.** You do **not** deploy with admin credentials. The account
  owner runs a one-time bootstrap that creates a constrained deploy identity;
  everything after §1 runs as that identity.
- **A sending domain** you control DNS for (needed to verify SES and pass
  DKIM/SPF/DMARC). SES starts in *sandbox* mode — request production access when
  you are ready to send to unverified recipients.

### The one-time account bootstrap

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
have to be handed to a pipeline, a teammate, or an agent. `Stage` must match the
`stage` in `addressium.config.json` (§3); the boundary is named
`addressium-<stage>-boundary`, and the stack prints it as the `BoundaryArn`
output along with the exact `cdk bootstrap` line to run.

`npx cdk bootstrap` on its own — with no permissions boundary — leaves a
"scoped" deploy identity that can create IAM roles, which is privilege
escalation to administrator. Do not skip the boundary. The reasoning, the
alternative `scripts/aws-bootstrap.sh` path for disposable test accounts, and
the honest caveat about the CloudFormation execution role are in
[`scripts/README.md`](../scripts/README.md).

**Then, as the deploy identity** (`aws sts get-caller-identity` should succeed),
the rest of this guide applies. That identity needs to create DynamoDB, Lambda,
SES, KMS, Cognito, API Gateway, SQS, SNS, EventBridge, Step Functions, S3,
CloudFront, Secrets Manager and IAM resources.

> **WAF is deliberately absent from that list.** addressium consumes an
> operator-supplied WebACL rather than creating a competing one (#30/#31, #225)
> — see §8. A default synth contains zero `AWS::WAFv2::WebACL` resources, so the
> deploy identity needs no `wafv2:*` permission at all. You create the ACLs
> yourself, with whatever principal already manages edge protection.

## 2. Build

```bash
npm install        # all workspaces
npm run build      # tsc -b across packages/services/apps/infra
npm test           # 734 tests (730 passing, 4 conditional skips), no AWS creds needed
npm run test:web   # 37 component tests
```

`npm test` runs in-memory and against a real DynamoDB API (dynalite — no Java,
no Docker). With LocalStack down that is 250 passing and 4 skipped: the SQS, KMS
and EventBridge Scheduler adapter tests, plus a placeholder that exists **only**
when LocalStack is unreachable. Bring up `docker-compose.localstack.yml` first
and the total becomes 253, all passing — the placeholder is not registered, so
the two totals never match.

## 3. Configure the control plane

The control plane is deployed **once per stage** and seeds the admin Cognito
pool plus the first admin user(s), so you can sign in with no manual pool setup.

```bash
cd infra/cdk
cp addressium.config.example.json addressium.config.json
```

Edit `addressium.config.json`:

| Field | Meaning |
| --- | --- |
| `stage` | Stage suffix; the stack is named `addressium-<stage>` (e.g. `dev`, `prod`). |
| `region` | AWS region to deploy into. |
| `adminEmails` | One or more emails seeded as the first Developer Admin(s). Each receives a Cognito invite. |
| `adminHostedUiDomainPrefix` | Prefix for the admin Cognito Hosted-UI domain. Must be globally unique in the region. |

### Optional CDK context flags

Pass with `-c key=value` on `cdk deploy`, or add to `cdk.json` → `context`:

| Context key | Default | Effect |
| --- | --- | --- |
| `enableAnalytics` | **off** | When `true`, adds the deferred analytics tier: a Kinesis stream off the DynamoDB table, Firehose → S3, a Glue database + two tables (`events` and `entities`, #199), and an Athena workgroup, plus the export/snapshot/replay Lambdas. Off by default (#64); the core design does not depend on it. |
| `enableOpenSearchMirror` | **off** | When `true`, provisions the OpenSearch Serverless mirror fed by DynamoDB Streams (segment search at scale). Off by default (#64). |
| `auditRetentionYears` | `7` | Object Lock default retention on the audit bucket, in years (7 → 2555 days). See §9. |
| `confirmUrlBase` | derived | Base URL used in double-opt-in confirmation links. Set this to your subscriber site's origin. |
| `sesMaxSendRate` | `14` | Your account's SES send rate in messages/second (a fresh production account gets 14) — set it to your real quota. Everything that sends divides this down rather than each taking it whole, so the aggregate stays inside the limit (#176). |
| `senderMaxConcurrency` | `5` | How many sender Lambdas may run at once. Sets the SQS event source's cap *and* the divisor the sender applies to `sesMaxSendRate`, from one value — the two drifting apart is worse than neither, because it looks configured. |

> **Leave the two analytics flags off unless you are specifically testing them.**
> They are opt-in, off by default, and demoted out of the core design by #64 —
> not removed. Both carry standing cost well above the rest of the stack
> combined. Concretely, on a `dev` synth: default is 357 resources / 29 Lambda
> functions; `-c enableAnalytics=true -c enableOpenSearchMirror=true` is 399
> resources / 33 Lambda functions, and emits three more stack outputs
> (`SegmentCollectionEndpoint`, `AnalyticsBucketName`,
> `AnalyticsReplayFunctionName`). Neither flag is set
> anywhere in the repo, and neither has a default value in `cdk.json`.

### Ops alerting configuration

| Field | Meaning |
| --- | --- |
| `opsAlertTopicArn` | An **existing** SNS topic the CloudWatch alarms publish to. Alert routing (PagerDuty, Slack, on-call rotation) is account-wide infrastructure; addressium consumes it rather than creating a competing topic (#22/#32/#67, #222). |
| `opsAlertEmail` | Simple alternative for a setup with no existing topic — one email subscription. |

Set **one** of them. With `opsAlertTopicArn`, no topic is created and no
`OpsAlertsTopicArn` output is emitted — addressium does not export an ARN it
does not own. With only `opsAlertEmail`, a topic is created and that address is
subscribed. Set **neither** and the stack still deploys, but every alarm
publishes to a topic with no subscribers: `npm run deploy:check` warns about
exactly this before it inspects anything else, because a stack that ships 28
alarms into a void *looks* monitored, which is worse than one with none.

## 4. Deploy

Deploy from the **repo root**, not from `infra/cdk`:

```bash
npm run deploy         # deploy:check runs first and cannot be skipped
```

`deploy` is wired to a `predeploy` hook, so `scripts/deploy-check.sh` always runs
first. It creates a CloudFormation **change set without executing it**, inspects
it, and exits non-zero — aborting the deploy — if any data-holding resource would
be **replaced or removed**:

```
✗ REFUSING: this change would destroy or replace data-holding resources
  Modify  replace=True  AWS::DynamoDB::Table  TableCD117FA1
     cause: Properties.KeySchema (RequiresRecreation=Always)
```

**Why it cannot be skipped:** `RemovalPolicy.RETAIN` governs stack *deletion*, not
resource *replacement*. Change a partition key and CloudFormation creates a new,
empty table and orphans the old one — nothing is "deleted", RETAIN is satisfied,
and every subscriber vanishes from the application's view. Only a pre-flight
change-set inspection catches that. `cd infra/cdk && npm run deploy` bypasses the
hook; don't.

> `deploy:check` is validated against change-set fixtures, **never against real
> CloudFormation**. It is the only preflight that exists — there is no `doctor`
> command. It also warns when no WAF association or alert target is configured
> (§3), before it inspects anything else.

### Stack outputs you will need

18 outputs are emitted in a default deploy — 17 when you supply
`opsAlertTopicArn` (the `OpsAlertsTopicArn` output is then omitted, §3) — 21
with both analytics flags on, plus `BackupVaultName` in prod:

| Output | Use |
| --- | --- |
| `HttpApiUrl` | `VITE_API_BASE` for all three SPAs (§5). A URL, not an ARN. |
| `AdminPoolId` / `AdminClientId` | `VITE_COGNITO_*` for the admin console. |
| `AdminSiteBucket` / `PublicSiteBucket` | Sync the built SPA into these. |
| `AdminSiteUrl` / `PublicSiteUrl` | CloudFront **domain names** — not ARNs. |
| `ApiStageArn` | Attach your REGIONAL WebACL here (§8). |
| `AdminDistributionId` / `PublicDistributionId` | Attach your CLOUDFRONT-scope WebACL to these (§8). |
| `OpsAlertsTopicArn` | The topic the alarms publish to, when addressium created it (§3, §9). |
| `OpsDashboardUrl` | The CloudWatch ops dashboard (§9). |
| `SendQueueUrl` / `SendDlqUrl` | Send pipeline and its dead-letter queue (§9). |
| `SesEventsTopicArn` | Where SES publishes engagement events. |
| `AuditBucketName` | The WORM audit bucket (§9). |
| `UsageIngestFunctionName` | Daily usage-metering Lambda (§9). |
| `DripStateMachineArn` | The drip Step Functions state machine. |

The Hosted-UI **domain** is not an output — it is the
`adminHostedUiDomainPrefix` you set in §3.

## 5. Build & publish the web apps

Three React SPAs live under `apps/`. Each reads its config from Vite env vars at
build time:

| App | Purpose | Key env vars |
| --- | --- | --- |
| `apps/admin-web` | Operator console | `VITE_API_BASE`, `VITE_COGNITO_*` (Hosted-UI PKCE) |
| `apps/subscriber-web` | Directory / confirm / unsubscribe | `VITE_API_BASE`, `VITE_ORG_ID` |
| `apps/public-web` | Standalone + embeddable signup | `VITE_API_BASE`, `VITE_ORG_ID` |

> **The subscriber site has no login, and r2 does not call for one.** Its four
> routes are directory, subscribe-to-all, confirm and unsubscribe, all reached
> with a signed token or no auth at all — it reads no `VITE_COGNITO_*` and sends
> no `Authorization` header. A subscriber pool belongs to the org, not to
> addressium, and the addressium subscriber record is the primary identity (§6).
> The token-based **preference-centre API** is built (#74 —
> `POST /preferences/request`, `GET`/`POST /preferences`); its page in the
> subscriber SPA is **not yet built** (ARCHITECTURE.md §4.10).

```bash
VITE_API_BASE="https://<api-id>.execute-api.<region>.amazonaws.com" \
  npm --workspace @addressium/admin-web run build
# then sync apps/admin-web/dist to the admin S3 bucket / CloudFront from the outputs
```

The public site also ships `apps/public-web/public/embed.js` — a self-contained
widget operators paste into any page:

```html
<div data-addressium data-org="YOUR_ORG_ID" data-list="YOUR_LIST_ID"></div>
<script async src="https://your-public-site/embed.js"></script>
```

## 6. Sign in and provision your first organization

1. Open the admin console and sign in with a seeded `adminEmails` address (set a
   password from the Cognito invite; enable TOTP MFA).
2. **Create the organization** from the console's **Add organization** screen
   (#226), which calls the authenticated `POST /orgs`. This runs
   `services/provisioning`, which creates the org's **SES identity and
   configuration set** — plus the **KMS ES256 signing key** when magic links are
   on — at runtime (nothing per-org lives in CloudFormation).
3. Add the org's sending domain and publish the **DKIM/SPF/DMARC** DNS records the
   provisioning step returns. Wait for SES verification to go green.
4. Create lists, and you're ready to collect signups (double opt-in) and send.
5. Optionally save reusable message templates under **Templates** — paste **raw
   HTML** (hard-sanitized on save), write **MJML** source, or use the **visual
   builder** (GrapesJS drag-and-drop, outputs MJML). MJML/visual templates get a
   compile-and-preview button (compiled in your browser to responsive HTML).
6. Use **Compose & schedule** to build a send — subject plus a body authored as
   **Blocks**, **Raw HTML**, or **MJML** (optionally loaded from a saved
   template) — and dispatch it now, at a time, or on a recurring cron. It then
   appears under **Schedules**, where you can start, pause or archive it — sends
   are never deleted.

> **The subscriber Cognito pool.** `POST /orgs` requires a `subscriberPool` of
> `{"poolId":"..."}` for a pool **you already own**, and stamps it on the org as
> an optional `subscriberPoolId`. There is no create mode: a pool has too many
> consequential settings for this application to choose on your behalf, and the
> stack holds no `CreateUserPool` permission. Linking validates the pool with
> `DescribeUserPool` and nothing more.
>
> Supply a pool **if and only if** you enable magic links. With them off,
> addressium never contacts Cognito and sends plain email. With them on, the
> token carries the pool's `sub` so your paywall can resolve the reader against
> your own directory with no call back to us — which means each confirmed
> subscriber needs an account in that pool. addressium creates one, once, with a
> random permanent password and Cognito's welcome email suppressed (we own the
> messaging). It writes nothing else.
>
> That write is done by a dedicated function no route can reach. If you want to
> narrow its IAM further, name your pools at deploy time:
>
> ```bash
> npx cdk deploy -c subscriberPoolIds='["us-east-1_abc","us-east-1_def"]'
> ```
>
> Without it the grant falls back to `userpool/*` in your account — still three
> enumerated actions, still with an explicit `Deny` on the admin pool, but wider
> than it needs to be. Pools are linked at runtime, so their ARNs cannot be known
> at synth time unless you say so.

> **Dev / test organizations.** To rehearse real campaigns against production
> workflows without risk, add an org with `environment: "dev"`. Give it a full
> root domain that mirrors the prod one — `devsummitdaily.com` alongside
> `summitdaily.com` (a dev domain is a *domain*, not a subdomain, so DKIM/SES and
> even a `click.devsummitdaily.com` tracker work identically). The dev org is a
> complete, isolated silo — its own SES identity, reputation and subscriber
> list — so it can't reach a prod list. The console shows a **DEV** badge for it,
> and its usage is tagged so you can exclude it from cost rollups. As a hard
> safety net, set a **`devAllowlist`** (exact emails or `@domain` suffixes) at
> provisioning: a dev org sends **only** to those addresses, and with no
> allowlist it sends to no one — so a stray test blast can never reach a real
> reader.

### First-run setup checklist

The console's **Setup** screen (and a Dashboard banner) tracks the essentials and
flips the org's `setupComplete` flag once the **required** steps pass. It's
computed live from your config, so it stays accurate as you go:

| Step | Required | Done when |
|---|---|---|
| **Sending domain** | ✅ | the org has a verified sending domain |
| **First newsletter** | ✅ | at least one list exists |
| **Compliance footer & address** | ✅ | every list has a physical mailing address + footer (CAN-SPAM) |
| **Subscriber-site branding** | recommended | colors/logo are set |

SES domain verification and **sandbox exit** are AWS-side actions the checklist
points you to but can't complete for you — request SES production access before
sending to unverified recipients.

---

## 7. Configuring features

### Branding & theme (subscriber site)

Set a logo, primary/secondary colors, and a solid or gradient background per org
in the admin console (**Configure → Branding**). The subscriber site reads the
public branding endpoint and applies it as CSS variables — no rebuild needed.

### Subscriber-site presentation toggles

Per list (**Configure → Presentation**) you can show/hide the frequency label,
send-time label, description, reader count, and free/paid count. The subscriber
directory honors these flags at render time.

> **There is no AI layer to configure** (#62, #227). AI report narratives were
> cut and the code is gone: an external provider plus a third-party API key
> inside a compliance-sensitive mail system, unrelated to sending email. Do not
> create an LLM provider secret for addressium — there is nothing that would read
> it, and nothing in the stack can write one. `secretsmanager` access is
> read-only across every role, asserted at synth — with one deliberate exception
> (#234): the ConfirmSecret rotation function may write **its own** secret.

---

## 8. WAF & ops alerting — operator-supplied

Compendium #30/#31/#32 make a deliberate call: where an AWS account very likely
already runs something, addressium **consumes** it via configuration rather than
creating a competing copy. WAF and ops alerting are both in that category. This
section is the runbook compendium §3 promises.

> **The stack creates neither** (#225). A default synth contains zero
> `AWS::WAFv2::WebACL` resources; you create the ACLs and pass their ARNs, and
> the stack does the association. `infra/cdk/lib/waf.ts` is a **reference
> implementation** of the rules described below — nothing in the stack calls it,
> but it is exported, it is what addressium is tested against, and it is the
> configuration to copy rather than derive. Ops alerting is the same shape: a
> topic you own, or one created for you from `opsAlertEmail`.

### 8.1 REGIONAL WebACL — the HTTP API

Create or reuse a WebACL in the **same region as the stack**, scope `REGIONAL`:

1. Add the AWS managed rule groups **`AWSManagedRulesCommonRuleSet`** and
   **`AWSManagedRulesKnownBadInputsRuleSet`**.
2. Add a **rate-based rule** keyed on source IP. The public surface is 15
   unauthenticated route keys (13 paths) — signup, batch signup, confirm,
   unsubscribe (GET+POST), the two HMAC webhooks, JWKS, branding, public list,
   the directory, the three preference routes, version — and signup is the one
   that costs money when abused.
3. Optionally add a **CAPTCHA** action scoped to `POST /signup` and
   `POST /signup/batch`. The server-side honeypot exists and **both** shipped
   signup forms render the trap field (#230); the per-org reCAPTCHA check is
   off unless the org configures a secret.
4. **Associate** the ACL with the HTTP API's **stage ARN**.

### 8.2 CLOUDFRONT WebACL — the two SPAs

Same rule sets, but a CLOUDFRONT-scope ACL **must be created in `us-east-1`**
regardless of where the stack lives. Associate it with both distributions — the
admin console and the public site.

### 8.3 The ARNs

The stack emits what the associations need:

| You need | Stack output |
| --- | --- |
| HTTP API **stage ARN** | `ApiStageArn` |
| Admin distribution **id** | `AdminDistributionId` |
| Public distribution **id** | `PublicDistributionId` |

Record the resulting WebACL ARNs as `apiWebAclArn` and `cloudfrontWebAclArn` in
`addressium.config.json` and the stack does the association for you. Leave them
unset and no association is made — `npm run deploy:check` warns, naming which
surface is exposed.

### 8.4 Five things that break this application if you get them wrong (#188)

Copy `infra/cdk/lib/waf.ts` and you get all of these. Build the ACL by hand and
each one is a defect waiting for the first person who tries to save a newsletter.

| # | What | Why |
| --- | --- | --- |
| 1 | Set **`SizeRestrictions_BODY`** and **`CrossSiteScripting_BODY`** to **Count** on `AWSManagedRulesCommonRuleSet` (REGIONAL ACL only) | The first blocks bodies over 8 KB; the second blocks bodies containing markup. Saving a campaign or template posts an entire HTML email, so attached with no exclusions they break `POST /campaigns` and `POST /templates` — the two requests the console cannot work without |
| 2 | Add your own **oversize-body block** scoped to everything *except* `/campaigns`, `/templates`, `/campaigns/schedule` | Counting rule 1 turns body-size protection off for **every** route, including the unauthenticated ones where a multi-megabyte body is pure denial-of-wallet |
| 3 | Match `/signup` with **`EXACTLY`**, not `STARTS_WITH`, in any CAPTCHA rule | `STARTS_WITH` also catches `/signup/batch`, which the subscriber site calls server-to-server. A CAPTCHA challenge to a non-browser client is a broken endpoint |
| 4 | Add **`URL_DECODE`** and **`NORMALIZE_PATH`** to every URI transformation, not just `LOWERCASE` | Without them `/%73ignup` and `/foo/../signup` both slip past. A CAPTCHA any script steps around by percent-encoding one character is decoration |
| 5 | Add a **scoped rate rule on `/signup*`**, far below the global one | A global 2000-per-5-minutes ceiling permits 2000 signups per IP per 5 minutes. Signup is the route that costs money when abused: every submission sends real mail to an attacker-chosen address, on the org's own SES reputation |

**Turn on logging** (`CfnLoggingConfiguration`) for both ACLs, redacting the
`authorization` header. Without it there is no abuse forensics and no evidence to
tune a rule from — and a WAF that blocks template saving with no log is
indistinguishable from a broken deploy, which is the shape every defect above
would take in production. The destination log group name **must** begin with
`aws-waf-logs-`; WAF rejects anything else.

**The trade rule 1 makes, stated plainly:** on those three routes the request
body is not WAF-inspected. What remains is the application's own defence — zod
validation at the boundary, `sanitizeEmailHtml` on raw HTML, and the CSP on the
rendered output. That is deliberate. The alternative is a console that cannot
save a newsletter.

> **A resource carries only one WebACL.** That is why addressium creates none:
> ours would displace yours, and the next `cdk deploy` would silently put ours
> back (#225).

### 8.5 Alert routing

Set `opsAlertTopicArn` (or `opsAlertEmail`) in config — see §3. If you supplied
only an email, the `OpsAlertsTopicArn` output names the topic that was created
for you; with your own ARN there is no such output.

`deploy:check` (§4) warns when neither is set, and likewise when the WAF ARNs
are unset. There is still no `doctor` command.

---

## 9. Day-2 operations

- **Deliverability alerts.** Bounce/complaint-rate breaches publish to the org's
  own `AlertConfig.snsTopicArn` — operator-supplied already, per org — and a
  `halt`-level breach flips the campaign to `halted` so the sender stops. Set
  that topic when you provision the org; with none set, nothing is published.
- **Infrastructure alarms.** 30 CloudWatch alarms in a default synth: the send
  queue and events queue with their DLQs, errors and throttles across every
  handler, DynamoDB throttles and system errors, drip enrollments the confirm
  path swallowed (§4.6, #245), and campaign templates failing to render
  (§4.5, #241). With the analytics tier on
  there are more — errors and throttles across the three analytics Lambdas
  (transform, snapshot, replay) plus two on the Firehose pipeline itself
  (#186). All publish
  to one topic: yours if you set `opsAlertTopicArn`, otherwise the one created
  from `opsAlertEmail`, whose ARN is the `OpsAlertsTopicArn` output. A CloudWatch
  **dashboard** is created (#229) — its URL is the `OpsDashboardUrl` output, and
  it shows the same alarm set the health endpoint derives its badge from.
- **The analytics tier has a tenant ceiling (#236).** Only relevant with
  `enableAnalytics` on. Firehose allows **500 active dynamic partitions per
  delivery stream**, and the fact tier partitions on `org_id` × `event_date` —
  so the working set is roughly **the number of orgs that send on a given day**,
  plus a little for records straddling a UTC midnight. One delivery stream
  serves the whole deployment.

  Past that line, records for the excess partitions divert to `events-errors/`.
  Two things make this nastier than an ordinary limit:

  - `AnalyticsTransformFailedAlarm` fires, but it says *"records are being
    parked"*, which reads as a transform bug. An operator will go and look at
    the Lambda, and the Lambda will be fine.
  - **Replay does not recover it.** `replayHandler` re-runs the same transform
    into the same partitions and hits the same wall. Every other diversion cause
    has a working recovery path; this one does not.

  It is also bursty rather than gradual: a deployment sitting at 300 orgs
  crosses the line on the first day a few extra publications happen to send,
  loses a slice of that day, and looks fine again tomorrow. Partial days are the
  hardest analytics defect to notice.

  **What to do.** The quota is a *soft* limit — raise it through AWS Support
  before you approach it, not after. Watch the org count that actually sends
  daily, not the org count you have. If you are heading past a few hundred
  sending tenants, the partition key itself needs revisiting (#236); do not
  reach for a larger `bufferingHints.intervalInSeconds`, which lengthens each
  partition's active window and makes this **worse**.
- **The send DLQ.** `SendDlqUrl` is where poison send descriptors land, and
  `SendDlqNotEmptyAlarm` is what tells you. Drain it deliberately; nothing
  redrives it for you.
- **Suppression.** Bounces and complaints auto-suppress; admins can also suppress
  manually. Suppression is enforced at send time.
- **Audit trail.** Sensitive actions are written to the WORM (S3 Object Lock)
  audit bucket named by `AuditBucketName`, with a default retention of
  `auditRetentionYears` (7 → 2555 days) and a RETAIN removal policy.
  The mode is **GOVERNANCE** (#9, #219): a privileged principal can still remove
  an object with `s3:BypassGovernanceRetention`, so a mistake — a bad retention
  setting, a test run, an object written by accident — is recoverable, and a
  non-prod stack can be torn down. COMPLIANCE cannot be undone by anyone,
  including AWS. Treat the bypass permission as break-glass and grant it
  deliberately. Set `auditRetentionYears` before the first deploy: it is stamped
  on every object written from then on and cannot be shortened afterwards.
- **Logs.** 27 log groups, one per application handler, retention 90 days in
  `prod` and **7 days in dev/staging** — keyed off the validated `stage` value
  (#190), so an unrecognised stage fails at synth rather than silently
  misconfiguring retention.
- **Usage & cost.** Per-org usage is metered and cost is estimated from configurable
  rates (see `packages/domain/src/usage.ts`). Campaign counters are maintained
  transactionally with each engagement event (#221), so the campaign list and
  usage rollups read real figures; sends under a record-less id (recurring
  editions, drip, re-engagement) fold their event log instead.

## 10. Updating & tearing down

From the repo root:

```bash
npm --workspace @addressium/infra-cdk run diff   # preview the change
npm run deploy                                   # roll forward (§4)
curl $API/version                                # running vs deployed
```

> `GET /version` returns `deployed: null` and `inSync: false` on every real
> install: the `SCHEMA#VERSION` marker is readable but **nothing writes it on
> deploy yet**, and `VersionFn` holds read-only access to the table. Treat the
> `running` value as the only meaningful field for now.
> **[Decided r2 — not yet built]**

To tear a deployment down, use the teardown script — **not** `cdk destroy`:

```bash
npm run teardown:aws -- --stage dev --region us-east-1
npm run teardown:aws -- --stage dev --dry-run    # preview
```

`npx cdk destroy --all` removes the application stack and nothing else. It leaves
behind everything the bootstrap created — the deploy identity, the permissions
boundary, the budget alarm, and any SES receipt rules — which then have to be
found and deleted by hand. `scripts/aws-teardown.sh` destroys the stack first
(its resources reference the bootstrap roles), then unwinds the rest in order. It
**refuses `--stage prod` by design**, and it prompts for the stage name before
doing anything.

> **Teardown does not delete your data, and that is deliberate.** The DynamoDB
> table has `pointInTimeRecovery`, `deletionProtection` and `RemovalPolicy.RETAIN`
> in **every** stage — not just prod — so it survives the stack and is left
> orphaned, still costing on-demand rates. The audit bucket is RETAIN too, and its
> Object Lock retention means its objects cannot be deleted before they expire
> however hard you try. The admin Cognito pool is RETAIN. Non-prod site buckets do
> auto-delete. Deleting the survivors is a separate, deliberate act — find them
> by name from the stack outputs you noted in §4, and be certain before you do it.


---

## 11. The first live deployment

This is the 1.0 gate, and it has not been done. Nothing in this repository has
ever run in an AWS account, which is why the README's Status section leads with
it. Everything below is the operator's part; the code side — the smoke suite,
the deploy guard, the scoped policy — is written and waiting.

### Use a dedicated, disposable account

Not your main one. Blast radius, clean teardown, and its own bill. Expect **under
$2/month plus the domain** (~$12–15/yr): SES is $0.10 per 1,000 messages, a
Route 53 hosted zone is $0.50/month, and DynamoDB/Lambda/S3 are pennies at this
volume. Leave `enableAnalytics` and `enableOpenSearchMirror` **off** — both are
opt-in and both carry standing cost.

**Set a $10/month AWS Budget with an email alert first**, before anything else.
A budget alarm you set after the surprise is a receipt, not a control.

### The safety model: two independent layers

1. **SES sandbox — AWS-enforced. Do NOT request production access.** A new
   account can only send to *verified* identities, so AWS itself refuses
   everything else. This is the strongest guarantee available and it is free.
   `npm run test:e2e` calls `GetAccount` and **aborts** if production access is
   enabled, because application-level care is no substitute for the provider
   refusing.
2. **The dev-org allowlist.** Create the test org `environment: "dev"` with
   `devAllowlist` containing only your verified address. `recipientAllowedForDev`
   is fail-closed: a dev org with an empty allowlist sends to nobody.

Either layer alone stops mail reaching a stranger. Both means a bug in one is
still contained.

### Credentials

An IAM user with access keys, no console login, using
`infra/bootstrap/smoke-iam-policy.json`. The Allow list is necessarily broad —
CDK creates roles, keys, queues and identities — so the guardrail is the
explicit **Deny** on the four ways to put standing cost on the account:
`ses:CreateDedicatedIpPool`, `ses:PutDedicatedIpInPool`, `aoss:CreateCollection`
/ `es:CreateDomain`, and `ses:PutAccountDetails` — the last being how the sandbox
gets removed.

Set them as **environment variables in the Claude Code environment config**, not
in a chat message (it lands in transcript history) and not in Secrets Manager
(reading that needs credentials — chicken and egg).

### Region and DNS

`us-east-1`. It matches the config default and supports **SES inbound receipt
rules**, which exist only in `us-east-1`, `us-west-2` and `eu-west-1` — and the
smoke suite reads delivered mail out of S3 via an inbound rule rather than a
third-party mailbox, because that preserves full headers. `List-Unsubscribe` /
`List-Unsubscribe-Post` correctness is precisely what needs checking, and a
friendly webmail API hides exactly that.

```
MX  @             10 inbound-smtp.us-east-1.amazonaws.com
MX  bounce.<dom>  10 feedback-smtp.us-east-1.amazonaws.com
```

The second is the custom MAIL FROM record (§4.11). Skipping it fails **silently**
— `BehaviorOnMxFailure` is `USE_DEFAULT_VALUE`, so SES falls back to the
`amazonses.com` return path and SPF simply stops aligning. Provisioning returns
every record with a "why" note for this reason.

### The run

```bash
npm run deploy        # deploy:check runs first and cannot be skipped
npm run test:e2e      # the ten steps
npm run teardown:aws  # NOT `cdk destroy` — see below
```

> **Do not reach for `npx cdk destroy`, even in dev.** The DynamoDB table is
> `RemovalPolicy.RETAIN` **and** `deletionProtection: true` in *every* stage
> (#190) — a destroy fails on the table and orphans the audit bucket, the
> secrets and the admin pool, which are also RETAIN (§10).
> `scripts/aws-teardown.sh` walks the survivors deliberately: it refuses
> `prod`, prompts, and disables deletion protection first.

Before the first real deploy, rehearse `deploy:check` across three change
classes on a throwaway stack — a no-op (exits 0), a stateless edit (exits 0), and
a deliberate partition-key change (must exit **non-zero** naming `KeySchema`).
Do the third on a stack holding nothing you care about: the whole point of the
check is that such a change destroys data if it goes through. Replace the
synthetic fixtures in `packages/integration-tests/test/deploy-check.test.ts` with
the three real payloads.

Note the guard fails **closed** on a shape it cannot interpret, so a mismatch
between the assumed and actual `describe-change-set` payload will present as
"every deploy is blocked", not as a silent miss.

### Bounce and complaint handling

Use the SES simulator — `bounce@simulator.amazonses.com` and
`complaint@simulator.amazonses.com`. They work in the sandbox, cost nothing, and
exercise suppression and the deliverability halt gate **without** damaging a real
sending reputation or needing a second mailbox. Add both to the org's
`devAllowlist` for the run, or the allowlist refuses them before the gate is
reached.
