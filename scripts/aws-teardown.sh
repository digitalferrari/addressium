#!/usr/bin/env bash
#
# addressium — tear down everything aws-bootstrap.sh created, plus the stack.
#
# Order matters: the CloudFormation stack must go first, because its resources
# reference the bootstrap roles. Non-prod stages use RemovalPolicy.DESTROY, so
# buckets and tables really do disappear.
#
#   ./scripts/aws-teardown.sh --stage dev --region us-east-1
#
set -euo pipefail

STAGE="dev"
REGION="${AWS_REGION:-us-east-1}"
NAME_PREFIX="addressium"
KEEP_BOOTSTRAP="no"
DRY_RUN="no"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)  STAGE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --keep-cdk-bootstrap) KEEP_BOOTSTRAP="yes"; shift ;;
    --dry-run) DRY_RUN="yes"; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
run()  { if [[ "$DRY_RUN" == "yes" ]]; then printf '    [dry-run] %s\n' "$*"; else "$@" || true; fi; }

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
DEPLOYER_NAME="${NAME_PREFIX}-${STAGE}-deployer"
BOUNDARY_NAME="${NAME_PREFIX}-${STAGE}-boundary"
BOUNDARY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${BOUNDARY_NAME}"
MAIL_BUCKET="${NAME_PREFIX}-${STAGE}-inbound-${ACCOUNT_ID}"

if [[ "$STAGE" == "prod" ]]; then
  echo "Refusing to tear down the 'prod' stage. Its resources are RETAINed by" >&2
  echo "design; delete them deliberately and by hand." >&2
  exit 1
fi

if [[ "$DRY_RUN" != "yes" ]]; then
  read -r -p "Destroy addressium-${STAGE} in ${ACCOUNT_ID}/${REGION}? type the stage name: " C
  [[ "$C" == "$STAGE" ]] || { echo "aborted" >&2; exit 1; }
fi

say "CloudFormation stack"
run npx --yes cdk destroy "${NAME_PREFIX}-${STAGE}" --force

say "Inbound mail"
run aws ses delete-receipt-rule --rule-set-name "${NAME_PREFIX}-${STAGE}" --rule-name "to-s3" --region "$REGION"
run aws ses delete-receipt-rule-set --rule-set-name "${NAME_PREFIX}-${STAGE}" --region "$REGION"
run aws s3 rm "s3://${MAIL_BUCKET}" --recursive
run aws s3api delete-bucket --bucket "$MAIL_BUCKET" --region "$REGION"

say "Deploy identity"
# Access keys and inline policies must go before the principal itself.
for k in $(aws iam list-access-keys --user-name "$DEPLOYER_NAME" \
             --query 'AccessKeyMetadata[].AccessKeyId' --output text 2>/dev/null || true); do
  run aws iam delete-access-key --user-name "$DEPLOYER_NAME" --access-key-id "$k"
done
run aws iam delete-user-policy --user-name "$DEPLOYER_NAME" --policy-name "deploy"
run aws iam delete-user --user-name "$DEPLOYER_NAME"
run aws iam delete-role-policy --role-name "$DEPLOYER_NAME" --policy-name "deploy"
run aws iam delete-role --role-name "$DEPLOYER_NAME"

say "Permissions boundary"
run aws iam delete-policy --policy-arn "$BOUNDARY_ARN"

say "Budget"
run aws budgets delete-budget --account-id "$ACCOUNT_ID" --budget-name "${NAME_PREFIX}-${STAGE}"

if [[ "$KEEP_BOOTSTRAP" == "no" ]]; then
  say "CDK bootstrap"
  info "The CDKToolkit stack is shared by every CDK app in this account/region."
  info "Skipping deletion — pass --keep-cdk-bootstrap to silence this, or delete"
  info "the CDKToolkit stack by hand if addressium was the only CDK app here."
fi

say "Done"
info "SES identities were left verified — they cost nothing and re-verifying is slow."
