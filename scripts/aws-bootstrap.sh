#!/usr/bin/env bash
#
# addressium — one-time AWS account bootstrap.
#
# Run this ONCE, with administrator credentials, in the account that will host
# addressium. It creates everything needed for someone (a CI pipeline, an agent,
# a teammate) to deploy and operate the stack WITHOUT ever holding admin
# credentials themselves.
#
# The deploy identity it creates cannot do arbitrary things in the account: it
# can only assume the CDK bootstrap roles, which in turn only act on stacks
# carrying the CDK qualifier. Everything those roles create is constrained by a
# permissions boundary this script installs.
#
#   ./scripts/aws-bootstrap.sh --admin-email you@example.com --domain mail.example.com
#
# Re-running is safe: every step is idempotent.
#
set -euo pipefail

# ---------------------------------------------------------------- defaults ---
STAGE="dev"
REGION="${AWS_REGION:-us-east-1}"
ADMIN_EMAIL=""
DOMAIN=""
BUDGET_USD="10"
PRINCIPAL="user"          # user | role
INBOUND="yes"             # provision SES inbound -> S3 (needed for E2E tests)
DRY_RUN="no"
# The default CDK qualifier. Changing it means also setting
# @aws-cdk/core:bootstrapQualifier in infra/cdk/cdk.json.
QUALIFIER="hnb659fds"
NAME_PREFIX="addressium"

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --admin-email <addr>   Console admin AND the only verified send recipient. Required.
  --domain <fqdn>        Sending domain for DKIM (e.g. mail.example.com). Optional
                         but required for a realistic deliverability test.
  --stage <name>         Deployment stage. Default: ${STAGE}
  --region <region>      Must support SES inbound: us-east-1|us-west-2|eu-west-1.
                         Default: ${REGION}
  --budget <usd>         Monthly budget alarm. Default: ${BUDGET_USD}
  --principal user|role  'user' issues long-lived keys (CI/agents).
                         'role' issues an assumable role (short-lived STS creds,
                         preferred where the consumer can assume roles).
                         Default: ${PRINCIPAL}
  --no-inbound           Skip the SES inbound receipt rule + S3 mailbox.
  --dry-run              Print what would happen; change nothing.
  -h, --help             This message.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --domain)      DOMAIN="$2"; shift 2 ;;
    --stage)       STAGE="$2"; shift 2 ;;
    --region)      REGION="$2"; shift 2 ;;
    --budget)      BUDGET_USD="$2"; shift 2 ;;
    --principal)   PRINCIPAL="$2"; shift 2 ;;
    --no-inbound)  INBOUND="no"; shift ;;
    --dry-run)     DRY_RUN="yes"; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
run()  { if [[ "$DRY_RUN" == "yes" ]]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }

# --------------------------------------------------------------- preflight ---
say "Preflight"
command -v aws  >/dev/null || { echo "aws CLI not found — https://aws.amazon.com/cli/" >&2; exit 1; }
command -v npx  >/dev/null || { echo "node/npx not found — needed for cdk bootstrap" >&2; exit 1; }
[[ -n "$ADMIN_EMAIL" ]] || { echo "--admin-email is required" >&2; exit 2; }

case "$REGION" in
  us-east-1|us-west-2|eu-west-1) ;;
  *) if [[ "$INBOUND" == "yes" ]]; then
       echo "SES inbound is only available in us-east-1, us-west-2, eu-west-1." >&2
       echo "Use one of those, or pass --no-inbound." >&2
       exit 2
     fi ;;
esac

CALLER_JSON="$(aws sts get-caller-identity --output json)"
ACCOUNT_ID="$(echo "$CALLER_JSON" | grep -o '"Account"[^,]*' | cut -d'"' -f4)"
CALLER_ARN="$(echo "$CALLER_JSON" | grep -o '"Arn"[^,]*' | cut -d'"' -f4)"
info "Account : ${ACCOUNT_ID}"
info "Caller  : ${CALLER_ARN}"
info "Region  : ${REGION}"
info "Stage   : ${STAGE}"

if [[ "$DRY_RUN" != "yes" ]]; then
  # Creating IAM principals and a CDK bootstrap is not something to do by
  # accident in the wrong account.
  read -r -p "    Bootstrap THIS account (${ACCOUNT_ID})? type the account id to confirm: " CONFIRM
  [[ "$CONFIRM" == "$ACCOUNT_ID" ]] || { echo "aborted" >&2; exit 1; }
fi

