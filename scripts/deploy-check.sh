#!/usr/bin/env bash
#
# addressium — deploy dry run. Refuses any change that would destroy data.
#
#   ./scripts/deploy-check.sh [--stage dev] [--region us-east-1]
#
# Why this exists
# ---------------
# RemovalPolicy.RETAIN only governs stack DELETION. It does NOT protect against
# resource REPLACEMENT. If a change forces the DynamoDB table to be replaced —
# altering the partition key, the sort key, or the table name — CloudFormation
# creates a NEW, EMPTY table and orphans the old one. Nothing is "deleted", so
# RETAIN is satisfied and every existing check passes, but the application now
# points at an empty table and every subscriber is gone from its perspective.
#
# `cdk diff` renders human-readable prose. A CloudFormation CHANGE SET is
# structured data, so this check is mechanical rather than "remember to read the
# output carefully". It creates a change set, inspects it, and exits non-zero if
# any data-holding resource would be replaced or removed.
#
set -euo pipefail

NAME_PREFIX="addressium"
KEEP_CHANGE_SET="no"

# Stage and region are NOT defaulted here any more. They are read from the same
# file `cdk deploy` reads, so the stack this gate inspects is the stack the
# deploy will touch. An explicit --stage/--region (or STAGE / AWS_REGION) that
# CONTRADICTS that file is refused rather than silently honoured — otherwise the
# gate happily reports "safe to deploy" for addressium-dev while `cdk deploy`
# replaces the table behind addressium-prod.
STAGE_FLAG=""
REGION_FLAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)  STAGE_FLAG="$2"; shift 2 ;;
    --region) REGION_FLAG="$2"; shift 2 ;;
    --keep)   KEEP_CHANGE_SET="yes"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# The script is invoked from the repo root (npm's deploy:check / predeploy),
# but `cdk` only works where cdk.json lives. Anchor everything so a direct
# invocation from any directory behaves the same.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CDK_DIR="$ROOT/infra/cdk"
CFG="$CDK_DIR/addressium.config.json"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\033[31m    ✗ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m    ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }

json_field() {
  python3 -c "
import json,sys
try:
    print(json.load(open(sys.argv[1])).get(sys.argv[2],'').strip())
except Exception:
    print('')
" "$1" "$2" 2>/dev/null || echo ""
}

say "Resolving the stack to check"

CFG_STAGE=""
CFG_REGION=""
if [[ -f "$CFG" ]]; then
  CFG_STAGE="$(json_field "$CFG" stage)"
  CFG_REGION="$(json_field "$CFG" region)"
fi

# Precedence: explicit flag > environment variable > config file > default.
STAGE="${STAGE_FLAG:-${STAGE:-}}"
REGION="${REGION_FLAG:-${AWS_REGION:-}}"

if [[ -n "$CFG_STAGE" ]]; then
  if [[ -n "$STAGE" && "$STAGE" != "$CFG_STAGE" ]]; then
    fail "--stage ${STAGE} contradicts stage \"${CFG_STAGE}\" in ${CFG}"
    fail "cdk deploy reads its stage from that file, so this check would inspect"
    fail "stack ${NAME_PREFIX}-${STAGE} while the deploy replaces ${NAME_PREFIX}-${CFG_STAGE}."
    fail "Change the config, or drop the override to check what will actually be deployed."
    exit 2
  fi
  STAGE="$CFG_STAGE"
fi

if [[ -n "$CFG_REGION" ]]; then
  if [[ -n "$REGION" && "$REGION" != "$CFG_REGION" ]]; then
    fail "--region ${REGION} contradicts region \"${CFG_REGION}\" in ${CFG}"
    fail "the change set would be inspected in ${REGION} while the deploy happens in ${CFG_REGION}."
    fail "Change the config, or drop the override to check what will actually be deployed."
    exit 2
  fi
  REGION="$CFG_REGION"
fi

if [[ -z "$CFG_STAGE" || -z "$CFG_REGION" ]]; then
  warn "no stage/region in ${CFG} — falling back to stage=${STAGE:-dev} region=${REGION:-us-east-1}."
  warn "cdk deploy cannot run without that file, so this check is not gating a real deploy."
fi

STAGE="${STAGE:-dev}"
REGION="${REGION:-us-east-1}"

STACK="${NAME_PREFIX}-${STAGE}"
# Change-set names must be unique per attempt and match [a-zA-Z][-a-zA-Z0-9]*.
CHANGE_SET="addressium-check-$$"

info "stack ${STACK} in ${REGION} (from ${CFG##*/})"

