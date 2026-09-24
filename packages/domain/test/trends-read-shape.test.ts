/**
 * The trends endpoint must not read serially, or count by reading (#294).
 *
 * It is the first screen loaded after login, so every avoidable round trip is
 * felt directly. Two problems, both measured on the live dev stack at 541-1400ms
 * warm (the public directory, after the same memory fix, was 12-40ms):
 *
 *  1. one `events.all` per campaign, in a sequential `for` loop;
 *  2. a full `subscribers.stream()` consumed ONLY to increment a counter —
 *     every subscriber marshalled out of DynamoDB, across the network and
 *     deserialized, then discarded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { memStores } from "@addressium/domain";
import type { Stores } from "@addressium/domain";

const ORG = "acme";

/** memStores that records HOW its reads were issued. */
function instrumented(): Stores & { concurrentPeak: number; streamed: number; counted: number } {
  const stores = memStores() as Stores & { concurrentPeak: number; streamed: number; counted: number };
  stores.concurrentPeak = 0;
  stores.streamed = 0;
  stores.counted = 0;

  let inFlight = 0;
  const realAll = stores.events.all.bind(stores.events);
  stores.events.all = async (o: string, c: string) => {
    inFlight++;
    stores.concurrentPeak = Math.max(stores.concurrentPeak, inFlight);
    // A microtask boundary, so sequential awaits never overlap and parallel
    // ones do — which is exactly the distinction under test.
    await Promise.resolve();
    const r = await realAll(o, c);
    inFlight--;
    return r;
  };

  const realStream = stores.subscribers.stream.bind(stores.subscribers);
  stores.subscribers.stream = (o: string) => {
    stores.streamed++;
    return realStream(o);
  };
  const realCount = stores.subscribers.count.bind(stores.subscribers);
  stores.subscribers.count = async (o: string) => {
    stores.counted++;
    return realCount(o);
  };
  return stores;
}

async function seed(stores: Stores, campaigns: number, subscribers: number) {
  for (let i = 0; i < campaigns; i++) {
    await stores.campaigns.put({
      orgId: ORG, campaignId: `c${i}`, listId: "l", subject: "s",
      status: "sent", type: "one_off",
      counters: { sent:0,delivered:0,opens:0,clicks:0,bounces:0,complaints:0,unsubscribes:0,rejects:0,renderingFailures:0,deliveryDelays:0 },
    } as never);
  }
  for (let i = 0; i < subscribers; i++) {
    await stores.subscribers.put({
      orgId: ORG, sub: `s${i}`, email: `r${i}@x.example`, status: "active",
      entitlement: "free", attributes: {},
    } as never);
  }
}

test("the trends handler issues its per-campaign reads in parallel", async () => {
  // Asserted against the HANDLER's own source, not a copy of the pattern here:
  // a test that re-implements the shape it is checking passes whatever the
  // handler actually does.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");

  let dir = dirname(fileURLToPath(import.meta.url));
  let root = "";
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { workspaces?: unknown };
      if (pkg.workspaces) { root = dir; break; }
    } catch { /* keep walking */ }
    dir = dirname(dir);
  }
  assert.ok(root, "workspace root not found");

  const src = readFileSync(resolve(root, "services/reporting/src/index.ts"), "utf8");
  const handler = src.slice(src.indexOf("export async function trendsHandler"), src.indexOf("export interface SeriesReportEvent"));

  assert.ok(
    /Promise\.all\(campaigns\.map\(/.test(handler),
    "per-campaign event reads are not parallelised — the cost is the SUM of every read, not the slowest",
  );
  assert.ok(
    !/for \(const campaign of[\s\S]{0,200}await stores\(\)\.events\.all/.test(handler),
    "a sequential per-campaign loop is back",
  );
  assert.ok(
    /subscribers\.count\(/.test(handler) && !/subscribers\.stream\(/.test(handler),
    "subscribers are being streamed to produce a count again",
  );
});

test("counting subscribers does not materialize them", async () => {
  const stores = instrumented();
  await seed(stores, 1, 50);

  const n = await stores.subscribers.count(ORG);

  assert.equal(n, 50);
  assert.equal(stores.counted, 1, "count() must be the thing called");
  assert.equal(stores.streamed, 0, "stream() reads every row — it must not be used to count");
});
