# Deploying & operating addressium

This guide takes you from an empty AWS account to a running deployment with one
or more publisher organizations. addressium runs entirely in **your** account;
there is no addressium-hosted control plane.

> ### ⚠️ Status: run against a dev account; last rolled forward 2026-09-15
> §1–§6 have now been walked end to end against a real AWS account (#212), and
> the corrections that run produced are folded in below — the boundary
> permissions, the Hosted-UI domain, the SPA publish step, and a confirmed mail
> delivery to a controlled inbox. §7 onward is still written against the source
> and the synthesized template rather than against something that happened. That
> run surfaced ten bugs no test could see; expect the sections it did not reach
> to hold more.
> Read [Status](../README.md#status) before you point this at a domain you care
> about.

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
  you are ready to send to unverified recipients, but note that doing so
  permanently disqualifies that account from `npm run test:e2e`, which aborts on
  any account holding production access (§11). Keep the smoke account and the
  sending account separate.

### The one-time account bootstrap

**Once, by the account owner, with admin credentials:**

```bash
aws cloudformation deploy \
  --template-file infra/bootstrap/addressium-bootstrap.yaml \
  --stack-name addressium-dev-bootstrap \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AdminEmail=you@example.com Stage=dev \
    GitHubRepo=<owner>/<repo>

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

`GitHubRepo` is optional and creates the **CI deploy path**: an
`AWS::IAM::OIDCProvider` for `token.actions.githubusercontent.com` plus an
`addressium-<stage>-ci-deployer` role whose trust policy is restricted to
`repo:<owner>/<repo>:ref:refs/tags/v*` — tag builds only, so no branch or pull
request run can assume it. The stack prints the role as the `CiDeployRoleArn`
output; set it as the `DEPLOY_ROLE_ARN` repository variable:

```bash
gh variable set DEPLOY_ROLE_ARN --repo <owner>/<repo> --body <CiDeployRoleArn>
```

The tagged release workflow (`.github/workflows/ci.yml`) then deploys with **no
long-lived AWS key stored in GitHub** — it exchanges a short-lived, GitHub-signed
token for temporary STS credentials. Only one OIDC provider per URL per account
is allowed, so pass `GitHubOidcProviderArn` instead of creating a second one if
that provider already exists. Leave `GitHubRepo` blank and no CI role is created.

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
npm test           # the full suite; no AWS creds needed (4 conditional skips)
npm run test:web   # component tests for the three SPAs
```

`npm test` runs in-memory and against a DynamoDB-compatible API (dynalite — no
Java or Docker). Tests that require transaction or AWS-service semantics skip
when LocalStack is unavailable. Bring up `docker-compose.localstack.yml` first
to exercise native `TransactWriteItems`, SQS, KMS, and EventBridge Scheduler;
CI does this on every run.

> **The CDK tests are slow on purpose, and the obvious fix does not work.**
> Roughly 8.5 seconds per test across 77 of them. The cause is `nodeModules:
> ["@cedar-policy/cedar-wasm"]` on the bundled functions (§4 — it is what keeps
> the handlers loadable at all): CDK runs an `npm install` per function at
> **construct** time, so it happens while the test builds the stack, before any
> assertion. `aws:cdk:bundling-stacks: []` does **not** skip it — that context
> key gates asset bundling, and this install is not asset bundling. Budget the
> wall-clock rather than trying to tune it away.

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
| `adminHostedUiDomainPrefix` | Prefix for the admin Cognito Hosted-UI domain. The stack appends `-<stage>`, so the domain is `<prefix>-<stage>`, and it is that full string that must be globally unique in the region — see §4. |
| `adminFromEmail` | **Optional.** FROM address for admin invites and password resets, which switches the admin pool from Cognito's built-in sender to **SES**. Its domain must already be a verified SES identity in this region or the deploy fails at stack-update time. See below. |

### `adminFromEmail`, and why it is optional

Leave it empty on a first deploy, verify a domain, then set it and deploy again.
It has to be optional because of bootstrapping order: the admin pool must stand
up on a fresh account where nothing is verified yet, so requiring an identity
would make the very first deploy impossible.

Empty keeps Cognito's default sender, which is a poor fit for the one email that
gates console access: **50 emails per day account-wide**, sent from a shared
`amazonses.com` address whose reputation belongs to nobody, and **no bounce, no
metric and no log of any kind**. The failure mode is the expensive one — the
first invite this stack ever sent never arrived, and nothing anywhere could say
whether it was delivered, filtered or dropped. An invite that was never sent
looks exactly the same as one that vanished. If you are about to hand invites to
a team, set this first.

Deliberately **not** paired with `sesVerifiedDomain`: Cognito derives the
identity from the address itself, so naming a domain that is verified in another
region — or not at all — only adds a way to fail an update for no benefit.

### Optional CDK context flags

Pass with `-c key=value` on `cdk deploy`, or add to `cdk.json` → `context`:

| Context key | Default | Effect |
| --- | --- | --- |
| `enableAnalytics` | **off** | When `true`, adds the deferred analytics tier: a Kinesis stream off the DynamoDB table, Firehose → S3, a Glue database + two tables (`events` and `entities`, #199), and an Athena workgroup, plus the export/snapshot/replay Lambdas. Off by default (#64); the core design does not depend on it. |
| `enableOpenSearchMirror` | **off** | When `true`, provisions the OpenSearch Serverless mirror fed by DynamoDB Streams (segment search at scale). Off by default (#64). |
| `auditRetentionYears` | `7` | Object Lock default retention on the audit bucket, in years (7 → 2555 days). See §9. |
| `confirmUrlBase` | **none — required** | Base URL used in double-opt-in confirmation links. Set it to your public distribution's origin plus `/confirm`, where `subscriber-web` serves that route. There is deliberately no default: it used to fall back to `https://your-site.example/confirm`, which put a dead link in every confirmation email while signup returned 200 and the mail sent. The stack now refuses to synthesize without it (#294). |
| `preferencesUrlBase` | **none — required** | Base URL used in subscription-management emails. Set it to the subscriber distribution's `/preferences` route so the emailed management link opens the SPA page. Same story as `confirmUrlBase`, on the surface subscribers use to leave — and it was the one that had never been set at all. |
| `sesMaxSendRate` | `14` | Your account's SES send rate in messages/second (a fresh production account gets 14) — set it to your real quota. Everything that sends divides this down rather than each taking it whole, so the aggregate stays inside the limit (#176). |
| `senderMaxConcurrency` | `5` | How many sender Lambdas may run at once. Sets the SQS event source's cap *and* the divisor the sender applies to `sesMaxSendRate`, from one value — the two drifting apart is worse than neither, because it looks configured. |

> **Leave the two analytics flags off unless you are specifically testing them.**
> They are opt-in, off by default, and demoted out of the core design by #64 —
> not removed. Both carry standing cost well above the rest of the stack
> combined. The exact counts are not quoted here — they were stale the last time
> someone did. Synth both ways and compare: the default deploy, then
> `-c enableAnalytics=true -c enableOpenSearchMirror=true`, which is
> substantially larger and emits three more stack outputs
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

> **An email subscription must be confirmed, or it silently disappears.** With
> `opsAlertEmail`, SNS sends that address a confirmation mail. Until someone
> clicks the link the subscription is `PendingConfirmation` — and **SNS deletes
> an unconfirmed subscription after three days**. CloudFormation is not told: the
> stack still reports the resource `CREATE_COMPLETE`, so a later `cdk deploy`
> finds nothing to change and the topic goes on paging nobody. This is not
> hypothetical — it happened to this project's first deployment, and the
> earlier `deploy:check` printed a reassuring `✓` throughout, because it read
> the *config file* instead of the topic. It now reads the live subscription
> counts and reports `✗ the ops topic has NO confirmed subscribers` instead.
> Email is also the weakest on-call channel; prefer `opsAlertTopicArn` pointing
> at a topic with confirmed subscribers you manage.

## 4. Deploy

Deploy from the **repo root**, not from `infra/cdk`, and **as the scoped deploy
identity — never as the account root**:

```bash
export AWS_PROFILE=addressium-deploy   # a profile that assumes addressium-<stage>-deployer

# Infrastructure AND all three SPAs. The gate runs first — an && chain, not a
# hook — then CloudFormation, then the bundles.
ADDRESSIUM_PUBLIC_ORG_ID=<your-org-id> npm run deploy

# The halves are separately runnable when you want just one:
#   npm run deploy:infra   # gate + CloudFormation
#   npm run deploy:spas    # rebuild and publish the three SPAs
```

> **Root deploys are refused.** `deploy-check.sh` calls `sts:get-caller-identity`
> and exits non-zero when the caller is the account root (`…:root`). Root has no
> attributable deploy identity and no ceiling on blast radius, and on a machine
> whose ambient credentials *are* root it is the path of least resistance — which
> is why it takes a gate rather than an intention. Configure a profile that
> assumes `addressium-<stage>-deployer`; the bootstrap stack prints the ARN and an
> `AssumeCommand` output, and `~/.aws/config` needs only `role_arn` plus a
> `source_profile`.

> **`confirmUrlBase` and `preferencesUrlBase` are REQUIRED** (#294). They are
> the links addressium mails subscribers, and the stack now **refuses to
> synthesize** without them. Set them in `infra/cdk/addressium.config.json`:
>
> ```json
> "confirmUrlBase": "https://<your-public-distribution>/confirm",
> "preferencesUrlBase": "https://<your-public-distribution>/preferences"
> ```
>
> They used to default to `https://your-site.example/...`, a domain nobody owns,
> and were readable only from `cdk` context — so they had to be passed as `-c`
> on *every* deploy, and forgetting once silently reverted a working stack:
> signup returned 200, the mail sent, every link in it was dead, and no alarm,
> log or exit code said so. There is now no default, and `npm run deploy` also
> refuses on a placeholder value before it ships anything.
>
> `-c confirmUrlBase=…` still overrides the file for a one-off deploy, but note
> **`npm run deploy -- -c key=val` does not reach `cdk`**: npm consumes `-c` at
> the nested workspace invocation. Use a direct `npx cdk deploy` for that.
>
> Do **not** hardcode either into the tracked `infra/cdk/cdk.json`: that file
> ships to everyone, and a real hostname there is worse than the placeholder —
> it silently routes other operators' confirmation tokens to your
> distribution.

> **`npm run deploy` is now the whole deploy** (#294). It used to be
> `deploy:check && cdk deploy`, with `scripts/publish-spas.mjs` referenced only
> from `.github/workflows/ci.yml` — so outside CI nothing published the SPAs.
> A deploy moved the API forward while the operator console, subscriber site and
> signup page stayed on the previously uploaded build: complete success
> reported, nothing visible changed. Since a frontend change is the common case,
> that failure mode fired more often than not.
>
> `deploy` is now `deploy:infra && deploy:spas`. `publish-spas.mjs` rebuilds
> each SPA from source before syncing, so a stale `dist/` cannot be published
> either. It needs `ADDRESSIUM_PUBLIC_ORG_ID`, and fails loudly without it
> rather than publishing a mis-configured bundle.

`deploy:infra` invokes `deploy:check` directly (`deploy:check && cdk deploy`),
and `deploy` runs `deploy:infra` first, so `scripts/deploy-check.sh` always runs
before anything reaches CloudFormation. It creates a CloudFormation **change
set without executing it**, inspects it, and exits non-zero — aborting the deploy
— if any data-holding resource would be **replaced or removed**:

```
✗ REFUSING: this change would destroy or replace data-holding resources
  Modify  replace=True  AWS::DynamoDB::Table  TableCD117FA1
     cause: Properties.KeySchema (RequiresRecreation=Always)
```

**Why it runs unconditionally:** `RemovalPolicy.RETAIN` governs stack *deletion*, not
resource *replacement*. Change a partition key and CloudFormation creates a new,
empty table and orphans the old one — nothing is "deleted", RETAIN is satisfied,
and every subscriber vanishes from the application's view. Only a pre-flight
change-set inspection catches that. `cd infra/cdk && npm run deploy` calls `cdk`
directly and runs no checks at all; don't.

> This was previously an npm `predeploy` lifecycle hook, and it never ran for
> anyone with `ignore-scripts=true` in their npm config — a common hardening
> setting, and the default under some CI runners and package managers. npm
> reports nothing when it skips a lifecycle hook, so the deploy looked clean
> while the guard was silently absent. On the account that deployed this first,
> `ignore-scripts` was set, which means the data-protection guard **had never
> once executed** despite the docs claiming it could not be skipped. A `&&` chain
> in the script body cannot be disabled by configuration. Don't move it back into
> a hook, and don't trust a guard whose only enforcement is a lifecycle event.

It also refuses to deploy if any IAM role synthesizes **without the permissions
boundary** (§11). That is not a style check: the bootstrap boundary grants
`iam:CreateRole` only when the new role carries the boundary, so an unbounded
role means CloudFormation is denied partway through and leaves a stack to roll
back. `bin/addressium.ts` sets the `@aws-cdk/core:permissionsBoundary` context
app-wide so all 31 synthesized roles satisfy that condition — one execution role
per Lambda, which is the least-privilege payoff rather than bloat. Do not remove
that app-level context to "clean up"; the condition on `iam:CreateRole` is what
stops a deployer minting itself something stronger than itself, and without the
context every role fails it.

> `deploy:check` has now run against real CloudFormation on both a **create** and
> an **update** (2026-09-15), but neither had a data-holding resource to replace
> — the update's change set reported none. The replacement
> path it exists for is still validated against fixtures alone. It is the only
> preflight that exists — there is no `doctor` command. It also warns when no WAF
> association or alert target is configured (§3), before it inspects anything
> else.

### When a create fails

A `CREATE_FAILED` leaves the stack in **`ROLLBACK_COMPLETE`**, which
CloudFormation cannot update. You must **delete the stack** before retrying —
`npm run deploy` against it fails with a state error, not a useful one.

Deleting is not the end of it. Every `RemovalPolicy.RETAIN` resource reports
`DELETE_SKIPPED` and is **orphaned**, still present and still billing. On the
first real attempt that meant a surviving admin Cognito pool, a KMS key, S3
buckets and secrets. Two of those bite on the retry rather than later: the
Hosted-UI domain is globally unique, so an orphaned pool holding
`<prefix>-<stage>` makes the next create fail on a name collision, and orphaned
secrets sit in a 7-to-30-day deletion window under the same name.

**Sweep between attempts.** Find the survivors by name — they all carry the
`addressium-<stage>` prefix — and delete them deliberately, scheduling secrets
with `--force-delete-without-recovery` if you intend to reuse the name
immediately. The stack events list them: filter for `DELETE_SKIPPED`.

### After the deploy succeeds, invoke something

`CREATE_COMPLETE` is **not** evidence that any code runs. The first real deploy
reached `CREATE_COMPLETE` with all 29 handlers unable to load — a bundling
failure is invisible to CloudFormation, which only ever saw a zip file of the
correct shape. `curl $HttpApiUrl/version` is the cheapest check that the runtime
is real; a module-load failure shows up in the function's log group as an
`ERROR Runtime.ImportModuleError` on the very first invocation.

> **Three bundling settings that look like cruft and are not. Do not "clean up"
> any of them** — each one was the fix for a defect that produced a green deploy
> and a dead stack.
>
> 1. **`nodeModules: ["@cedar-policy/cedar-wasm"]`.** The package is a wasm-pack
>    `nodejs` build: it locates its `.wasm` sidecar through `__dirname`, which
>    esbuild cannot inline, so bundling it produces JavaScript that cannot find
>    its own binary. Shipping it as a real `node_modules` entry is the fix. A
>    `banner` shim defining `__dirname` is **not** — that makes the path resolve
>    and then fail `ENOENT`, which is a longer road to the same dead handler.
> 2. **The `createRequire(import.meta.url)` `banner`.** Once cedar loaded, the
>    AWS SDK's `@smithy/util-buffer-from` hit esbuild's ESM `require` stub and
>    threw `Dynamic require of "buffer" is not supported`. This bug was
>    **invisible until the first was fixed**, because nothing got far enough to
>    reach it. Removing either fix re-exposes the other.
> 3. **`@cedar-policy/cedar-wasm` in all 12 `services/*/package.json`, including
>    the 4 that do not use RBAC.** This looks like an obvious tidy-up and is not.
>    `nodeModules` resolves a version by walking **up** from the handler *entry*
>    file (a `findUp` for `package.json`), so the file it reads is
>    `services/<name>/package.json` — **not** `infra/cdk`'s and **not** the root's.
>    A service that omits the dependency gives CDK nothing to resolve and breaks
>    `cdk synth`. Removing it from the four non-RBAC services has already cost 18
>    test failures once.
>
> The same construct-time `npm install` these cause is why the CDK tests are slow
> (§2). That cost is bought deliberately.

> **`AdminApiFn` uses `scopePermissionToRoute: false`, and that is also
> deliberate.** With per-route scoping, the shared admin function emitted one
> `AWS::Lambda::Permission` per route — 49 of them — which overflowed Lambda's
> hard **20,480-byte resource-policy limit** part-way through the create,
> failing the stack after most of it had been built. Turning it off emits one
> API-scoped permission instead (72 permissions across the stack became 24). It
> costs nothing in security here: all 54 admin routes share **one** function
> behind **one** JWT authorizer, so per-route source ARNs never separated
> anything. Authorization is the authorizer plus the handler's own Cedar RBAC,
> and it always was.

### Stack outputs you will need

18 outputs are emitted in a default deploy — 17 when you supply
`opsAlertTopicArn` (the `OpsAlertsTopicArn` output is then omitted, §3) — 21
with both analytics flags on, plus `BackupVaultName` in prod:

| Output | Use |
| --- | --- |
| `HttpApiUrl` | `VITE_API_BASE` for all three SPAs (§5). A URL, not an ARN. |
| `AdminPoolId` / `AdminClientId` | `VITE_COGNITO_*` for the admin console. |
| `AdminSiteBucket` / `PublicSiteBucket` | `npm run deploy:spas` (`scripts/publish-spas.mjs`) syncs the built SPAs into these; `npm run deploy` runs it after the stack (§5). `PublicSiteBucket` holds **two** apps at different prefixes; see §5 before syncing it by hand. |
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

The Hosted-UI **domain** is not an output, and it is **not** the
`adminHostedUiDomainPrefix` you set in §3. The stack appends the stage
(`control-plane-stack.ts`, `domainPrefix: \`${prefix}-${stage}\``), so the URL
you actually sign in at is:

```
https://<adminHostedUiDomainPrefix>-<stage>.auth.<region>.amazoncognito.com
```

With the example config's `addressium-admin` on `dev`, that is
`addressium-admin-dev.auth.us-east-1.amazoncognito.com`. Going to the un-suffixed
name gets you a Cognito error page that does not say why, which is a poor first
impression of your own deployment. The suffix is also why the *full* string, not
the prefix, is what has to be globally unique in the region.

> **Custom domains are staged, not required for dev proof.** Add
> `adminCustomDomain: { "domainName": "console.example.com" }` and/or
> `publicCustomDomain: { "domainName": "news.example.com" }` to the bootstrap
> config when the final hostnames are known, and deploy that stack in
> `us-east-1`. ACM requests DNS validation but Addressium does not own or change
> DNS: copy the ACM validation CNAME (from `AdminCertificateArn` or
> `PublicCertificateArn`) into Cloudflare, then point each hostname at its
> corresponding `*CloudFrontTarget` output. `HttpApiUrl` remains the generated
> API target until an API custom domain is separately chosen. The staged origins
> are used for Cognito callback/CORS and SPA builds; generated AWS hosts remain
> the correct dev default.

## 5. Build & publish the web apps

Three React SPAs live under `apps/`. Each reads its config from Vite env vars at
build time:

| App | Purpose | Key env vars |
| --- | --- | --- |
| `apps/admin-web` | Operator console | `VITE_API_BASE`, `VITE_COGNITO_*` (Hosted-UI PKCE) |
| `apps/subscriber-web` | Directory / preferences / confirm / unsubscribe | `VITE_API_BASE`, `VITE_ORG_ID` |
| `apps/public-web` | Standalone + embeddable signup | `VITE_API_BASE`, `VITE_ORG_ID` |

> **The subscriber site has no login, and r2 does not call for one.** Its five
> routes are directory, subscribe-to-all, preferences, confirm and unsubscribe, all reached
> with a signed token or no auth at all — it reads no `VITE_COGNITO_*` and sends
> no `Authorization` header. A subscriber pool belongs to the org, not to
> addressium, and the addressium subscriber record is the primary identity (§6).
> The token-based **preference-centre** is built (#74 —
> `POST /preferences/request`, `GET`/`POST /preferences`); its management page
> is `/preferences` in the subscriber SPA.

`npm run deploy:spas` (`scripts/publish-spas.mjs`) builds and publishes all
three SPAs from the deployed stack outputs. `npm run deploy` runs it after the
stack, and CI runs the same script as its own step. It requires
`ADDRESSIUM_PUBLIC_ORG_ID` and is also usable on its own from an operator
workstation. Prefer it over the manual route — the block below shows
the build/sync/invalidate **shape for `admin-web` only**, not an equivalent of
the script, which also builds and publishes `subscriber-web` and `public-web`
at their respective prefixes (see the `--exclude 'signup/*'` hazard below):

```bash
VITE_API_BASE="https://<api-id>.execute-api.<region>.amazonaws.com" \
VITE_COGNITO_POOL_ID="<AdminPoolId>" \
VITE_COGNITO_CLIENT_ID="<AdminClientId>" \
VITE_COGNITO_DOMAIN="<adminHostedUiDomainPrefix>-<stage>.auth.<region>.amazoncognito.com" \
  npm --workspace @addressium/admin-web run build

aws s3 sync apps/admin-web/dist "s3://<AdminSiteBucket>" --delete
aws cloudfront create-invalidation --distribution-id <AdminDistributionId> --paths '/*'
```

The env vars are read at **build** time, so changing one means rebuilding and
re-syncing — there is no runtime config file to edit in the bucket. The
invalidation matters because `index.html` is the file you will keep replacing.

> **Two SPAs share one bucket, and the split between them is deliberate.**
> `apps/subscriber-web` and `apps/public-web` both go into the single
> `PublicSiteBucket` (`control-plane-stack.ts`, the `PublicSite` construct),
> behind one distribution. They are kept apart by a Vite `base`:
>
> - **`subscriber-web` owns the root `/`** and sets no `base`. It has to: the
>   `/confirm` and `/unsubscribe` links in outgoing mail resolve there, and an
>   unsubscribe link that 404s is a CAN-SPAM problem, not a routing
>   inconvenience.
> - **`public-web` sets `base: "/signup/"`** and lives under that prefix,
>   `embed.js` included — so the embeddable widget is at
>   `https://<public-site>/signup/embed.js`, which is the URL operators paste.
>
> **Do not delete that `base`.** It reads as an arbitrary setting and is not:
> without it both apps build to `/`, and whichever `aws s3 sync` runs last
> silently replaces the other's `index.html`. There is no error from `sync` and
> no deploy failure, because nothing in the stack knows two apps were meant to
> land here. The moment it regresses, either the embed or every unsubscribe link
> in every email already sent stops working.
>
> The embed URL moved to `/signup/embed.js` from the root, which would break
> already-pasted embeds — it is safe only because there are currently zero of
> them. Once real operators have pasted a snippet, that path is frozen.
>
> **What the split does not fix: deep links under `/signup/`.** The distribution
> rewrites 404 → `/index.html` with a 200 for SPA routing
> (`infra/cdk/lib/static-site.ts`), and that rewrite is **root-only**. So a
> client-side route like `/signup/lists` that is not a real object falls back to
> the **root** `index.html` — subscriber-web's shell, not public-web's. Real
> files under the prefix (`/signup/`, `/signup/embed.js`, the hashed assets) are
> served correctly, which is why the embed and the signup entry point work. A
> second error-response mapping scoped to the prefix is what would close this;
> nothing implements one today.
>
> **The residual trap is `--delete`.** One bucket still holds both apps, so a
> `aws s3 sync --delete` scoped to the bucket **root** removes the other app's
> files even though their prefixes never collide. Scope each sync to its own
> prefix, or drop `--delete`:
>
> ```bash
> aws s3 sync apps/subscriber-web/dist "s3://<PublicSiteBucket>"         --delete \
>   --exclude 'signup/*'
> aws s3 sync apps/public-web/dist     "s3://<PublicSiteBucket>/signup"  --delete
> ```
>
> The automated publisher uses these exact scoped syncs, so no root-level
> `--delete` can remove the other public app.

The public site also ships `apps/public-web/public/embed.js` — a self-contained
widget operators paste into any page:

```html
<div data-addressium data-org="YOUR_ORG_ID" data-list="YOUR_LIST_ID"></div>
<script async src="https://your-public-site/signup/embed.js"></script>
```

The `/signup/` prefix is `public-web`'s Vite `base` (above), not decoration —
the widget is served from the same prefix as the rest of that app.

## 6. Sign in and provision your first organization

1. Open the admin console and sign in with a seeded `adminEmails` address (set a
   password from the Cognito invite; enable TOTP MFA). The sign-in URL is the
   Hosted-UI domain with the stage suffix — see §4, because the un-suffixed name
   is the single most likely thing to stop you here. If the invite never arrives
   and you left `adminFromEmail` empty, there is no bounce, log or metric to
   consult; that is the default sender's defining property (§3).
2. **Create the organization** from the console's **Add organization** screen
   (#226), which calls the authenticated `POST /orgs`. This runs
   `services/provisioning`, which creates the org's **SES identity and
   configuration set** — plus the **KMS ES256 signing key** when magic links are
   on — at runtime (nothing per-org lives in CloudFormation).
3. Add the org's sending domain and publish the **DKIM/SPF/DMARC** DNS records the
   provisioning step returns. Wait for SES verification to go green.

> **Get the sending domain right the first time — it cannot be edited.** There is
> **no update-org route** in the API and no edit screen in the console, and
> `services/provisioning` returns early on `alreadyExisted`, so re-submitting the
> same org with a corrected domain does nothing and reports success. A typo means
> creating a **new organization under a different name**, because the org id is
> slugified from the name and is therefore not free to change either. Read the
> domain back before you submit.
>
> This is deliberate, not a gap waiting on an edit button. The org id is stamped
> into the SES identity, the configuration set, the MAIL FROM subdomain, the DKIM
> records you publish in DNS, and every confirm and unsubscribe link already
> delivered to an inbox. Making it mutable would mean re-verifying SES, reissuing
> DKIM, and silently invalidating links that are, in the case of unsubscribe, a
> legal obligation to honour. An org is an identity, and identities are cheap to
> create and expensive to rewrite — so it is configured once, correctly.
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

> **The subscriber Cognito pool — needed only with magic links on.** This is the
> step most likely to stop a first deploy for no reason, so the condition first:
> with the magic-link checkbox **off**, no pool is required and none is asked
> for. addressium never contacts Cognito and sends plain email. Earlier wording
> here read as though a pool were always a prerequisite; it is not, and you do
> not need to stand one up to add your first organization.
>
> With magic links **on**, `POST /orgs` takes a `subscriberPool` of
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

**Confirm the subscription.** An email subscription stays `PendingConfirmation`
until someone clicks the link SNS mails, and SNS deletes it after three days —
silently, with the CloudFormation resource still reporting `CREATE_COMPLETE`
(§3). Verify from AWS rather than from the stack:

```bash
aws sns get-topic-attributes --topic-arn <OpsAlertsTopicArn> \
  --query 'Attributes.[SubscriptionsConfirmed,SubscriptionsPending]' --output text
# expect a non-zero first value, not "0 0"
```

`deploy:check` (§4) now performs this check for you and refuses to print a clean
bill of health when the topic has no confirmed subscribers. It also warns when
neither target is set, and likewise when the WAF ARNs are unset. There is still
no `doctor` command.

---

## 9. Day-2 operations

- **Deliverability alerts.** Bounce/complaint-rate breaches publish to the org's
  own `AlertConfig.snsTopicArn` — operator-supplied already, per org — and a
  `halt`-level breach flips the campaign to `halted` so the sender stops. Set
  that topic when you provision the org; with none set, nothing is published.
- **Infrastructure alarms.** Every handler's errors and throttles in a default
  synth (count from `cdk synth`, not from here): the send
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
- **Logs.** One group per application handler, retention 90 days in
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
ADDRESSIUM_PUBLIC_ORG_ID=<your-org-id> \
  npm run deploy                                 # stack (§4) then SPAs (§5)
curl $API/version                                # running vs deployed
```

> The deploy-time migration custom resource writes `SCHEMA#VERSION` only after
> ordered migrations complete. `GET /version` reports `inSync: true` when that
> marker matches the serving build. This ran for the first time on 2026-09-15:
> the dev stack now reports `inSync: true` with a `deployedAt` stamp.

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

This is the **operator's runbook** for standing up a disposable account and
walking the public journey in it. What the dev deployment proved — and the
defects that only a real AWS account surfaced — is recorded in
[`ARCHITECTURE.md` §13](./ARCHITECTURE.md#13-status-what-is-proven-and-what-is-not);
it is not restated here, because a status paragraph in a runbook goes stale
silently and the runbook is read at exactly the moment that matters.

The 1.0 gate is `npm run test:e2e` **passing**, and that suite has still never
been run. The deploy steps below have been walked and their corrections folded
into §1–§6; the broader sender, event, and mailbox-provider paths remain written
rather than observed. The deploy guard and the scoped policy have been exercised
by two real deploys (§4).

> **Budget for the second run.** The first cost ten bugs, none visible to
> `npm test` or `cdk synth`, because they fail only against real AWS APIs. Two
> classes are worth expecting again: **IAM boundary gaps**, which surface as a
> deploy denied partway through, and **bundling failures**, which are worse — the
> stack reaches `CREATE_COMPLETE` while every handler is dead on arrival. Both
> are fixed, but the lesson generalizes: after a successful deploy, **invoke the
> functions**. `CREATE_COMPLETE` is not evidence that any code runs. `GET
> /version` returning 200 is a cheap first check and catches exactly this.

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

   **This cuts both ways, and §1 does not warn you about it.** §1 tells you to
   request production access when you are ready to send to unverified
   recipients — do that, and the smoke suite will refuse to run on that account
   from then on. There is no override flag. If you want both, they have to be
   two accounts: the smoke suite belongs on a sandboxed throwaway, and the
   account you actually send from is a different one that has left the sandbox
   and will never run `test:e2e` again.
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

`us-east-1`. It matches the config default, is the region CloudFront requires
for ACM certificates, and avoids cross-region staging surprises. The smoke suite
does **not** require SES inbound receipt rules or an inbound S3 bucket: a
controlled, verified mailbox receives the actual messages and supplies its
confirmation/unsubscribe links to the runner.

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
export AWS_PROFILE=addressium-deploy   # the gate refuses the account root
ADDRESSIUM_PUBLIC_ORG_ID=<your-org-id> \
  npm run deploy      # gate, then CloudFormation, then all three SPAs
AWS_REGION=us-east-1 SMOKE_STACK=addressium-dev \
  SMOKE_RECIPIENT=addressium-test@identithing.com \
  SMOKE_ADMIN_TOKEN='<short-lived Cognito token>' npm run test:e2e
npm run teardown:aws  # NOT `cdk destroy` — see below
```

The runner pauses for the confirmation and unsubscribe links delivered to the
controlled mailbox. A non-interactive mailbox harness can instead set
`SMOKE_CONFIRM_URL` and `SMOKE_UNSUBSCRIBE_URL`; no inbound-S3 access or stored
admin credential is used.

> **Do not reach for `npx cdk destroy`, even in dev.** The DynamoDB table is
> `RemovalPolicy.RETAIN` **and** `deletionProtection: true` in *every* stage
> (#190) — a destroy fails on the table and orphans the audit bucket, the
> secrets and the admin pool, which are also RETAIN (§10).
> `scripts/aws-teardown.sh` walks the survivors deliberately: it refuses
> `prod`, prompts, and disables deletion protection first.

**Still outstanding, and now overdue** — two real deploys have run without it.
Rehearse `deploy:check` across three change
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