# Refuse to run as the account root. Root has no CloudTrail-attributable deploy
# identity and an unbounded blast radius, and on many machines the ambient
# credentials resolve to it. Everything below assumes a scoped principal.
say "Checking the deploy identity"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo "")"
if [[ -z "$CALLER_ARN" || "$CALLER_ARN" == "None" ]]; then
  fail "no usable AWS credentials — cannot check the change set or deploy."
  exit 1
fi
if [[ "$CALLER_ARN" == *":root" ]]; then
  fail "these credentials are the ACCOUNT ROOT: ${CALLER_ARN}"
  fail "root has unrestricted access and no attributable deploy identity."
  fail "Deploy as the scoped role instead:"
  fail "  AWS_PROFILE=addressium-deploy npm run deploy"
  exit 1
fi
ok "deploying as ${CALLER_ARN##*/}"

cleanup() {
  if [[ "$KEEP_CHANGE_SET" == "no" ]]; then
    aws cloudformation delete-change-set \
      --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
      --region "$REGION" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Exposure preflight (#222). Not a data-safety check, so it warns rather than
# refusing — but a stack that ships 26 alarms into a topic with no subscribers
# LOOKS monitored, which is worse than one with no alarms at all.
say "Checking alert routing"
if [[ -f "$CFG" ]]; then
  OPS_ARN="$(json_field "$CFG" opsAlertTopicArn)"
  OPS_EMAIL="$(json_field "$CFG" opsAlertEmail)"

  # A configured target is not a working one. An SNS email subscription starts
  # PENDING; if nobody clicks the confirmation mail, SNS deletes it after three
  # days. After that the topic pages nobody while the config still reads as
  # though it does — which is exactly what happened on 2026-09-17. So ask the
  # live topic, not the file.
  RESOLVED_TOPIC=""
  if [[ -n "$OPS_ARN" ]]; then
    RESOLVED_TOPIC="$OPS_ARN"
  elif [[ -n "$OPS_EMAIL" ]]; then
    # Read the stack OUTPUT rather than walking StackResources: that call pages
    # at 100 items and this stack is much larger, so a resource lookup silently
    # reports "not found" for anything past the first page. The output is exact.
    RESOLVED_TOPIC="$(aws cloudformation describe-stacks \
      --stack-name "$STACK" --region "$REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='OpsAlertsTopicArn'].OutputValue | [0]" \
      --output text 2>/dev/null || echo "")"
  fi

  if [[ -z "$OPS_ARN" && -z "$OPS_EMAIL" ]]; then
    warn "no opsAlertTopicArn and no opsAlertEmail — every CloudWatch alarm will"
    warn "publish to a topic with NO subscribers. A stuck send queue, a filling"
    warn "dead-letter queue, or a failing bounce handler will page nobody."
    warn "Set one of them in ${CFG}."
  elif [[ -z "$RESOLVED_TOPIC" || "$RESOLVED_TOPIC" == "None" ]]; then
    if aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
      warn "alert target configured, but ${STACK} exposes no OpsAlertsTopicArn output."
      warn "Alerting cannot be verified against a topic this script cannot find."
    else
      warn "alert target configured in ${CFG}, but ${STACK} does not exist yet."
      warn "The topic and its subscription are created with the first deploy."
    fi
  else
    ATTRS="$(aws sns get-topic-attributes --topic-arn "$RESOLVED_TOPIC" --region "$REGION" \
      --query 'Attributes.[SubscriptionsConfirmed,SubscriptionsPending]' --output text 2>/dev/null || echo "")"
    CONFIRMED="$(printf '%s' "$ATTRS" | awk '{print $1}')"
    PENDING="$(printf '%s' "$ATTRS" | awk '{print $2}')"
    if [[ -z "$CONFIRMED" ]]; then
      warn "could not read the ops topic (${RESOLVED_TOPIC}) — alerting unverified."
    elif [[ "$CONFIRMED" == "0" ]]; then
      fail "the ops topic has NO confirmed subscribers — every alarm pages nobody."
      if [[ "${PENDING:-0}" != "0" ]]; then
        fail "${PENDING} subscription(s) PENDING: the confirmation mail was never"
        fail "clicked. SNS deletes an unconfirmed subscription after 3 days."
      fi
      fail "topic: ${RESOLVED_TOPIC}"
    else
      ok "alarms reach ${CONFIRMED} confirmed subscriber(s) on the ops topic"
    fi
  fi

  # Edge protection is the operator's (#225). The stack no longer creates a
  # WebACL, so an unconfigured deploy is genuinely unprotected rather than
  # protected by something we made.
  WAF_API="$(python3 -c "import json;print(json.load(open('$CFG')).get('apiWebAclArn','').strip())" 2>/dev/null || echo "")"
  WAF_CF="$(python3 -c "import json;print(json.load(open('$CFG')).get('cloudfrontWebAclArn','').strip())" 2>/dev/null || echo "")"
  if [[ -n "$WAF_API" && -n "$WAF_CF" ]]; then
    ok "WAF associations configured for the API and both distributions"
  else
    [[ -z "$WAF_API" ]] && warn "no apiWebAclArn — the public API has no WAF in front of it"
    [[ -z "$WAF_CF" ]] && warn "no cloudfrontWebAclArn — the SPA distributions have no WAF"
    warn "addressium does not create WebACLs. Attach your own to the ApiStageArn"
    warn "and *DistributionId stack outputs, then set the ARNs in ${CFG}."
  fi
else
  warn "no ${CFG} — cannot check alert routing"
fi

# The confirm link is the ONE url a subscriber must be able to open for double
# opt-in to complete. Its default is the literal placeholder
# `https://your-site.example/confirm`, which deploys perfectly happily and then
# puts a dead link in every confirmation email — signup succeeds, the mail
# arrives, and nobody can ever confirm. Nothing else in the stack notices,
# because from its side the send worked.
say "Checking the double opt-in confirm URL"
CONFIRM_BASE="$(python3 -c "
import json,sys
try:
    print((json.load(open('$CDK_DIR/cdk.json')).get('context',{}) or {}).get('confirmUrlBase','') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")"
if [[ -z "$CONFIRM_BASE" || "$CONFIRM_BASE" == *"your-site.example"* ]]; then
  warn "confirmUrlBase is unset — confirmation emails will link to"
  warn "  https://your-site.example/confirm, a domain you do not own."
  warn "Set it in ${CDK_DIR}/cdk.json under \"context\", or pass"
  warn "  -c confirmUrlBase=https://<your-subscriber-site>/confirm"
  warn "It must point at the PUBLIC distribution — that is where subscriber-web"
  warn "serves /confirm."
else
  ok "confirm URL points at ${CONFIRM_BASE}"
fi

say "Building"
(cd "$ROOT" && npm run build) >/dev/null

# Every role must carry the permissions boundary. The bootstrap boundary grants
# iam:CreateRole only when the new role carries it, so a role that synthesizes
# without one is not a policy nit — CloudFormation cannot create it, and the
# deploy fails partway through with a stack to roll back.
#
# Checked against synthesized output rather than source because the boundary is
# applied by an Aspect at synth time: reading bin/addressium.ts proves the
# context key is set, not that it reached every role. A construct that builds a
# role outside the App tree would pass a source grep and fail here, which is the
# whole point.
say "Checking every IAM role carries the permissions boundary"
(cd "$CDK_DIR" && npx --yes cdk synth "$STACK" --quiet) >/dev/null
TEMPLATE="$CDK_DIR/cdk.out/${STACK}.template.json"
if [ ! -f "$TEMPLATE" ]; then
  fail "expected synthesized template at ${TEMPLATE}"
  exit 1
fi
NAKED="$(python3 -c '
import json, sys
with open(sys.argv[1]) as fh:
    resources = json.load(fh).get("Resources", {})
print(" ".join(
    name for name, body in resources.items()
    if body.get("Type") == "AWS::IAM::Role"
    and not body.get("Properties", {}).get("PermissionsBoundary")
))' "$TEMPLATE")"
if [ -n "$NAKED" ]; then
  fail "these roles synthesize with NO permissions boundary:"
  for role in $NAKED; do fail "    $role"; done
  fail "the deploy would be denied at iam:CreateRole — see infra/bootstrap"
  exit 1
fi
ok "all IAM roles carry the boundary"

say "Creating change set for ${STACK} (nothing is applied)"
if ! aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
  info "Stack does not exist yet — this would be a CREATE."
  info "Nothing can be replaced on a first deploy, so there is nothing to check."
  (cd "$CDK_DIR" && npx --yes cdk diff "$STACK") || true
  exit 0
fi

# --no-execute leaves the change set pending instead of applying it.
(cd "$CDK_DIR" && npx --yes cdk deploy "$STACK" --no-execute --change-set-name "$CHANGE_SET" --require-approval never)

say "Inspecting the change set"
CHANGES_JSON="$(aws cloudformation describe-change-set \
  --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
  --region "$REGION" --output json)"

python3 "$(dirname "$0")/inspect-change-set.py" "$CHANGES_JSON"

ok "safe to deploy — run: npm run deploy"
