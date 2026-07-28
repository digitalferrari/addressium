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

- **Node 20+** and npm (the repo is an npm-workspaces monorepo).
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
> operator-supplied WebACL rather than creating a competing one (#30/#31) — see
> §8. **[Decided r2 — not yet built]**: today `lib/waf.ts` still builds a
> REGIONAL and a CLOUDFRONT ACL and the stack associates both, unconditionally,
> in every stage, so a deployer today *does* additionally need `wafv2:*` to
> create and associate them.

## 2. Build

```bash
npm install        # all workspaces
npm run build      # tsc -b across packages/services/apps/infra
npm test           # 259 tests, no AWS creds needed
npm run test:web   # 8 component tests
```

`npm test` runs in-memory and against a real DynamoDB API (dynalite — no Java,
no Docker). Four of the 259 skip unless LocalStack is reachable: the SQS, KMS and
EventBridge Scheduler adapter tests. Bring up `docker-compose.localstack.yml`
first and all 259 run.

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
| `enableAnalytics` | **off** | When `true`, adds the deferred analytics tier: a Kinesis stream off the DynamoDB table, Firehose → S3, a Glue database + table, and an Athena workgroup, plus the export/snapshot Lambdas. Off by default (#64); the core design does not depend on it. |
| `enableOpenSearchMirror` | **off** | When `true`, provisions the OpenSearch Serverless mirror fed by DynamoDB Streams (segment search at scale). Off by default (#64). |
| `auditRetentionYears` | `7` | Object Lock default retention on the audit bucket, in years (7 → 2555 days). See §9. |
| `confirmUrlBase` | derived | Base URL used in double-opt-in confirmation links. Set this to your subscriber site's origin. |

> **Leave the two analytics flags off unless you are specifically testing them.**
> They are opt-in, off by default, and demoted out of the core design by #64 —
> not removed. Both carry standing cost well above the rest of the stack
> combined. Concretely, on a `dev` synth: default is 252 resources / 21 Lambda
> functions; `-c enableAnalytics=true -c enableOpenSearchMirror=true` is 277
> resources / 24 Lambda functions, and adds two more stack outputs
> (`SegmentCollectionEndpoint`, `AnalyticsBucketName`). Neither flag is set
> anywhere in the repo, and neither has a default value in `cdk.json`.

### Ops alerting configuration **[Decided r2 — not yet built]**

| Field | Meaning |
| --- | --- |
| `opsAlertTopicArn` | An **existing** SNS topic the 24 CloudWatch alarms publish to. Alert routing (PagerDuty, Slack, on-call rotation) is account-wide infrastructure; addressium consumes it rather than creating a competing topic (#22/#32/#67). |
| `opsAlertEmail` | Simple alternative for a setup with no existing topic — one email subscription. |

**As built, neither key exists.** Grep the repo and `opsAlertTopicArn` and
`opsAlertEmail` appear only in prose. `lib/control-plane-stack.ts` creates its
own `OpsAlertsTopic`, points all 24 alarms at it, and emits its ARN as the
`OpsAlertsTopicArn` output. Until this lands, subscribe your ops channel to
*that* topic — see §9.

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
> command, and nothing anywhere warns you about a missing WAF association or
> alert target.

### Stack outputs you will need

13 outputs are emitted in every stage (15 with both analytics flags on):

| Output | Use |
| --- | --- |
| `HttpApiUrl` | `VITE_API_BASE` for all three SPAs (§5). A URL, not an ARN. |
| `AdminPoolId` / `AdminClientId` | `VITE_COGNITO_*` for the admin console. |
| `AdminSiteBucket` / `PublicSiteBucket` | Sync the built SPA into these. |
| `AdminSiteUrl` / `PublicSiteUrl` | CloudFront **domain names** — not ARNs. |
| `OpsAlertsTopicArn` | The topic all 24 alarms publish to today (§3, §9). |
| `SendQueueUrl` / `SendDlqUrl` | Send pipeline and its dead-letter queue (§9). |
| `SesEventsTopicArn` | Where SES publishes engagement events. |
| `AuditBucketName` | The WORM audit bucket (§9). |
| `DripStateMachineArn` | The drip Step Functions state machine. |

The Hosted-UI **domain** is not an output — it is the
`adminHostedUiDomainPrefix` you set in §3.

> **There is no output for the API stage ARN or for either CloudFront
> distribution ARN.** The WAF runbook in §8 needs all three, and compendium §3
> says the stack must emit them. **[Decided r2 — not yet built]** — §8 says what
> to do in the meantime.

## 5. Build & publish the web apps

Three React SPAs live under `apps/`. Each reads its config from Vite env vars at
build time:

| App | Purpose | Key env vars |
| --- | --- | --- |
| `apps/admin-web` | Operator console | `VITE_API_BASE`, `VITE_COGNITO_*` (Hosted-UI PKCE) |
| `apps/subscriber-web` | Directory / confirm / unsubscribe | `VITE_API_BASE`, `VITE_ORG_ID` |
| `apps/public-web` | Standalone + embeddable signup | `VITE_API_BASE`, `VITE_ORG_ID` |

> **The subscriber site has no login.** Its routes are directory, list, confirm
> and unsubscribe, all reached with a signed token or no auth at all — it reads
> no `VITE_COGNITO_*` and sends no `Authorization` header. An authenticated
> preference centre backed by a subscriber Cognito login is
> **[Decided r2 — not yet built]**; there is no authenticated preference-centre
> endpoint on the API either.

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
2. **Create the organization** with an authenticated `POST /orgs`. This runs
   `services/provisioning`, which creates the org's **KMS ES256 signing key,
   JWKS, SES identity and configuration set** at runtime (nothing per-org lives
   in CloudFormation). There is no Add-organization screen in the console yet —
   this is an API call, made with the JWT the console holds.
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
> `{"mode":"create"}` or `{"mode":"link","poolId":"..."}`, and stamps the result
> on the org as a **required** `subscriberPoolId`. The r2 target is that a
> per-org subscriber pool is **optional and reference-only** — addressium links
> an existing pool and never owns, creates or writes to it, with
> `Subscriber.externalId` as the join key and the addressium subscriber record as
> the primary identity. **[Decided r2 — not yet built]:** today `mode:"create"`
> really does call `CreateUserPool`, and if you set the org's
> `signupProtection.createAccountsOnConfirm` flag the public confirm handler
> calls `AdminCreateUser` in that pool (off unless you set it). If you want the
> reference-only posture now, pass `{"mode":"link"}` and leave
> `createAccountsOnConfirm` unset. Magic links do not depend on any of this —
> they are signed with the org's KMS ES256 key and verified against the published
> JWKS, whether or not a pool exists.

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

> **There is no AI layer to configure.** Compendium #62 cuts AI report
> narratives: an external AI provider plus a third-party API key inside a
> compliance-sensitive mail system, unrelated to sending email. Do not create an
> LLM provider secret for addressium. The stack still ships an `AnalyzeFn` and a
> `POST /orgs/ai-config` route — the cut is decided, the code has not been
> removed yet. Leave them unconfigured; with no `aiConfig` on the org there is
> nothing to call and no key to leak.

---

## 8. WAF & ops alerting — operator-supplied

Compendium #30/#31/#32 make a deliberate call: where an AWS account very likely
already runs something, addressium **consumes** it via configuration rather than
creating a competing copy. WAF and ops alerting are both in that category. This
section is the runbook compendium §3 promises.

> **As built, the stack still creates both.** `lib/waf.ts` builds a REGIONAL and
> a CLOUDFRONT WebACL, the stack associates the REGIONAL one with the API stage
> and sets the CLOUDFRONT one as `webAclId` on both distributions —
> unconditionally, in every stage — and it creates its own `OpsAlertsTopic`.
> Removing them is **[Decided r2 — not yet built]**. Read the rest of this
> section as the target, and mind the conflict note at the end.

### 8.1 REGIONAL WebACL — the HTTP API

Create or reuse a WebACL in the **same region as the stack**, scope `REGIONAL`:

1. Add the AWS managed rule groups **`AWSManagedRulesCommonRuleSet`** and
   **`AWSManagedRulesKnownBadInputsRuleSet`**.
2. Add a **rate-based rule** keyed on source IP. The public surface is 10
   unauthenticated routes — signup, batch signup, confirm, unsubscribe, the two
   HMAC webhooks, JWKS, branding, public list, version — and signup is the one
   that costs money when abused.
3. Optionally add a **CAPTCHA** action scoped to `POST /signup` and
   `POST /signup/batch`. The server-side honeypot and the per-org reCAPTCHA check
   both exist, but reCAPTCHA is off unless the org configures a secret and no
   shipped signup form renders the honeypot field yet — so today WAF is the only
   bot control that is actually on.
4. **Associate** the ACL with the HTTP API's **stage ARN**.

### 8.2 CLOUDFRONT WebACL — the two SPAs

Same rule sets, but a CLOUDFRONT-scope ACL **must be created in `us-east-1`**
regardless of where the stack lives. Associate it with both distributions — the
admin console and the public site.

### 8.3 The ARNs

**[Decided r2 — not yet built]** — compendium §3 requires the stack to emit the
ARNs these associations need. It does not:

| You need | Stack emits today |
| --- | --- |
| HTTP API **stage ARN** | `HttpApiUrl` — a URL. Derive the ARN from the API id in it. |
| Admin distribution **ARN** | `AdminSiteUrl` — a domain name. |
| Public distribution **ARN** | `PublicSiteUrl` — a domain name. |

Until the outputs land, resolve the ids from those values (or from the console)
and construct the ARNs by hand.

> **A resource can carry only one WebACL.** While the stack still creates and
> associates its own, attaching yours displaces it — and the next `cdk deploy`
> puts the stack's ACL back, silently. Until #66 lands, either accept the
> stack's ACLs or expect to reassociate after every deploy.

### 8.4 Alert routing

The target is `opsAlertTopicArn` (or `opsAlertEmail`) in config — see §3. Until
then, subscribe your ops channel to the `OpsAlertsTopicArn` output.

Nothing warns you if you skip any of this. There is no `doctor` command;
`deploy:check` (§4) inspects change sets for data destruction and checks neither
WAF association nor alert targets.

---

## 9. Day-2 operations

- **Deliverability alerts.** Bounce/complaint-rate breaches publish to the org's
  own `AlertConfig.snsTopicArn` — operator-supplied already, per org — and a
  `halt`-level breach flips the campaign to `halted` so the sender stops. Set
  that topic when you provision the org; with none set, nothing is published.
- **Infrastructure alarms.** 24 CloudWatch alarms, identical in every stage: 2 on
  the send queue and its DLQ, 20 on errors and throttles across 10 Lambda
  functions, 2 on DynamoDB throttles and system errors. All 24 publish to a
  single topic, which should be **yours** (#32) — **[Decided r2 — not yet
  built]**; today it is the stack's own `OpsAlertsTopic`, so subscribe your ops
  channel/email to the `OpsAlertsTopicArn` output. There is no CloudWatch
  **dashboard** yet (#29), also **[Decided r2 — not yet built]**.
- **The send DLQ.** `SendDlqUrl` is where poison send descriptors land, and
  `SendDlqNotEmptyAlarm` is what tells you. Drain it deliberately; nothing
  redrives it for you.
- **Suppression.** Bounces and complaints auto-suppress; admins can also suppress
  manually. Suppression is enforced at send time.
- **Audit trail.** Sensitive actions are written to the WORM (S3 Object Lock)
  audit bucket named by `AuditBucketName`, with a default retention of
  `auditRetentionYears` (7 → 2555 days) and a RETAIN removal policy.
  The intended mode is **GOVERNANCE** (#9): a privileged principal can still
  remove an object with `s3:BypassGovernanceRetention`, so a mistake — a bad
  retention setting, a test run, an object written by accident — is recoverable.
  COMPLIANCE cannot be undone by anyone, including AWS. **[Decided r2 — not yet
  built]:** what deploys today is **COMPLIANCE** with a 2555-day default
  retention. Every object the audit trail writes is genuinely immutable for seven
  years, and the bucket cannot be emptied or deleted until the last one expires.
  Set `auditRetentionYears` deliberately before the first deploy.
- **Logs.** 20 log groups, one per application handler, retention 90 days when
  `stage` is exactly `"prod"` and **7 days otherwise**. The test is literal string
  equality, so a `staging` or `prod-eu` stage silently gets 7-day retention.
- **Usage & cost.** Per-org usage is metered and cost is estimated from configurable
  rates (see `packages/domain/src/usage.ts`).

> **Campaign send counts read zero.** Hot counters are never incremented —
> transactional event+counter writes are #57, **[Decided r2 — not yet built]** —
> so the console's campaign list and the usage rollup that sums it both report 0
> sent. Campaign *reports* are correct: they fold the full event list on every
> read.

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