BOUNDARY_NAME="${NAME_PREFIX}-${STAGE}-boundary"
DEPLOYER_NAME="${NAME_PREFIX}-${STAGE}-deployer"
BOUNDARY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${BOUNDARY_NAME}"
MAIL_BUCKET="${NAME_PREFIX}-${STAGE}-inbound-${ACCOUNT_ID}"

# ------------------------------------------------------------------ budget ---
# First, so nothing that follows can run uncapped.
say "Budget alarm (\$${BUDGET_USD}/month -> ${ADMIN_EMAIL})"
BUDGET_JSON="$(mktemp)"; NOTIFY_JSON="$(mktemp)"
cat > "$BUDGET_JSON" <<EOF
{ "BudgetName": "${NAME_PREFIX}-${STAGE}",
  "BudgetLimit": { "Amount": "${BUDGET_USD}", "Unit": "USD" },
  "TimeUnit": "MONTHLY", "BudgetType": "COST" }
EOF
cat > "$NOTIFY_JSON" <<EOF
[ { "Notification": { "NotificationType": "ACTUAL", "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80, "ThresholdType": "PERCENTAGE" },
    "Subscribers": [ { "SubscriptionType": "EMAIL", "Address": "${ADMIN_EMAIL}" } ] } ]
EOF
if aws budgets describe-budget --account-id "$ACCOUNT_ID" \
     --budget-name "${NAME_PREFIX}-${STAGE}" >/dev/null 2>&1; then
  info "budget already exists — leaving it alone"
else
  run aws budgets create-budget --account-id "$ACCOUNT_ID" \
      --budget "file://${BUDGET_JSON}" \
      --notifications-with-subscribers "file://${NOTIFY_JSON}" \
    && info "created (alerts at 80%)"
fi

# ------------------------------------------------------- permissions boundary ---
# The honest problem: anything that can `cdk deploy` this stack can create IAM
# roles, which is escalation to admin unless constrained. The boundary caps what
# any role created by the deployment can ever do, so "scoped deploy identity"
# means something rather than being theatre.
say "Permissions boundary (${BOUNDARY_NAME})"
BOUNDARY_DOC="$(mktemp)"
cat > "$BOUNDARY_DOC" <<'EOF'
{ "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ServicesTheAppNeeds", "Effect": "Allow",
      "Action": [
        "dynamodb:*", "s3:*", "sqs:*", "sns:*", "ses:*", "kms:*",
        "cognito-idp:*", "lambda:*", "logs:*", "cloudwatch:*", "states:*",
        "scheduler:*", "secretsmanager:*", "execute-api:*", "apigateway:*",
        "firehose:*", "kinesis:*", "athena:*", "glue:*", "aoss:*", "wafv2:*",
        "cloudfront:*", "xray:*"
      ],
      "Resource": "*" },
    { "Sid": "NoPrivilegeEscalation", "Effect": "Deny",
      "Action": [
        "iam:CreateUser", "iam:CreateAccessKey", "iam:AttachUserPolicy",
        "iam:PutUserPolicy", "iam:DeleteUserPolicy", "iam:UpdateAssumeRolePolicy",
        "iam:DeleteRolePermissionsBoundary", "iam:PutRolePermissionsBoundary",
        "organizations:*", "account:*", "billing:*"
      ],
      "Resource": "*" }
  ] }
EOF
if aws iam get-policy --policy-arn "$BOUNDARY_ARN" >/dev/null 2>&1; then
  info "boundary already exists"
else
  run aws iam create-policy --policy-name "$BOUNDARY_NAME" \
      --policy-document "file://${BOUNDARY_DOC}" \
      --description "Caps what any addressium-deployed role can do" >/dev/null \
    && info "created ${BOUNDARY_ARN}"
fi

# ---------------------------------------------------------- cdk bootstrap ---
# This is what makes a scoped deploy identity practical. CDK creates its own
# deploy / file-publishing / lookup / cfn-exec roles; the deployer below is then
# only permitted to ASSUME them, and they only act on CDK-qualified stacks.
say "CDK bootstrap (qualifier ${QUALIFIER})"
info "The cfn-exec role is assumed by CloudFormation, never by a human or agent."
info "Its power is bounded by what the template declares + the boundary above."
run npx --yes cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}" \
    --qualifier "$QUALIFIER" \
    --cloudformation-execution-policies "arn:aws:iam::aws:policy/AdministratorAccess" \
    --custom-permissions-boundary "$BOUNDARY_NAME"

