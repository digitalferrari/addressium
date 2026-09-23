/**
 * Service-level: `POST /campaigns/schedule` must WRITE THE CAMPAIGN RECORD (#221).
 *
 * The console's "Compose & schedule" screen is a self-contained form — it posts
 * the subject, audience and body straight to this route and never calls `POST
 * /campaigns` first. The route created the EventBridge schedule and the
 * lifecycle record and stopped there, so a one-off scheduled with "Send now" had
 * no `CAMPAIGNREC#<id>` item at all, and everything keyed on one silently did
 * nothing: `appendEvent`'s counter Update is guarded by `attribute_exists(pk)`
 * (it must never resurrect a campaign), so every sent/delivered/open took the
 * record-less fallback — event kept, counter skipped — and the report screen's
 * preferred source, the STORED counters, stayed empty forever. Two real
 * campaigns were sent through a deployed stack with event rows on disk and no
 * campaign row behind them.
 *
 * Nothing caught it because no test had ever driven this route. Route-parity
 * checks assert the key exists in the CDK and the router table, which an empty
 * handler body satisfies; the adapter tests stub the wire and prove the counter
 * Update is well-formed, which it always was. The missing assertion is the one
 * below: schedule a send the way the console does, then read the record back.
 *
 * Driven through the exported handler against a real DynamoDB API (dynalite)
 * with real `DynamoStores`, only the EventBridge Scheduler swapped — it has no
 * local emulator, and it is the reason this route had no end-to-end test.
 *
 * The counter assertions go through `stores.events.append`, NOT a hand-written
 * `campaigns.put`, so they fail for the real reason before the fix: dynalite
 * implements no TransactWriteItems, so `DynamoStores` runs its degraded
 * non-transactional path here and the counters are asserted against the memory
 * store, whose documented semantic is the same one the guard encodes ("never
 * resurrect a campaign that does not exist", memory.ts).
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import type { Campaign, Organization } from "@addressium/core";
import { DynamoStores } from "@addressium/adapters-aws";
import { memStores, SystemClock, recordScheduledCampaign, recordSeriesEdition, type CampaignScheduler, type SendDescriptor } from "@addressium/domain";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynalite = require("dynalite") as (opts?: unknown) => any;

const TABLE = "addressium-schedule-record";
const ORG = "summit";
const LIST = "ledger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let api: typeof import("@addressium/svc-api");
let stores: DynamoStores;

/** Stands in for EventBridge Scheduler, which has no local emulator. */
class CaptureScheduler implements CampaignScheduler {
  public oneOff: Array<{ name: string; at: Date; descriptor: SendDescriptor }> = [];
  public recurring: Array<{ name: string; cron: string; timezone: string; payload: unknown }> = [];
  async scheduleOneOff(input: { name: string; at: Date; descriptor: SendDescriptor }) {
    this.oneOff.push(input);
  }
  async scheduleRecurring(input: { name: string; cron: string; timezone: string; payload: unknown }) {
    this.recurring.push({ name: input.name, cron: input.cron, timezone: input.timezone, payload: input.payload });
  }
  async cancel() {}
}

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint;
  process.env.AWS_REGION ??= "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "local";
  process.env.AWS_SECRET_ACCESS_KEY = "local";
  process.env.TABLE_NAME = TABLE;
  // Deliberately no SCHEDULER_* envs: every test here injects a scheduler, so a
  // regression that reached for the real client would fail loudly rather than
  // quietly talking to AWS.

  const throughput = { ReadCapacityUnits: 1, WriteCapacityUnits: 1 };
  const gsi = (n: string) => ({
    IndexName: n,
    KeySchema: [
      { AttributeName: `${n}pk`, KeyType: "HASH" as const },
      { AttributeName: `${n}sk`, KeyType: "RANGE" as const },
    ],
    Projection: { ProjectionType: "ALL" as const },
    ProvisionedThroughput: throughput,
  });
  const client = new DynamoDBClient({
    endpoint,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  await client.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PROVISIONED",
      ProvisionedThroughput: throughput,
      AttributeDefinitions: ["pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk", "gsi3pk", "gsi3sk"].map(
        (AttributeName) => ({ AttributeName, AttributeType: "S" as const }),
      ),
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" as const },
        { AttributeName: "sk", KeyType: "RANGE" as const },
      ],
      GlobalSecondaryIndexes: [gsi("gsi1"), gsi("gsi2"), gsi("gsi3")],
    }),
  );

  stores = new DynamoStores(TABLE, client);
  const org: Organization = {
    orgId: ORG,
    name: "Summit",
    domains: ["example.com"],
    defaultTimezone: "America/Denver",
  } as Organization;
  await stores.organizations.put(org);

  api = await import("@addressium/svc-api");
});

