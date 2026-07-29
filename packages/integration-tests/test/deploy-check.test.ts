/**
 * The change-set guard (#231).
 *
 * `scripts/inspect-change-set.py` is the only thing standing between an ordinary
 * `npm run deploy` and a silently emptied subscriber table. `RemovalPolicy.RETAIN`
 * governs stack DELETION and does nothing about resource REPLACEMENT: change the
 * partition key or the table name and CloudFormation creates a NEW, EMPTY table
 * and orphans the old one. Nothing is "deleted", every other check passes, and
 * every subscriber is gone from the application's point of view.
 *
 * The compendium described it as "fixture-validated, never run against real
 * CloudFormation". It was in fact validated against nothing at all — there were
 * no fixtures. These are them. They cannot prove the real `describe-change-set`
 * payload matches this shape (that needs #212's live account), but they do prove
 * the classification is right GIVEN the shape, and — the part that matters most
 * — that every way of not understanding a payload REFUSES rather than passes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "../../../../scripts/inspect-change-set.py");

/** Run the guard. Returns its exit code and output rather than throwing. */
function check(changeSet: unknown): { code: number; out: string } {
  try {
    const out = execFileSync("python3", [SCRIPT, JSON.stringify(changeSet)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const change = (over: Record<string, unknown>) => ({
  ResourceChange: {
    Action: "Modify",
    LogicalResourceId: "Table",
    ResourceType: "AWS::DynamoDB::Table",
    Replacement: "False",
    ...over,
  },
});

// ---- the case this exists for ----

test("a table replacement is REFUSED", async () => {
  // The whole reason the script exists: a new empty table, the old one orphaned,
  // RETAIN satisfied, and every subscriber gone from the app's perspective.
  const r = check({
    Changes: [
      change({
        Replacement: "True",
        Details: [
          { Target: { Attribute: "Properties", Name: "KeySchema", RequiresRecreation: "Always" } },
        ],
      }),
    ],
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /REFUSING/);
  // The cause is named, so the operator does not have to go hunting.
  assert.match(r.out, /KeySchema/);
});

test("`Conditional` is treated as dangerous, not as a maybe", async () => {
  // CloudFormation says "this MIGHT replace". On the subscriber table, a maybe
  // is a no.
  assert.equal(check({ Changes: [change({ Replacement: "Conditional" })] }).code, 1);
});

test("removing a data-holding resource is REFUSED", async () => {
  assert.equal(check({ Changes: [change({ Action: "Remove", Replacement: null })] }).code, 1);
});

test("every stateful type is covered, including the queues", async () => {
  // SQS was missing (#231): a replaced SendQueue drops every in-flight recipient
  // batch, and a replaced EventsQueue drops bounces that never reach suppression
  // — and both were classified as harmless stateless replacements, in yellow.
  for (const [type, logical] of [
    ["AWS::DynamoDB::Table", "Table"],
    ["AWS::S3::Bucket", "ArchiveBucket"],
    ["AWS::Cognito::UserPool", "AdminPool"],
    ["AWS::KMS::Key", "DataKey"],
    ["AWS::SQS::Queue", "SendQueue"],
  ]) {
    const r = check({
      Changes: [change({ ResourceType: type, LogicalResourceId: logical, Replacement: "True" })],
    });
    assert.equal(r.code, 1, `${type} was allowed to be replaced`);
  }
});

// ---- and the case where refusing everything would be useless ----

test("an ordinary deploy passes", async () => {
  // A guard that refuses every change is not a guard, it is an outage.
  const r = check({
    Changes: [
      change({ ResourceType: "AWS::Lambda::Function", LogicalResourceId: "SenderFn" }),
      change({ ResourceType: "AWS::IAM::Policy", LogicalResourceId: "SenderFnPolicy" }),
    ],
  });
  assert.equal(r.code, 0, r.out);
});

test("a stateless replacement passes, and is called out", async () => {
  const r = check({
    Changes: [
      change({
        ResourceType: "AWS::Lambda::Function",
        LogicalResourceId: "SenderFn",
        Replacement: "True",
      }),
    ],
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /REPLACED/);
});

test("the SPA buckets may be replaced — they hold build artifacts, not data", async () => {
  for (const logical of ["AdminSiteBucket1234", "PublicSiteBucketABCD"]) {
    const r = check({
      Changes: [change({ ResourceType: "AWS::S3::Bucket", LogicalResourceId: logical, Replacement: "True" })],
    });
    assert.equal(r.code, 0, `${logical}: ${r.out}`);
  }
});

test("an empty change set passes", async () => {
  const r = check({ Changes: [] });
  assert.equal(r.code, 0);
  assert.match(r.out, /no resource changes/);
});

// ---- failing CLOSED, which is the property that was missing ----

test("a change set it cannot parse REFUSES rather than passing", async () => {
  // The original failure mode was the worst possible one: a parser that found no
  // `Replacement` field printed nothing and exited 0 — the guard approving
  // exactly the deploy it exists to block.
  for (const malformed of [
    { Changes: [{ ResourceChange: "not-an-object" }] },
    { Changes: [{ ResourceChange: { Action: "Modify" } }] }, // no ResourceType
    { Changes: [{ ResourceChange: { ResourceType: "AWS::DynamoDB::Table" } }] }, // no Action
    { Changes: [{}] },
  ]) {
    const r = check(malformed);
    assert.equal(r.code, 1, `passed: ${JSON.stringify(malformed)}`);
    assert.match(r.out, /REFUSING/);
  }
});

test("an UNRECOGNISED Replacement value on a stateful resource REFUSES", async () => {
  // A value AWS adds after this was written. On a stateless resource that is
  // noise; on the subscriber table it is the exact question the script exists to
  // answer, and guessing "probably fine" is how the guard approves the deploy it
  // was built to block.
  const r = check({ Changes: [change({ Replacement: "Maybe" })] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cannot determine/i);
});

test("a Modify on a stateful resource with NO Replacement field REFUSES", async () => {
  // CloudFormation always sets it for a Modify. Its absence means the response
  // shape changed or we misread the payload — and the safe reading of "I cannot
  // tell whether the table is about to be replaced" is not "it isn't".
  const r = check({
    Changes: [
      {
        ResourceChange: {
          Action: "Modify",
          LogicalResourceId: "Table",
          ResourceType: "AWS::DynamoDB::Table",
        },
      },
    ],
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cannot determine/i);
});

test("an unrecognised Replacement on a STATELESS resource is not fatal", async () => {
  // Failing closed everywhere would make the guard unusable the first time AWS
  // adds a value — it has to be strict exactly where the stakes are.
  const r = check({
    Changes: [
      change({ ResourceType: "AWS::Lambda::Function", LogicalResourceId: "SenderFn", Replacement: "Maybe" }),
    ],
  });
  assert.equal(r.code, 0, r.out);
});

test("the refusal explains what to do next", async () => {
  // An operator hitting this is mid-deploy and needs a next step, not a verdict.
  const r = check({ Changes: [change({ Replacement: "True" })] });
  assert.match(r.out, /migration/i);
  assert.match(r.out, /RETAIN does not prevent this/i);
});

test("deploy-check.sh runs cdk where cdk.json lives", async () => {
  // `npm run deploy:check` and the root `predeploy` hook invoke the script
  // from the repo ROOT, where there is no cdk.json — a bare `npx cdk` fails
  // with "--app is required". Every cdk invocation must be anchored to
  // infra/cdk, and the config path must point inside it.
  const sh = readFileSync(resolve(here, "../../../../scripts/deploy-check.sh"), "utf8");
  const bare = sh
    .split("\n")
    .filter((l) => /^\s*npx\s+.*\bcdk\s/.test(l) && !l.trimStart().startsWith("#"));
  assert.deepEqual(bare, [], `cdk must run from infra/cdk; bare invocations:\n${bare.join("\n")}`);
  assert.match(sh, /CFG="\$CDK_DIR\/addressium\.config\.json"/);
});