# --------------------------------------------------------- deploy identity ---
say "Deploy identity (${PRINCIPAL}: ${DEPLOYER_NAME})"
DEPLOY_DOC="$(mktemp)"
cat > "$DEPLOY_DOC" <<EOF
{ "Version": "2012-10-17",
  "Statement": [
    { "Sid": "AssumeCdkRolesOnly", "Effect": "Allow", "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/cdk-${QUALIFIER}-deploy-role-${ACCOUNT_ID}-${REGION}",
        "arn:aws:iam::${ACCOUNT_ID}:role/cdk-${QUALIFIER}-file-publishing-role-${ACCOUNT_ID}-${REGION}",
        "arn:aws:iam::${ACCOUNT_ID}:role/cdk-${QUALIFIER}-image-publishing-role-${ACCOUNT_ID}-${REGION}",
        "arn:aws:iam::${ACCOUNT_ID}:role/cdk-${QUALIFIER}-lookup-role-${ACCOUNT_ID}-${REGION}"
      ] },
    { "Sid": "ReadBootstrapVersion", "Effect": "Allow", "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/cdk-bootstrap/${QUALIFIER}/version" },
    { "Sid": "ObserveOwnDeployments", "Effect": "Allow",
      "Action": [ "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents",
                  "cloudformation:GetTemplate", "cloudformation:ListStacks" ],
      "Resource": "*" },
    { "Sid": "RunTheSmokeSuite", "Effect": "Allow",
      "Action": [ "s3:GetObject", "s3:ListBucket", "s3:DeleteObject",
                  "dynamodb:Query", "dynamodb:GetItem", "dynamodb:Scan",
                  "ses:GetAccount", "ses:ListEmailIdentities", "ses:GetEmailIdentity",
                  "logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogGroups",
                  "lambda:InvokeFunction" ],
      "Resource": "*" }
  ] }
EOF

if [[ "$PRINCIPAL" == "role" ]]; then
  TRUST_DOC="$(mktemp)"
  cat > "$TRUST_DOC" <<EOF
{ "Version": "2012-10-17",
  "Statement": [ { "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:root" },
    "Action": "sts:AssumeRole" } ] }
EOF
  aws iam get-role --role-name "$DEPLOYER_NAME" >/dev/null 2>&1 \
    || run aws iam create-role --role-name "$DEPLOYER_NAME" \
         --assume-role-policy-document "file://${TRUST_DOC}" \
         --permissions-boundary "$BOUNDARY_ARN" >/dev/null
  run aws iam put-role-policy --role-name "$DEPLOYER_NAME" \
      --policy-name "deploy" --policy-document "file://${DEPLOY_DOC}"
  info "role arn: arn:aws:iam::${ACCOUNT_ID}:role/${DEPLOYER_NAME}"
else
  aws iam get-user --user-name "$DEPLOYER_NAME" >/dev/null 2>&1 \
    || run aws iam create-user --user-name "$DEPLOYER_NAME" \
         --permissions-boundary "$BOUNDARY_ARN" >/dev/null
  run aws iam put-user-policy --user-name "$DEPLOYER_NAME" \
      --policy-name "deploy" --policy-document "file://${DEPLOY_DOC}"
fi

# ----------------------------------------------------------------- ses ------
say "SES identities"
info "Leaving the account in SANDBOX deliberately: AWS then refuses to deliver"
info "to any address that isn't verified. That is a stronger guarantee than any"
info "application-level allowlist, and it is exactly what we want for testing."
run aws sesv2 create-email-identity --email-identity "$ADMIN_EMAIL" --region "$REGION" 2>/dev/null \
  || info "identity ${ADMIN_EMAIL} already exists"
warn "Check ${ADMIN_EMAIL} and click the AWS verification link before sending."

if [[ -n "$DOMAIN" ]]; then
  run aws sesv2 create-email-identity --email-identity "$DOMAIN" --region "$REGION" 2>/dev/null \
    || info "identity ${DOMAIN} already exists"
  if [[ "$DRY_RUN" != "yes" ]]; then
    info "Add these DKIM CNAMEs to DNS for ${DOMAIN}:"
    aws sesv2 get-email-identity --email-identity "$DOMAIN" --region "$REGION" \
      --query 'DkimAttributes.Tokens' --output text 2>/dev/null \
      | tr '\t' '\n' | while read -r t; do
          [[ -n "$t" ]] && printf '      %s._domainkey.%s  CNAME  %s.dkim.amazonses.com\n' "$t" "$DOMAIN" "$t"
        done
  fi