after(() => server?.close());

/** A POST event, authorized as `role` unless told otherwise. */
function scheduleEvent(body: Record<string, unknown>, role = "developer_admin", orgs = ORG) {
  return {
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "POST", sourceIp: "203.0.113.7" },
      authorizer: { jwt: { claims: { "custom:role": role, "custom:orgs": orgs, sub: "admin-1" } } },
    },
  };
}

/** Exactly what the console's Compose screen posts for a "Send now" one-off. */
const composeBody = (campaignId: string, extra: Record<string, unknown> = {}) => ({
  orgId: ORG,
  campaignId,
  listId: LIST,
  subject: "Weekly ledger",
  template: { blocks: [{ kind: "text", html: "<p>Hello</p>" }] },
  when: { type: "now" },
  ...extra,
});

test('"Send now" writes the campaign record the counters are keyed on', async () => {
  const scheduler = new CaptureScheduler();
  const res = await api.scheduleCampaignHandler(scheduleEvent(composeBody("counters-check")), { scheduler });

  assert.equal(res.statusCode, 202);
  assert.equal(scheduler.oneOff.length, 1, "the send is still scheduled");

  // THE assertion. Before the fix this is undefined: the route wrote an
  // EventBridge schedule and a lifecycle record and nothing else, so the item
  // `appendEvent` increments did not exist and never would.
  const campaign = await stores.campaigns.get(ORG, "counters-check");
  assert.ok(campaign, "POST /campaigns/schedule must create the CAMPAIGNREC# row");
  assert.equal(campaign.orgId, ORG);
  assert.equal(campaign.campaignId, "counters-check");
  assert.equal(campaign.subject, "Weekly ledger");
  assert.equal(campaign.type, "one_off");
  assert.equal(campaign.status, "scheduled");
  assert.deepEqual(campaign.audience, { listId: LIST });
  assert.deepEqual(campaign.counters, {
    sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0,
    unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0,
  });
  // Placed at least 5 minutes out (§4.6) and stamped with the org's zone, so the
  // Schedules view and the record agree on when this goes.
  assert.equal(campaign.schedule?.sendAt, scheduler.oneOff[0]!.at.toISOString());
  assert.equal(campaign.schedule?.timezone, "America/Denver");

  // ...and the lifecycle record still lands, keyed on the same id.
  const state = await stores.schedules.get(ORG, "counters-check");
  assert.equal(state?.kind, "one_off");
  assert.equal(state?.status, "active");
  // ...carrying the SAME instant as the campaign row and the EventBridge
  // schedule (#248). The Schedules view lists these lifecycle records, not
  // campaigns, and it is the screen the Pause button lives on — so the time the
  // five-minute window (§4.6) is counting down has to be here, not only on the
  // campaign. Without it the row read "Cadence: —".
  assert.equal(state?.sendAt, scheduler.oneOff[0]!.at.toISOString());
  assert.equal(state?.sendAt, campaign.schedule?.sendAt, "the two records must agree");
  assert.equal(state?.timezone, "America/Denver");
});

