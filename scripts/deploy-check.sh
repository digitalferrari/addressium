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

STAGE="${STAGE:-dev}"
REGION="${AWS_REGION:-us-east-1}"
NAME_PREFIX="addressium"
KEEP_CHANGE_SET="no"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)  STAGE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --keep)   KEEP_CHANGE_SET="yes"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

STACK="${NAME_PREFIX}-${STAGE}"
# Change-set names must be unique per attempt and match [a-zA-Z][-a-zA-Z0-9]*.
CHANGE_SET="addressium-check-$$"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\033[31m    ✗ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m    ✓ %s\033[0m\n' "$*"; }

cleanup() {
  if [[ "$KEEP_CHANGE_SET" == "no" ]]; then
    aws cloudformation delete-change-set \
      --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
      --region "$REGION" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }

# Exposure preflight (#222). Not a data-safety check, so it warns rather than
# refusing — but a stack that ships 26 alarms into a topic with no subscribers
# LOOKS monitored, which is worse than one with no alarms at all.
say "Checking alert routing"
CFG="infra/cdk/addressium.config.json"
if [[ -f "$CFG" ]]; then
  OPS_ARN="$(python3 -c "import json,sys;print(json.load(open('$CFG')).get('opsAlertTopicArn','').strip())" 2>/dev/null || echo "")"
  OPS_EMAIL="$(python3 -c "import json,sys;print(json.load(open('$CFG')).get('opsAlertEmail','').strip())" 2>/dev/null || echo "")"
  if [[ -n "$OPS_ARN" ]]; then
    ok "alarms publish to your topic: ${OPS_ARN}"
  elif [[ -n "$OPS_EMAIL" ]]; then
    ok "alarms publish to a created topic subscribed by ${OPS_EMAIL}"
  else
    warn "no opsAlertTopicArn and no opsAlertEmail — every CloudWatch alarm will"
    warn "publish to a topic with NO subscribers. A stuck send queue, a filling"
    warn "dead-letter queue, or a failing bounce handler will page nobody."
    warn "Set one of them in ${CFG}."
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

say "Building"
npm run build >/dev/null

say "Creating change set for ${STACK} (nothing is applied)"
if ! aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
  info "Stack does not exist yet — this would be a CREATE."
  info "Nothing can be replaced on a first deploy, so there is nothing to check."
  npx --yes cdk diff "$STACK" || true
  exit 0
fi

# --no-execute leaves the change set pending instead of applying it.
npx --yes cdk deploy "$STACK" --no-execute --change-set-name "$CHANGE_SET" --require-approval never

say "Inspecting the change set"
CHANGES_JSON="$(aws cloudformation describe-change-set \
  --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
  --region "$REGION" --output json)"

python3 "$(dirname "$0")/inspect-change-set.py" "$CHANGES_JSON"

ok "safe to deploy — run: npm run deploy"
