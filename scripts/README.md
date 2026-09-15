# Deployment scripts

## The problem these solve

Deploying addressium requires creating IAM roles, a Cognito pool, KMS keys and
SES identities. The naive answer is "give the deployer administrator access" —
which is exactly what you should not have to do to run someone else's software
in your own AWS account.

`aws-bootstrap.sh` is run **once, by the account owner, with admin credentials**.
It creates a deploy identity that can deploy and operate addressium and nothing
else. That identity is what a CI pipeline, a teammate, or an automated agent
gets. Admin credentials never leave the account owner's hands.

This is the same path whether you're setting up a throwaway test account or a
production install.

## Two ways to bootstrap

### Recommended: the CloudFormation stack

`infra/bootstrap/addressium-bootstrap.yaml` — deploy it from the console or the
CLI. No local tooling required beyond a browser.

```bash
aws cloudformation deploy \
  --template-file infra/bootstrap/addressium-bootstrap.yaml \
  --stack-name addressium-dev-bootstrap \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AdminEmail=you@example.com Stage=dev
```

Prefer this because it is **state**, not a one-shot action. When a later release
needs a new permission, that is a stack *update* — with a diff, a rollback, and a
clean uninstall. A script can only create and hope.

Then finish the one step CloudFormation can't do (it is itself a stack):

```bash
npx cdk bootstrap aws://<account>/<region> \
  --custom-permissions-boundary addressium-dev-boundary
```

### Alternative: the shell script

`aws-bootstrap.sh` does the same work plus the SES identity and inbound-mail
setup, which the template deliberately leaves out (they are per-domain and
change independently of IAM). Use it when you want the whole test environment in
one command:

```bash
./scripts/aws-bootstrap.sh --admin-email you@example.com --domain mail.example.com
./scripts/aws-bootstrap.sh --admin-email you@example.com --dry-run   # preview
```

Its limitation is the point made above: it has no state, so re-running after the
script itself changes is convergence-by-hope. Treat it as a convenience for
disposable test accounts, and the template as the real install path.

Then hand over the credentials it prints, and the deployer runs:

```bash
npm run build && npm run deploy   # CDK stack only — see below
ADDRESSIUM_PUBLIC_ORG_ID=<your-org-id> node scripts/publish-spas.mjs
```

`npm run deploy` is `deploy:check && cdk deploy`. It does **not** publish the
SPAs — `publish-spas.mjs` is wired only into CI — so without that second command
the admin console, subscriber site and signup page stay on the previous build
while the API moves forward.

Teardown (non-prod only — `prod` is refused by design):

```bash
./scripts/aws-teardown.sh --stage dev --region us-east-1
```

## On storing deploy credentials in Secrets Manager

A natural idea that cannot work: **reading Secrets Manager requires AWS
credentials**, so storing AWS credentials there is circular. And anyone running
`cdk deploy` from their own CLI is already authenticated, so there is nothing to
fetch.

Secrets Manager is the right home for *application* secrets — the reCAPTCHA key,
the webhook signing secret — which is exactly how the app
already uses it: passed by ARN, resolved at cold start, never in the template.
That is a different problem from authentication.

The deployment answer is no static secret at all: assume a role, get credentials
that expire.

## How the scoping actually works

The useful insight is that **CDK already solves this**, so there's no giant
hand-written policy to maintain and get wrong.

`cdk bootstrap` creates four roles — deploy, file-publishing, image-publishing,
lookup — plus a CloudFormation execution role. The deploy identity's policy is
then almost trivial: `sts:AssumeRole` on exactly those four ARNs, read the
bootstrap version parameter, and read-only access for running the smoke suite.
It cannot create IAM principals, touch other stacks, or read unrelated data.

Three layers hold:

1. **The deploy identity** can only assume CDK's roles.
2. **CDK's roles** only act on stacks carrying the bootstrap qualifier.
3. **The permissions boundary** caps what any role the deployment creates can
   ever do. It denies IAM user/key creation, Organizations and billing — but a
   deny-list is only half of what it is, and reading it as the whole is the
   mistake that broke the first real deploy. See below.

### The honest caveat

Layer 3 is the one that matters, and it's worth being explicit about why. Anything
that can `cdk deploy` this stack can create IAM roles, and creating IAM roles is
privilege escalation to administrator unless something constrains it. Without a
permissions boundary, a "scoped" deploy identity is theatre. That's why
`--custom-permissions-boundary` is passed to `cdk bootstrap` rather than left off.

