# Deploying & operating addressium

This guide takes you from an empty AWS account to a running deployment with one
or more publisher organizations. addressium runs entirely in **your** account;
there is no addressium-hosted control plane.

- [Architecture & Design](ARCHITECTURE.md) — the canonical system design.
- [Security Design & Threat Model](SECURITY.md) — STRIDE model + standards.

---

## 1. Prerequisites

- **Node 20+** and npm (the repo is an npm-workspaces monorepo).
- **An AWS account** and credentials in your shell (`aws sts get-caller-identity`
  should succeed). The deployer needs permission to create DynamoDB, Lambda, SES,
  KMS, Cognito, API Gateway, SQS, SNS, EventBridge, S3, CloudFront, WAF, Secrets
  Manager and IAM resources.
- **A CDK bootstrap** in the target account/region (one-time):
  ```bash
  npx cdk bootstrap aws://<account-id>/<region>
  ```
- **A sending domain** you control DNS for (needed to verify SES and pass
  DKIM/SPF/DMARC). SES starts in *sandbox* mode — request production access when
  you are ready to send to unverified recipients.

## 2. Build

```bash
npm install        # all workspaces
npm run build      # tsc -b across packages/services/apps/infra
npm test           # unit + DynamoDB integration tests (no AWS creds needed)
```

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
| `enableOpenSearchMirror` | off | When `true`, provisions the opt-in OpenSearch Serverless mirror fed by DynamoDB Streams (segment search at scale). Off keeps costs at zero. |
| `auditRetentionYears` | `7` | WORM retention (S3 Object Lock) on the tamper-evident audit bucket. |
| `confirmUrlBase` | derived | Base URL used in double-opt-in confirmation links. Set this to your subscriber site's origin. |

## 4. Deploy

```bash
cd infra/cdk
npm run deploy         # cdk deploy --all
```

Note the stack **outputs** — the HTTP API base URL, the admin Cognito pool/domain,
and the S3/CloudFront targets for the SPAs. You will need the API base and Cognito
values to configure the web apps.

## 5. Build & publish the web apps

Three React SPAs live under `apps/`. Each reads its config from Vite env vars at
build time:

| App | Purpose | Key env vars |
| --- | --- | --- |
| `apps/admin-web` | Operator console | `VITE_API_BASE`, `VITE_COGNITO_*` (Hosted-UI PKCE) |
| `apps/subscriber-web` | Directory / confirm / preference center | `VITE_API_BASE`, `VITE_ORG_ID`, optional `VITE_COGNITO_*` |
| `apps/public-web` | Standalone + embeddable signup | `VITE_API_BASE`, `VITE_ORG_ID` |

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
2. **Add organization.** This calls `services/provisioning`, which creates the
   org's **subscriber Cognito pool, KMS ES256 signing key, JWKS, SES identity and
   configuration set** at runtime (nothing per-org lives in CloudFormation).
3. Add the org's sending domain and publish the **DKIM/SPF/DMARC** DNS records the
   provisioning step returns. Wait for SES verification to go green.
4. Create lists, and you're ready to collect signups (double opt-in) and send.

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

### LLM-assisted analytics

To enable AI performance analysis of a campaign:

1. Create a secret holding your provider API key:
   ```bash
   aws secretsmanager create-secret \
     --name addressium/<org>/llm-key --secret-string 'sk-...'
   ```
2. In the admin console (**Configure → AI**), pick the vendor
   (`anthropic` / `openai` / `gemini`), the model, and the secret ARN. This is
   stored on the org's `aiConfig`; the key itself never leaves Secrets Manager.
3. Run **Analyze** on a campaign report. Only **aggregates** (counts, rates,
   editorial link labels) are sent — subscriber emails and IDs are never
   transmitted, and the outbound prompt is scrubbed of anything email-shaped.

The advisor retries transient provider failures (429/5xx, timeouts) with bounded
exponential backoff and an overall deadline, so a provider hiccup degrades to a
surfaced error rather than a hung request.

---

## 8. Day-2 operations

- **Deliverability alerts.** Bounce/complaint-rate breaches publish to SNS and can
  halt a running campaign. Subscribe your ops channel/email to the alert topic.
- **Suppression.** Bounces and complaints auto-suppress; admins can also suppress
  manually. Suppression is enforced at send time.
- **Audit trail.** Sensitive actions are written to the WORM (S3 Object Lock)
  audit bucket; retention is `auditRetentionYears`.
- **Usage & cost.** Per-org usage is metered and cost is estimated from configurable
  rates (see `packages/domain/src/usage.ts`).

## 9. Updating & tearing down

```bash
cd infra/cdk
npm run diff           # preview changes
npm run deploy         # roll forward
npx cdk destroy --all  # tear the deployment down
```

> Destroying the stack removes the control plane. Per-org data in DynamoDB and any
> retained (WORM) audit objects are governed by their own removal/retention
> policies — review them before destroying a production deployment.
