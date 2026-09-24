#!/usr/bin/env bash
# Prove the backup restores (#321).
#
#   AWS_REGION=us-east-1 ./scripts/restore-drill.sh
#
# A backup nobody has restored is a hypothesis, not a backup. This restores the
# most recent recovery point to a NEW table, compares it against the live one,
# and tells you what to delete afterwards.
#
# READ-ONLY against production data. It never writes to, deletes, or replaces the
# live table — the restore target is a new table with a timestamped name, which
# is also the only way DynamoDB will restore at all (you cannot restore over an
# existing table). Cleanup is left to you rather than done automatically: an
# unattended delete of something named "restore" is exactly the command that
# eventually hits the wrong table.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="${ADDRESSIUM_STACK:-addressium-dev}"

fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
note() { printf '  %s\n' "$1"; }

echo "==> Finding the vault and the live table"
VAULT=$(aws backup list-backup-vaults --region "$REGION" \
  --query "BackupVaultList[?contains(BackupVaultName,'addressium')].BackupVaultName | [0]" --output text)
[ "$VAULT" != "None" ] && [ -n "$VAULT" ] || fail "no addressium backup vault in $REGION"
note "vault: $VAULT"

# list-, not describe-: describe-stack-resources truncates on a stack this size
# (100+ resources) and silently returns nothing for the table.
LIVE=$(aws cloudformation list-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResourceSummaries[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId" --output text | tr '\t' '\n' | grep -v '^None$' | head -1)
[ "$LIVE" != "None" ] && [ -n "$LIVE" ] || fail "could not find the table in stack $STACK"
note "live table: $LIVE"

echo
echo "==> Most recent recovery point for that table"
RP=$(aws backup list-recovery-points-by-backup-vault --backup-vault-name "$VAULT" --region "$REGION" \
  --query "sort_by(RecoveryPoints[?contains(ResourceArn,'$LIVE')], &CreationDate)[-1].[RecoveryPointArn,CreationDate,Status,BackupSizeInBytes]" \
  --output text)
[ -n "$RP" ] && [ "$RP" != "None" ] || fail "no recovery point for $LIVE yet — the daily job runs at 05:00 UTC"
RP_ARN=$(echo "$RP" | cut -f1); RP_WHEN=$(echo "$RP" | cut -f2)
RP_STATUS=$(echo "$RP" | cut -f3); RP_BYTES=$(echo "$RP" | cut -f4)
note "created: $RP_WHEN"
note "status : $RP_STATUS"
note "size   : $RP_BYTES bytes"
[ "$RP_STATUS" = "COMPLETED" ] || fail "recovery point is $RP_STATUS, not COMPLETED — wait for it to finish"

echo
echo "==> Restoring to a NEW table (the live table is never touched)"
TARGET="${LIVE}-restoretest-$(date -u +%Y%m%d%H%M)"
note "target: $TARGET"

ROLE=$(aws iam list-roles --query "Roles[?contains(RoleName,'BackupPlanDataSelectionRole')].Arn | [0]" --output text)
[ "$ROLE" != "None" ] && [ -n "$ROLE" ] || fail "could not find the backup service role"

JOB=$(aws backup start-restore-job --region "$REGION" \
  --recovery-point-arn "$RP_ARN" --iam-role-arn "$ROLE" \
  --metadata "{\"targetTableName\":\"$TARGET\"}" \
  --query 'RestoreJobId' --output text)
note "restore job: $JOB"

echo "  waiting (a small table takes a few minutes)…"
while :; do
  S=$(aws backup describe-restore-job --restore-job-id "$JOB" --region "$REGION" --query 'Status' --output text)
  [ "$S" = "COMPLETED" ] && break
  [ "$S" = "FAILED" ] || [ "$S" = "ABORTED" ] && fail "restore job $S: $(aws backup describe-restore-job --restore-job-id "$JOB" --region "$REGION" --query 'StatusMessage' --output text)"
  sleep 20
done
ok "restore completed"

echo
echo "==> Comparing the restored table against the live one"
# Item counts are updated ~every 6 hours, so they are indicative, not exact.
# The row-level checks below are what actually prove the data came back.
for t in "$LIVE" "$TARGET"; do
  printf '  %-60s items≈%s bytes=%s\n' "$t" \
    "$(aws dynamodb describe-table --table-name "$t" --region "$REGION" --query 'Table.ItemCount' --output text)" \
    "$(aws dynamodb describe-table --table-name "$t" --region "$REGION" --query 'Table.TableSizeBytes' --output text)"
done

echo
echo "  spot-checking real records:"
for probe in "ORG#identithing-newsletter|#META" ; do
  PK="${probe%%|*}"; SK="${probe##*|}"
  L=$(aws dynamodb get-item --table-name "$LIVE"   --region "$REGION" --key "{\"pk\":{\"S\":\"$PK\"},\"sk\":{\"S\":\"$SK\"}}" --query 'Item.data.M.name.S' --output text 2>/dev/null || echo MISSING)
  R=$(aws dynamodb get-item --table-name "$TARGET" --region "$REGION" --key "{\"pk\":{\"S\":\"$PK\"},\"sk\":{\"S\":\"$SK\"}}" --query 'Item.data.M.name.S' --output text 2>/dev/null || echo MISSING)
  printf '    %-34s live=%-26s restored=%s\n' "$PK" "$L" "$R"
  [ "$L" = "$R" ] || fail "MISMATCH — the restore did not reproduce the live record"
done
ok "records match"

echo
ok "RESTORE DRILL PASSED — the backup is real, not just scheduled"
echo
echo "Clean up when you have finished inspecting it:"
echo "  aws dynamodb delete-table --table-name $TARGET --region $REGION"
