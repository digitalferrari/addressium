/**
 * An export larger than the API Gateway response limit (#293 item 1).
 *
 * The export used to be returned inline, so it failed for precisely the org big
 * enough to want one: API Gateway caps a response at 6 MB, and the file had to
 * be whole in Lambda memory to be returned at all. It streams to S3 now and the
 * response is a pointer.
 *
 * The acceptance criterion asks for a test ABOVE that limit, because a test
 * below it passes just as well against the buffering implementation and proves
 * nothing about the case that broke.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SystemClock, memStores, exportCsvChunks, exportJsonlChunks } from "@addressium/domain";
import type { Stores } from "@addressium/domain";

const ORG = "acme";
const LIST = "ledger";
const API_GATEWAY_RESPONSE_LIMIT = 6 * 1024 * 1024;

/** Enough subscribers, with enough attribute bulk, to clear 6 MB. */
async function seedLargeOrg(): Promise<Stores> {
  const stores = memStores();
  const clock = new SystemClock();
  await stores.lists.put({
    orgId: ORG, listId: LIST, name: "Ledger", optInPolicy: "double",
    fromAddress: "news@acme.example", access: "free", visibility: "open",
    complianceFooter: "footer", physicalAddress: "1 Main St",
  });
  // ~600 bytes of attributes each, so ~12k rows clears the limit comfortably
  // without making the test slow.
  const filler = "x".repeat(200);
  for (let i = 0; i < 12_000; i++) {
    const sub = `s${String(i).padStart(6, "0")}`;
    await stores.subscribers.put({
      orgId: ORG, sub, email: `reader${i}@example.com`, status: "active",
      entitlement: "free",
      attributes: { city: filler, notes: filler, tags: filler },
    });
    await stores.subscriptions.put({
      orgId: ORG, subscriberId: sub, listId: LIST, status: "confirmed",
      updatedAt: clock.now().toISOString(),
    });
  }
  return stores;
}

test("a CSV export above the 6MB response limit streams in bounded chunks", async () => {
  const stores = await seedLargeOrg();

  let total = 0;
  let largestChunk = 0;
  let chunks = 0;
  for await (const chunk of exportCsvChunks(stores, { orgId: ORG })) {
    total += Buffer.byteLength(chunk);
    largestChunk = Math.max(largestChunk, Buffer.byteLength(chunk));
    chunks++;
  }

  assert.ok(
    total > API_GATEWAY_RESPONSE_LIMIT,
    `the fixture must exceed the limit to be meaningful: ${total} bytes`,
  );
  // The property that matters: no single chunk approaches the limit, so the
  // writer never has to hold the file. A buffering implementation would yield
  // one chunk of `total` bytes and fail here.
  assert.ok(
    largestChunk < 64 * 1024,
    `a chunk was ${largestChunk} bytes — the export is buffering, not streaming`,
  );
  assert.ok(chunks > 1000, `expected many chunks, got ${chunks}`);
});

test("a JSONL export above the limit streams the same way", async () => {
  const stores = await seedLargeOrg();

  let total = 0;
  let largestChunk = 0;
  for await (const chunk of exportJsonlChunks(stores, { orgId: ORG })) {
    total += Buffer.byteLength(chunk);
    largestChunk = Math.max(largestChunk, Buffer.byteLength(chunk));
  }

  assert.ok(total > API_GATEWAY_RESPONSE_LIMIT, `${total} bytes`);
  assert.ok(largestChunk < 64 * 1024, `a chunk was ${largestChunk} bytes`);
});

test("every subscriber appears exactly once in a large export", async () => {
  // Streaming is only useful if it is also complete. A paging bug that dropped
  // or duplicated a page would be invisible to the size assertions above.
  const stores = await seedLargeOrg();
  const seen = new Set<string>();
  let lines = 0;
  let buffer = "";
  for await (const chunk of exportJsonlChunks(stores, { orgId: ORG })) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      lines++;
      seen.add((JSON.parse(line) as { email: string }).email);
    }
  }
  assert.equal(lines, 12_000, "every subscriber is exported");
  assert.equal(seen.size, 12_000, "no duplicates");
});
