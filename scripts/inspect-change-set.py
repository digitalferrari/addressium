#!/usr/bin/env python3
"""
Classify a CloudFormation change set: does it destroy data? (#231)

Extracted from `deploy-check.sh` so it can be TESTED. It was previously inline
shell-heredoc python, described in the compendium as "fixture-validated, never
run against real CloudFormation" — and in fact validated against nothing at all,
because there were no fixtures. This is the only thing standing between an
ordinary deploy and a silently emptied subscriber table, so "probably correct"
is not the standard it needs to meet.

Usage:  inspect-change-set.py '<describe-change-set JSON>'
Exit:   0 = safe    1 = refuses (destructive, or a shape it cannot read)
"""
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

# The only values CloudFormation documents for `Replacement`. Anything else is a
# shape this parser does not understand, and on a data-holding resource that has
# to refuse rather than shrug (#231).
KNOWN_REPLACEMENT = {"True", "False", "Conditional", None}

destructive, replacements, other, unknown = [], [], [], []
for c in changes:
    r = c.get("ResourceChange", {})
    rtype, action = r.get("ResourceType", "?"), r.get("Action", "?")
    logical, repl = r.get("LogicalResourceId", "?"), r.get("Replacement")
    is_stateful = rtype in STATEFUL and not any(h in logical for h in REBUILDABLE_HINTS)
    row = f"{action:8s} {('replace=' + str(repl)):16s} {rtype:30s} {logical}"

    if is_stateful and repl not in KNOWN_REPLACEMENT:
        # A value AWS added after this was written. On a stateless resource that
        # is noise; on the subscriber table it is the exact question this script
        # exists to answer, and guessing "probably fine" is how the guard
        # approves the deploy it was built to block.
        unknown.append((row, repl))
    elif is_stateful and action == "Modify" and repl is None:
        # A Modify with no Replacement field at all. CloudFormation always sets
        # it for a Modify, so its absence means either a response-shape change or
        # a change set we misread — and the safe reading of "I cannot tell
        # whether the table is about to be replaced" is not "it isn't".
        unknown.append((row, "<missing>"))
    elif is_stateful and (action == "Remove" or repl in ("True", "Conditional")):
        destructive.append((row, r))
    elif repl == "True":
        replacements.append(row)
    else:
        other.append(row)

if unknown:
    print("\n\033[31m    ✗ REFUSING: cannot determine whether a data-holding resource is replaced\033[0m\n")
    for row, repl in unknown:
        print(f"      {row}   (Replacement={repl!r})")
    print("""
      `Replacement` was absent or carried a value this check does not recognise,
      on a resource whose loss is unrecoverable. That is a question about your
      subscriber data that nobody has answered.

      Re-read the change set by hand (`aws cloudformation describe-change-set`)
      and, if the shape has genuinely changed, update
      scripts/inspect-change-set.py — its tests are in
      packages/integration-tests/test/deploy-check.test.ts.
""")
    sys.exit(1)

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
