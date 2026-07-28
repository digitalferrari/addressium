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

python3 - "$CHANGES_JSON" <<'PY'
import json, sys

# Resources whose loss is unrecoverable. Static-site buckets are deliberately
# absent: they hold rebuildable build artifacts, not data.
STATEFUL = {
    "AWS::DynamoDB::Table",
    "AWS::S3::Bucket",
    "AWS::Cognito::UserPool",
    "AWS::KMS::Key",
    # A replaced queue is a NEW, empty queue: every message still in flight on
    # the old one is orphaned. On SendQueue that is unsent recipient batches; on
    # EventsQueue it is bounces that never reach suppression (#231, #218).
    "AWS::SQS::Queue",
}
# Buckets that only ever hold redeployable assets.
REBUILDABLE_HINTS = ("AdminSite", "PublicSite")

data = json.loads(sys.argv[1])
changes = data.get("Changes", [])

# Fail CLOSED on a shape we do not recognise (#231). This parser is the only
# thing standing between an ordinary deploy and a silently emptied table, and
# its previous failure mode was the worst possible one: a change set whose
# fields it could not read produced no findings and exited 0 — the guard
# approving exactly the deploy it exists to block.
if changes:
    unreadable = [
        c for c in changes
        if not isinstance(c.get("ResourceChange"), dict)
        or not c["ResourceChange"].get("ResourceType")
        or not c["ResourceChange"].get("Action")
    ]
    if unreadable:
        print("\n\033[31m    ✗ REFUSING: change set contains entries this check cannot interpret\033[0m\n")
        print(f"      {len(unreadable)} of {len(changes)} entries lack a readable ResourceChange.")
        print("      The CloudFormation response shape may have changed. Refusing rather than")
        print("      passing, because a parser that reads nothing reports nothing.")
        for c in unreadable[:5]:
            print(f"      {json.dumps(c)[:200]}")
        sys.exit(1)

if not changes:
    print("    no resource changes")

destructive, replacements, other = [], [], []
for c in changes:
    r = c.get("ResourceChange", {})
    rtype, action = r.get("ResourceType", "?"), r.get("Action", "?")
    logical, repl = r.get("LogicalResourceId", "?"), r.get("Replacement")
    is_stateful = rtype in STATEFUL and not any(h in logical for h in REBUILDABLE_HINTS)
    row = f"{action:8s} {('replace=' + str(repl)):16s} {rtype:30s} {logical}"
    if is_stateful and (action == "Remove" or repl in ("True", "Conditional")):
        destructive.append((row, r))
    elif repl == "True":
        replacements.append(row)
    else:
        other.append(row)

for row in other:
    print(f"    {row}")
for row in replacements:
    print(f"    \033[33m{row}\033[0m")

if replacements:
    print(f"\n    {len(replacements)} resource(s) will be REPLACED (stateless — recreated, no data loss).")

if destructive:
    print("\n\033[31m    ✗ REFUSING: this change would destroy or replace data-holding resources\033[0m\n")
    for row, r in destructive:
        print(f"      {row}")
        for d in r.get("Details", []):
            tgt = d.get("Target", {})
            if tgt.get("RequiresRecreation") in ("Always", "Conditionally"):
                print(f"         cause: {tgt.get('Attribute')}.{tgt.get('Name')} "
                      f"(RequiresRecreation={tgt.get('RequiresRecreation')})")
    print("""
      Replacement means CloudFormation creates a NEW, EMPTY resource and orphans
      the old one. RemovalPolicy.RETAIN does not prevent this — it only prevents
      deletion on stack teardown. The data survives in the orphaned resource but
      the application would point at an empty one.

      If this is intentional, you need a migration that copies the data across,
      not a deploy. See docs and issue #213.
""")
    sys.exit(1)

print("\n    no data-holding resource is replaced or removed")
PY

ok "safe to deploy — run: npm run deploy"
