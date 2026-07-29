/**
 * Replaying the analytics error prefix (#186).
 *
 * Nothing reprocessed `events-errors/`, so a transform bug was permanent data
 * loss wearing the costume of a temporary diversion: Athena kept answering from
 * older partitions, just progressively emptier, and the gap surfaced weeks later
 * when someone asked why last month was blank.
 *
 * The parsing and partitioning are pure and tested here rather than discovered
 * against a live bucket — which matters because the only time this code runs is
 * during an incident, when nobody wants to be debugging the recovery tool.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  lakePartitionPrefix,
  parseFirehoseErrorOutput,
  planReplayWrites,
  type EventAnalyticsRow,
} from "@addressium/domain";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** One line of a Firehose error-output object. */
const errLine = (raw: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    attemptsMade: 1,
    arrivalTimestamp: 1_770_000_000_000,
    errorCode: "Lambda.ProcessingFailedRecord",
    errorMessage: "transform threw",
    rawData: b64(raw),
    ...over,
  });

const row = (over: Partial<EventAnalyticsRow> = {}): EventAnalyticsRow => ({
  org_id: "summit",
  campaign_id: "c1",
  subscriber_id: "s1",
  event_type: "open",
  link_id: null,
  at: "2026-07-29T12:00:00.000Z",
  event_date: "2026-07-29",
  ...over,
});

test("the original payload is recovered from rawData", () => {
  // This is the whole reason replay is possible: the datum is not lost, it is
  // filed somewhere nothing reads.
  const body = [errLine('{"eventName":"INSERT"}'), errLine('{"eventName":"MODIFY"}')].join("\n");
  const records = parseFirehoseErrorOutput(body);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.rawData, '{"eventName":"INSERT"}');
  assert.equal(records[0]!.errorCode, "Lambda.ProcessingFailedRecord");
  assert.equal(records[0]!.attemptsMade, 1);
});

test("a malformed line is skipped, not fatal", () => {
  // An error-output file is by definition written during an incident. Refusing
  // to replay ninety-nine good records because the hundredth is truncated is the
  // wrong trade — recovering most beats recovering none.
  const body = [
    errLine('{"a":1}'),
    "{not json",
    "",
    JSON.stringify({ errorCode: "x" }), // no rawData at all
    JSON.stringify({ rawData: 42 }), // rawData of the wrong type
    errLine('{"b":2}'),
  ].join("\n");
  const records = parseFirehoseErrorOutput(body);
  assert.deepEqual(records.map((r) => r.rawData), ['{"a":1}', '{"b":2}']);
});

test("an empty or whitespace-only object yields nothing rather than throwing", () => {
  assert.deepEqual(parseFirehoseErrorOutput(""), []);
  assert.deepEqual(parseFirehoseErrorOutput("\n\n  \n"), []);
});

test("a replayed row lands in the SAME partition a live one would", () => {
  // Firehose partitions dynamically by org and day. A replay that wrote anywhere
  // else would be invisible to Athena's partition projection — data restored to
  // a place nothing queries is not restored.
  assert.equal(
    lakePartitionPrefix(row()),
    "events/org_id=summit/event_date=2026-07-29/",
  );
});

test("rows are grouped into one object per partition", () => {
  const rows = [
    row({ subscriber_id: "s1" }),
    row({ subscriber_id: "s2" }),
    row({ subscriber_id: "s3", event_date: "2026-07-30", at: "2026-07-30T00:00:00.000Z" }),
    row({ subscriber_id: "s4", org_id: "other" }),
  ];
  const writes = planReplayWrites(rows, "src");
  assert.equal(writes.length, 3, "two orgs, and two days for the first");

  const first = writes.find((w) => w.key.includes("org_id=summit/event_date=2026-07-29"))!;
  assert.equal(first.body.trim().split("\n").length, 2);
  // Newline-delimited JSON, one row per line, trailing newline — the format the
  // Glue JSON SerDe reads and the one Firehose itself writes.
  assert.ok(first.body.endsWith("\n"));
  for (const line of first.body.trim().split("\n")) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test("replaying the same file twice overwrites rather than duplicating", () => {
  // On an append-only lake that distinction is the difference between a fix and
  // a second incident: a duplicated open inflates every open rate computed from
  // the partition, forever.
  const a = planReplayWrites([row()], "events-errors-processing-failed-2026-abc");
  const b = planReplayWrites([row()], "events-errors-processing-failed-2026-abc");
  assert.deepEqual(a.map((w) => w.key), b.map((w) => w.key));

  // …and two DIFFERENT source objects do not collide.
  const c = planReplayWrites([row()], "events-errors-processing-failed-2026-def");
  assert.notDeepEqual(a.map((w) => w.key), c.map((w) => w.key));
});

test("nothing to replay produces no writes", () => {
  assert.deepEqual(planReplayWrites([], "src"), []);
});
