/**
 * Which segment engine the deployment actually resolves with (#246).
 *
 * `services/sender` constructed `new GsiSegmentEngine(stores())` unconditionally,
 * and it was the ONLY non-test construction of any engine in the repo. So
 * `enableOpenSearchMirror` created a Serverless collection, turned on a DynamoDB
 * stream and ran an indexer Lambda — all billing — and nothing ever queried the
 * index. The v1 engine's two limits (`GSI_NO_ENGAGEMENT`, `GSI_NO_BASE_LIST`)
 * therefore applied *regardless of how the stack was deployed*, which made #28's
 * entire advertised payoff unreachable from the one path that sends mail.
 *
 * The tests that matter here are the ones that read the actual wiring: which
 * engine the sender builds under each flag state, and whether the save path
 * refuses what the send path cannot resolve. A test of `gsiEngineLimitation` in
 * isolation would have passed on HEAD.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  GSI_NO_BASE_LIST,
  GSI_NO_ENGAGEMENT,
  GsiSegmentEngine,
  OpenSearchSegmentEngine,
  gsiEngineLimitation,
  type SegmentPredicate,
} from "@addressium/segment";

function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "infra/cdk/lib/control-plane-stack.ts"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("could not locate workspace root");
}
const ROOT = workspaceRoot();

const engagement: SegmentPredicate = {
  match: "all",
  conditions: [
    { field: "list", op: "in", value: "ledger" },
    { field: "last_open_at", op: "before", value: "2026-01-01T00:00:00.000Z" },
  ],
};
const noBaseList: SegmentPredicate = {
  match: "all",
  conditions: [{ field: "plan", op: "eq", value: "gold" }],
};
const resolvable: SegmentPredicate = {
  match: "all",
  conditions: [
    { field: "list", op: "in", value: "ledger" },
    { field: "entitlement", op: "eq", value: "paid" },
  ],
};

// ---------------------------------------------------------------------------
// The limitation rule — one function, asked by both the save and send paths
// ---------------------------------------------------------------------------

test("gsiEngineLimitation names both v1 limits and clears what it can resolve", () => {
  assert.equal(gsiEngineLimitation(engagement), GSI_NO_ENGAGEMENT);
  assert.equal(gsiEngineLimitation(noBaseList), GSI_NO_BASE_LIST);
  assert.equal(gsiEngineLimitation(resolvable), undefined);
  // `any` fans out per condition and needs no base set, so the base-list rule
  // must not fire on it — refusing these would reject predicates that work.
  assert.equal(
    gsiEngineLimitation({ match: "any", conditions: [{ field: "plan", op: "eq", value: "gold" }] }),
    undefined,
  );
  // An explicit cohort names its members outright; no engine resolves it by query.
  assert.equal(gsiEngineLimitation({ match: "explicit", subscriberIds: ["s1"] }), undefined);
});

test("the rule agrees with what the engine actually throws", () => {
  // The point of extracting it. Two copies of this rule would put the
  // save-time/send-time disagreement straight back the first time one changed.
  const engine = new GsiSegmentEngine({
    subscriptions: { listConfirmed: async () => [] },
    subscribers: { get: async () => undefined },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  for (const [predicate, expected] of [
    [engagement, GSI_NO_ENGAGEMENT],
    [noBaseList, GSI_NO_BASE_LIST],
  ] as const) {
    assert.rejects(async () => {
      for await (const _ of engine.resolve("summit", predicate)) void _;
    }, new RegExp(expected.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")));
  }
});

test("the OpenSearch engine has neither limit — which is why the answer is per-deployment", async () => {
  const client = {
    search: async () => ({ hits: { hits: [{ _id: "summit:s1" }, { _id: "summit:s2" }] } }),
    count: async () => ({ count: 2 }),
  };
  const engine = new OpenSearchSegmentEngine(client);
  const got: string[] = [];
  // The predicate the v1 engine refuses outright.
  for await (const id of engine.resolve("summit", engagement)) got.push(id);
  assert.deepEqual(got, ["s1", "s2"]);
  assert.equal(await engine.estimate("summit", noBaseList), 2);
});

// ---------------------------------------------------------------------------
// The wiring — the only genre of test that would have failed on HEAD
// ---------------------------------------------------------------------------

const SENDER = readFileSync(resolve(ROOT, "services/sender/src/index.ts"), "utf8");
const API = readFileSync(resolve(ROOT, "services/api/src/index.ts"), "utf8");
const STACK = readFileSync(resolve(ROOT, "infra/cdk/lib/control-plane-stack.ts"), "utf8");

test("the sender chooses its engine at runtime rather than hardcoding one", () => {
  // HEAD: `let _segments: GsiSegmentEngine | undefined;` — the type itself made
  // the other engine unreachable, so this reads as source rather than behaviour.
  assert.ok(
    SENDER.includes("new OpenSearchSegmentEngine("),
    "the sender never constructs the OpenSearch engine",
  );
  assert.ok(SENDER.includes("new GsiSegmentEngine("), "the GSI engine must remain the default");
  assert.ok(
    SENDER.includes("process.env.OPENSEARCH_ENDPOINT"),
    "the sender does not consult the endpoint that decides",
  );
});

test("the save path refuses what this deployment's engine cannot resolve", () => {
  // Otherwise the console offers engagement recency, the schema accepts it, and
  // the operator finds out at SEND time from a campaign that already claimed
  // itself — a segment the product let them save.
  assert.ok(API.includes("gsiEngineLimitation("), "segmentsHandler does not consult the rule");
  assert.ok(
    API.includes('process.env.SEGMENT_ENGINE !== "opensearch"'),
    "the guard does not depend on which engine is live, so it is wrong in one of the two states",
  );
});

test("the CDK gives the sender the endpoint, the access and the index, together", () => {
  // Any one of the three missing is a runtime failure rather than a synth error:
  // no endpoint means it silently falls back to the GSI engine, no aoss grant
  // means every query 403s, and no data-access principal means the same.
  assert.ok(
    STACK.includes('senderFn.addEnvironment("OPENSEARCH_ENDPOINT"'),
    "the sender is not told where the collection is",
  );
  assert.ok(
    STACK.includes('actions: ["aoss:APIAccessAll"], resources: [collection.attrArn]'),
    "the sender cannot reach the collection",
  );
  assert.ok(
    STACK.includes("senderFn.role?.roleArn"),
    "the sender is not a principal on the collection's data-access policy",
  );
  // One expression feeds both consumers. If the API believed OpenSearch were
  // live while the sender used the GSI engine, the product would accept a
  // segment guaranteed to throw mid-campaign — #246 one layer up.
  assert.ok(
    STACK.includes('const segmentEngine = enableOpenSearchMirror ? "opensearch" : "gsi"'),
    "the engine fact is not derived from the flag that creates the collection",
  );
  assert.ok(STACK.includes("SEGMENT_ENGINE: segmentEngine"), "the API is not told which engine is live");
});