test("the scheduled campaign appears in the console's report picker", async () => {
  // `campaignsListHandler` projects `campaigns.list`. With no record the picker
  // was empty, so an operator could not select the send they had just scheduled
  // even though its events were on disk.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("picker-check")), { scheduler });

  const res = await api.campaignsListHandler({
    pathParameters: { org: ORG },
    requestContext: {
      http: { method: "GET" },
      authorizer: { jwt: { claims: { "custom:role": "developer_admin", "custom:orgs": ORG, sub: "admin-1" } } },
    },
  });
  assert.equal(res.statusCode, 200);
  const rows = JSON.parse(res.body) as Array<{ campaignId: string; subject: string; listId: string; sent: number }>;
  const row = rows.find((r) => r.campaignId === "picker-check");
  assert.ok(row, "a scheduled campaign must be listable");
  assert.equal(row.subject, "Weekly ledger");
  assert.equal(row.listId, LIST);
  assert.equal(row.sent, 0);
});

test("a segment-targeted send records the segment it was aimed at", async () => {
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("segment-check", { segmentId: "engaged" })),
    { scheduler },
  );

  const campaign = await stores.campaigns.get(ORG, "segment-check");
  assert.deepEqual(campaign?.audience, { listId: LIST, segmentId: "engaged" });
  // The descriptor still carries it too (#203) — the record is additional, not a
  // replacement for what the sender is told.
  assert.equal(scheduler.oneOff[0]!.descriptor.segmentId, "engaged");
});

test("a recurring series is recorded with no single send time", async () => {
  const scheduler = new CaptureScheduler();
  const res = await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("daily", { when: { type: "recurring", cron: "cron(0 13 * * ? *)" } })),
    { scheduler },
  );

  assert.equal(res.statusCode, 202);
  const campaign = await stores.campaigns.get(ORG, "daily");
  assert.ok(campaign, "the series parent is listable like any other campaign");
  assert.equal(campaign.schedule, undefined, "a series has no one send time — its cron is on the lifecycle record");
  assert.equal(scheduler.recurring[0]?.timezone, "America/Denver", "org defaultTimezone (§4.21)");
  const state = await stores.schedules.get(ORG, "daily");
  assert.equal(state?.kind, "recurring");
  assert.equal(state?.cron, "cron(0 13 * * ? *)");
  // No `sendAt` on a series, for the same reason the campaign has no
  // `schedule`: there is no single instant to point at (#248).
  assert.equal(state?.sendAt, undefined);
  const payload = scheduler.recurring[0]?.payload as { descriptor?: { seriesId?: string } } | undefined;
  assert.equal(
    payload?.descriptor?.seriesId,
    undefined,
    "an inline recurring campaign is not a CampaignSeries registry row; the sender must not require one",
  );
});

test("re-scheduling a campaign that has already sent does not wipe its counters", async () => {
  // The trap in fixing this: rebuilding the record from the schedule payload
  // alone would zero a resent campaign's numbers, turning the fix into a report
  // wipe — the same class of bug as #201, where an edit dropped the schedule.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("resend")), { scheduler });
  const first = await stores.campaigns.get(ORG, "resend");
  await stores.campaigns.put({ ...first!, status: "sent", counters: { ...first!.counters, sent: 42, opens: 7 } });

  await api.scheduleCampaignHandler(scheduleEvent(composeBody("resend", { subject: "Weekly ledger, again" })), { scheduler });

  const again = await stores.campaigns.get(ORG, "resend");
  assert.equal(again?.counters.sent, 42, "a reschedule must not reset counters");
  assert.equal(again?.counters.opens, 7);
  assert.equal(again?.subject, "Weekly ledger, again", "...but the new subject is taken");
  assert.equal(again?.status, "scheduled", "and it is scheduled again");
});

test("re-scheduling a HALTED campaign does not un-halt it", async () => {
  // For a campaign that has a record, `status: "halted"` is the whole halt:
  // `checkDeliverability` flips this field and writes no HaltStore marker when
  // there is a row to flip (alerts.ts), and `sendCampaign`'s gate reads exactly
  // it (send.ts). So stamping "scheduled" unconditionally would let an operator
  // clear a bounce/complaint halt by pressing Send again — silently.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("halted-send")), { scheduler });
  const before = await stores.campaigns.get(ORG, "halted-send");
  await stores.campaigns.put({ ...before!, status: "halted" });

  const res = await api.scheduleCampaignHandler(scheduleEvent(composeBody("halted-send")), { scheduler });

  assert.equal(res.statusCode, 202);
  const after = await stores.campaigns.get(ORG, "halted-send");
  assert.equal(after?.status, "halted", "a deliverability halt must survive a reschedule");
});