fi

# -------------------------------------------------------------- inbound -----
if [[ "$INBOUND" == "yes" && -n "$DOMAIN" ]]; then
  say "Inbound mail (SES receipt rule -> s3://${MAIL_BUCKET})"
  info "Inbound goes to S3 rather than a third-party mailbox: no extra vendor,"
  info "no extra credential, and the raw MIME is preserved so the smoke suite can"
  info "assert on List-Unsubscribe headers directly."
  aws s3api head-bucket --bucket "$MAIL_BUCKET" 2>/dev/null || {
    if [[ "$REGION" == "us-east-1" ]]; then
      run aws s3api create-bucket --bucket "$MAIL_BUCKET" --region "$REGION" >/dev/null
    else
      run aws s3api create-bucket --bucket "$MAIL_BUCKET" --region "$REGION" \
          --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
    fi
  }
  POLICY_DOC="$(mktemp)"
  cat > "$POLICY_DOC" <<EOF
{ "Version": "2012-10-17",
  "Statement": [ { "Effect": "Allow", "Principal": { "Service": "ses.amazonaws.com" },
      "Action": "s3:PutObject", "Resource": "arn:aws:s3:::${MAIL_BUCKET}/*",
      "Condition": { "StringEquals": { "AWS:SourceAccount": "${ACCOUNT_ID}" } } } ] }
EOF
  run aws s3api put-bucket-policy --bucket "$MAIL_BUCKET" --policy "file://${POLICY_DOC}"
  aws ses describe-active-receipt-rule-set --region "$REGION" >/dev/null 2>&1 \
    || run aws ses create-receipt-rule-set --rule-set-name "${NAME_PREFIX}-${STAGE}" --region "$REGION"
  run aws ses set-active-receipt-rule-set --rule-set-name "${NAME_PREFIX}-${STAGE}" --region "$REGION" 2>/dev/null || true
  run aws ses create-receipt-rule --region "$REGION" \
      --rule-set-name "${NAME_PREFIX}-${STAGE}" \
      --rule "{\"Name\":\"to-s3\",\"Enabled\":true,\"ScanEnabled\":true,\"Recipients\":[\"${DOMAIN}\"],\"Actions\":[{\"S3Action\":{\"BucketName\":\"${MAIL_BUCKET}\"}}]}" \
      2>/dev/null || info "receipt rule already exists"
  warn "Add this MX record for ${DOMAIN}:"
  printf '      %s  MX  10 inbound-smtp.%s.amazonaws.com\n' "$DOMAIN" "$REGION"
fi

# ----------------------------------------------------------------- output ---
say "Done"
cat <<EOF

  Account ........ ${ACCOUNT_ID}
  Region ......... ${REGION}
  Stage .......... ${STAGE}
  Boundary ....... ${BOUNDARY_ARN}
  Deploy ${PRINCIPAL} ... ${DEPLOYER_NAME}
$( [[ "$INBOUND" == "yes" && -n "$DOMAIN" ]] && echo "  Inbound mail ... s3://${MAIL_BUCKET}" )

  Remaining manual steps:
    1. Click the SES verification link sent to ${ADMIN_EMAIL}.
$( [[ -n "$DOMAIN" ]] && echo "    2. Add the DKIM CNAMEs (and MX record) printed above." )
    3. Write infra/cdk/addressium.config.json:
         { "stage": "${STAGE}", "region": "${REGION}",
           "adminEmails": ["${ADMIN_EMAIL}"],
           "adminHostedUiDomainPrefix": "${NAME_PREFIX}-admin" }

  Hand the deploy credentials over:
EOF
if [[ "$PRINCIPAL" == "role" ]]; then
  cat <<EOF
    aws sts assume-role \\
      --role-arn arn:aws:iam::${ACCOUNT_ID}:role/${DEPLOYER_NAME} \\
      --role-session-name addressium --duration-seconds 3600
    -> set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
       These EXPIRE, which is why this is the preferred option.
EOF
else
  cat <<EOF
    aws iam create-access-key --user-name ${DEPLOYER_NAME}
    -> set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION=${REGION}
       as ENVIRONMENT VARIABLES. Never paste them into a chat or commit them.
       Rotate with: aws iam delete-access-key --user-name ${DEPLOYER_NAME} --access-key-id <id>
EOF
fi
echo
echo "  Then: npm run build && npm run deploy"
echo "  Teardown: ./scripts/aws-teardown.sh --stage ${STAGE} --region ${REGION}"
echo
