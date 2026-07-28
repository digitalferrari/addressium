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

## Usage

```bash
# Account owner, once, with admin credentials:
./scripts/aws-bootstrap.sh \
  --admin-email you@example.com \
  --domain mail.example.com

# See what it would do without touching anything:
./scripts/aws-bootstrap.sh --admin-email you@example.com --dry-run
```

Then hand over the credentials it prints, and the deployer runs:

```bash
npm run build && npm run deploy
```

Teardown (non-prod only — `prod` is refused by design):

```bash
./scripts/aws-teardown.sh --stage dev --region us-east-1
```

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
   ever do, and explicitly denies IAM user/key creation, Organizations, and
   billing.

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

Do **not** request production access for a test account.

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