test("re-scheduling a one-off as recurring clears the stale send time", async () => {
  // `...existing` spreads the previous `schedule` back in, so without an explicit
  // clear the series keeps advertising a `sendAt` it will never send at — the
  // column `campaignsListHandler` shows the operator.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("was-oneoff")), { scheduler });
  assert.ok((await stores.campaigns.get(ORG, "was-oneoff"))?.schedule?.sendAt);

  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("was-oneoff", { when: { type: "recurring", cron: "cron(0 13 * * ? *)" } })),
    { scheduler },
  );

  assert.equal(
    (await stores.campaigns.get(ORG, "was-oneoff"))?.schedule,
    undefined,
    "a series must not keep the one-off send time it was converted from",
  );
});

test("an empty-string timezone falls back to the org default, not through to AWS", async () => {
  // `timezone` is `z.string().optional()` with no `.min(1)`, so "" is a valid
  // payload. `??` would have passed it to ScheduleExpressionTimezone verbatim.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("blank-zone", { when: { type: "recurring", cron: "cron(0 13 * * ? *)", timezone: "" } })),
    { scheduler },
  );

  assert.equal(scheduler.recurring[0]?.timezone, "America/Denver");
});

test("the route is still gated on campaigns:schedule, and writes nothing when refused", async () => {
  const scheduler = new CaptureScheduler();
  for (const role of ["analyst", "support"]) {
    const res = await api.scheduleCampaignHandler(scheduleEvent(composeBody("denied"), role), { scheduler });
    assert.equal(res.statusCode, 403, `${role} must not be able to schedule a send`);
  }
  // Same role, another org — scope still binds.
  const wrongOrg = await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("denied"), "developer_admin", "other"),
    { scheduler },
  );
  assert.equal(wrongOrg.statusCode, 403);

  // No claims at all — the shape an unauthenticated caller arrives in.
  const anonymous = await api.scheduleCampaignHandler({ body: JSON.stringify(composeBody("denied")) }, { scheduler });
  assert.equal(anonymous.statusCode, 403);

  assert.equal(await stores.campaigns.get(ORG, "denied"), undefined, "a refused request must write no record");
  assert.deepEqual(scheduler.oneOff, [], "and schedule nothing");

  // An editor DOES hold campaigns:schedule (rbac roles.ts), so it is allowed —
  // asserted so the boundary is visible rather than assumed, and so a future
  // narrowing of the role has to change this line deliberately.
  const editor = await api.scheduleCampaignHandler(scheduleEvent(composeBody("editor-send"), "editor"), { scheduler });
  assert.equal(editor.statusCode, 202);
  assert.ok(await stores.campaigns.get(ORG, "editor-send"), "and its record is written like any other");
});