The CloudFormation execution role does get `AdministratorAccess`. That is the
documented CDK default and is defensible here because it is assumed **only by
CloudFormation**, never by a human or an agent, and what it can do is bounded by
what the template declares plus the boundary above. If you want it tighter, pass
your own policy ARN — the script takes it as a one-line change.

### A boundary is an intersection, not a deny-list

This is the single thing most likely to be got wrong when editing
`infra/bootstrap/addressium-bootstrap.yaml`, and it cost the first real deploy
several failures before the shape of the mistake was clear.

`cfn-exec-role` holds `AdministratorAccess` **capped by this boundary**. A
permissions boundary is an *intersection*: the effective permission is what the
identity policy allows **and** what the boundary allows. So "administrator"
means nothing outside the boundary — if an action is absent from the boundary,
the execution role cannot perform it, no matter what `AdministratorAccess` says.

The boundary had been written as an application-**runtime** allow-list — the
things a Lambda needs at request time. That is the wrong frame. It also has to
allow everything **deployment** needs, which is a different and larger set:

- **`sts:AssumeRole`** — without it the deploy identity cannot assume the CDK
  roles at all, which is the first thing `cdk deploy` does.
- **`ssm:GetParameters`** — plural. `ssm:GetParameter` and `ssm:GetParameters`
  are **different IAM actions**, and CloudFormation resolves the
  `BootstrapVersion` parameter (typed `AWS::SSM::Parameter::Value<String>`)
  through the **batch** API. Granting only the singular form fails in a way that
  reads as a bootstrap-version problem.
- **`events:*`** — the stack creates EventBridge rules.
- **IAM role lifecycle** — the stack synthesizes 31 roles, one execution role per
  Lambda. That is the least-privilege payoff, not bloat, and it means the
  deployment genuinely must create IAM roles.

That last one is granted as a **conditioned `iam:CreateRole`**: permitted only
when the new role carries this same boundary. The deployer therefore cannot mint
itself a role stronger than itself, which is the property that makes granting
role creation acceptable at all. `infra/cdk/bin/addressium.ts` sets the
`@aws-cdk/core:permissionsBoundary` context app-wide so every synthesized role
satisfies the condition, and `deploy:check` refuses to deploy if any role
synthesizes without it. **Do not remove either half.** Dropping the app-level
context makes every role fail the condition; dropping the condition to "simplify"
the boundary turns role creation back into unconstrained privilege escalation.

One superseded control worth not reinstating: an earlier boundary carried a
`Deny` on `iam:PutRolePermissionsBoundary`, intended to stop a role escaping its
cap. It never did that — a boundary rides along with `CreateRole` as a parameter,
so it was never set by that call. What the Deny actually blocked was
CloudFormation's *update* path, **including rollbacks**.

## Testing safety: SES sandbox is a feature

The script deliberately leaves the account in **SES sandbox**. In sandbox, AWS
itself refuses to deliver to any address that isn't verified. Verify only your
own address and it becomes structurally impossible to email a stranger — a
stronger guarantee than any application-level allowlist, and free.

Pair it with the application's own fail-closed dev allowlist by creating the test
org with `environment: "dev"` and `devAllowlist: ["you@example.com"]`. Two
independent layers; a bug in either is still contained.

For bounce and complaint handling, use SES's simulator addresses
(`bounce@simulator.amazonses.com`, `complaint@simulator.amazonses.com`). They
work in sandbox, cost nothing, and don't touch your sending reputation.

Do **not** request production access for a test account. This is enforced, not
just advised: `npm run test:e2e` calls `GetAccount` and **aborts** on any account
that holds production access. There is no override, so granting it to an account
retires that account from the smoke suite permanently — keep the sandboxed smoke
account and the account you actually send from separate.

## Inbound mail

With `--domain`, the script provisions an SES receipt rule that writes raw MIME
to S3. That's deliberately not a third-party mailbox: no extra vendor, no extra
credential, and the full headers survive — which matters because
`List-Unsubscribe` / `List-Unsubscribe-Post` correctness is one of the things the
end-to-end suite needs to assert.

You'll need to add the printed MX record. Inbound receipt rules only exist in
`us-east-1`, `us-west-2` and `eu-west-1`.

## Cost

Under **$2/month** at test volume, plus the domain (~$12–15/yr). The script sets
a $10 budget alarm before creating anything else.

Leave `enableOpenSearchMirror` and `enableAnalytics` off unless you're
specifically testing them — both carry standing cost well above the rest of the
stack combined.