test("with the record present, engagement events actually move the stored counters", async () => {
  // The end of the chain, and the symptom the deployment showed: event rows on
  // disk, counters frozen at zero. `appendEvent` refuses to resurrect a campaign
  // that does not exist — so this passes only because the schedule route now
  // creates one. Asserted against the memory store, which encodes that same
  // semantic explicitly ("never resurrect a campaign that does not exist"), and
  // whose counter path is not the degraded one dynalite forces on DynamoStores.
  const mem = memStores();
  await mem.organizations.put({ orgId: ORG, name: "Summit", domains: ["example.com"] } as Organization);
  await recordScheduledCampaign(mem, {
    orgId: ORG,
    campaignId: "live-counters",
    subject: "Weekly ledger",
    listId: LIST,
    sendAt: new SystemClock().now().toISOString(),
    timezone: "UTC",
  });

  const at = "2026-09-14T12:00:00.000Z";
  await mem.events.append({ orgId: ORG, campaignId: "live-counters", subscriberId: "s1", type: "sent", at, eventId: "e1" });
  await mem.events.append({ orgId: ORG, campaignId: "live-counters", subscriberId: "s1", type: "delivered", at, eventId: "e2" });
  await mem.events.append({ orgId: ORG, campaignId: "live-counters", subscriberId: "s1", type: "open", at, eventId: "e3" });

  const campaign = (await mem.campaigns.get(ORG, "live-counters")) as Campaign;
  assert.equal(campaign.counters.sent, 1, "the counter the record-less fallback used to skip");
  assert.equal(campaign.counters.delivered, 1);
  assert.equal(campaign.counters.opens, 1);

  // The control: an arbitrary unknown id still cannot resurrect a campaign row.
  // Recurring editions now create their own durable rows before enqueueing, so
  // this deliberately uses an id that no scheduler could have authored.
  for (const [i, type] of (["sent", "delivered", "open"] as const).entries()) {
    await mem.events.append({ orgId: ORG, campaignId: "unknown-campaign-id", subscriberId: "s1", type, at, eventId: `x${i}` });
  }
  assert.equal(await mem.campaigns.get(ORG, "unknown-campaign-id"), undefined, "an unknown id must stay record-less");
  assert.equal((await mem.events.all(ORG, "unknown-campaign-id")).length, 3, "...while its events are still kept");
});

test("a recurring edition is durably tied to its parent series for aggregation", async () => {
  const mem = memStores();
  await mem.campaigns.put({
    orgId: ORG,
    campaignId: "weekly-ledger",
    type: "series_edition",
    seriesId: "weekly-ledger",
    subject: "Weekly ledger",
    templateId: "newsletter",
    audience: { listId: LIST },
    status: "scheduled",
    counters: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0, rejects: 0, renderingFailures: 0, deliveryDelays: 0 },
  });
  await recordSeriesEdition(mem, {
    orgId: ORG,
    seriesId: "weekly-ledger",
    campaignId: "weekly-ledger-2026091512",
    subject: "Markets rally",
    listId: LIST,
  });
  await mem.events.append({ orgId: ORG, campaignId: "weekly-ledger-2026091512", subscriberId: "s1", type: "sent", at: "2026-09-15T12:00:00.000Z", eventId: "edition-sent" });
  const edition = await mem.campaigns.get(ORG, "weekly-ledger-2026091512");
  assert.equal(edition?.type, "series_edition");
  assert.equal(edition?.seriesId, "weekly-ledger");
  assert.equal(edition?.counters.sent, 1);
});

/**
 * The structured body is kept when a campaign is scheduled (#298).
 *
 * Nothing reads it yet — the just-in-time series read (#303), duplicate (#307)
 * and revise (#312) all depend on it existing first. It is written now so that
 * by the time those land the population is already there rather than starting
 * empty, and so this write can be proven correct on its own.
 *
 * Why it cannot come from the existing archive: `EmailArchive` holds the
 * RENDERED html of a campaign that already sent — merge values resolved, series
 * ad fills applied, block kinds flattened into anchors. It answers "what did
 * subscribers receive". Only this answers "what did the operator compose", and
 * only this can be loaded back into an editor.
 */
test("scheduling a one-off keeps its structured body", async () => {
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("body-oneoff")), { scheduler });

  const saved = await stores.campaignBodies.get(ORG, "body-oneoff");
  assert.ok(saved, "a one-off must keep its body");
  assert.equal(saved.subject, "Weekly ledger");
  assert.equal(saved.listId, LIST);
  assert.deepEqual(saved.template, { blocks: [{ kind: "text", html: "<p>Hello</p>" }] });
  assert.equal(saved.rootCampaignId, "body-oneoff", "an original roots at itself");
  assert.equal(saved.version, 1);
  assert.ok(saved.savedAt, "must be stamped");
});

test("scheduling a recurring series keeps its body too", async () => {
  // The series path is the one that most needs this: its body is otherwise
  // frozen into the EventBridge payload at schedule time and unreachable.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("body-series", { when: { type: "recurring", cron: "cron(0 13 * * ? *)" } })),
    { scheduler },
  );

  const saved = await stores.campaignBodies.get(ORG, "body-series");
  assert.ok(saved, "a series must keep its body");
  assert.deepEqual(saved.template, { blocks: [{ kind: "text", html: "<p>Hello</p>" }] });
});

test("the SANITIZED template is stored, not the raw request body", async () => {
  // The stored body is what a re-send or a re-open would use, so storing the
  // unsanitized input would let a later path bypass the hardening this route
  // just applied.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(
      composeBody("body-sanitized", {
        template: { html: '<p>ok</p><script>alert(1)</script>' },
      }),
    ),
    { scheduler },
  );

  const saved = await stores.campaignBodies.get(ORG, "body-sanitized");
  assert.ok(saved);
  assert.ok(saved.template.html, "raw html mode round-trips as html");
  assert.ok(!/<script/i.test(saved.template.html), "the script tag must not survive into storage");
});

test("editorSource is kept so an MJML campaign can be re-opened as MJML", async () => {
  // MJML is compiled in the browser and only the compiled html reaches the
  // server, so without this a re-opened campaign hands the operator html and
  // their source is gone.
  const scheduler = new CaptureScheduler();
  const mjml = "<mjml><mj-body><mj-text>Hi</mj-text></mj-body></mjml>";
  await api.scheduleCampaignHandler(
    scheduleEvent(
      composeBody("body-mjml", {
        template: { mjmlHtml: "<p>Hi</p>" },
        editorSource: { mode: "mjml", mjml },
      }),
    ),
    { scheduler },
  );

  const saved = await stores.campaignBodies.get(ORG, "body-mjml");
  assert.ok(saved);
  assert.equal(saved.editorSource?.mode, "mjml");
  assert.equal(saved.editorSource?.mjml, mjml, "the source must survive verbatim");
  assert.equal(saved.template.html, "<p>Hi</p>", "but we still SEND the compiled html");
});

test("previewText is kept when supplied and absent when not", async () => {
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("body-preheader", { previewText: "This week: the ledger" })),
    { scheduler },
  );
  const withText = await stores.campaignBodies.get(ORG, "body-preheader");
  assert.equal(withText?.previewText, "This week: the ledger");

  await api.scheduleCampaignHandler(scheduleEvent(composeBody("body-no-preheader")), { scheduler });
  const without = await stores.campaignBodies.get(ORG, "body-no-preheader");
  assert.equal(without?.previewText, undefined, "an absent preheader is absent, not empty string");
});

test("re-scheduling the same id keeps its lineage", async () => {
  // Revise (#312) is what increments the version. Re-scheduling the same id is
  // an overwrite, and must not look like a new root or a new version.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("body-lineage")), { scheduler });
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("body-lineage", { subject: "Weekly ledger, corrected" })),
    { scheduler },
  );

  const saved = await stores.campaignBodies.get(ORG, "body-lineage");
  assert.equal(saved?.subject, "Weekly ledger, corrected", "the newer body wins");
  assert.equal(saved?.rootCampaignId, "body-lineage");
  assert.equal(saved?.version, 1, "an overwrite is not a revision");
});

test("the body is a sibling item, not a field on the campaign record", async () => {
  // `appendEvent` issues an UpdateItem against the campaign record for EVERY
  // engagement event, and DynamoDB bills those on full item size. A body stored
  // there would multiply the write cost of every open and click.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("body-sibling")), { scheduler });

  const campaign = await stores.campaigns.get(ORG, "body-sibling");
  assert.ok(campaign, "the campaign record still exists");
  assert.ok(
    !("template" in campaign) && !("body" in campaign),
    "the campaign record must not carry the body",
  );
  assert.ok(await stores.campaignBodies.get(ORG, "body-sibling"), "the body lives beside it");
});
