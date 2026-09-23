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

function getEvent(campaignId: string, role = "developer_admin", orgs = ORG) {
  return {
    pathParameters: { org: ORG, id: campaignId },
    requestContext: {
      http: { method: "GET", sourceIp: "203.0.113.7" },
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
  // Updated by #314. This used to assert `seriesId` was UNSET, because
  // stamping it with no registry row made the sender throw `unknown campaign
  // series` and dead-letter every recurring schedule. The guard was right and
  // the missing row was the bug: without one, series-wide ad fills could never
  // apply, and the Ad tags screen wrote fills nothing on the live path read.
  // The route now creates the row and stamps the id, so the sender finds it.
  const payload = scheduler.recurring[0]?.payload as { descriptor?: { seriesId?: string } } | undefined;
  assert.equal(
    payload?.descriptor?.seriesId,
    "daily",
    "the sender needs this to find the series and apply its ad fills",
  );
  assert.ok(
    await stores.series.get(ORG, "daily"),
    "and the registry row it points at must exist, or the send throws",
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

/**
 * A recurring schedule gets a `CampaignSeries` registry row (#314).
 *
 * Without one, series-wide ad fills could never apply: `sendCampaign` reads the
 * series only when `descriptor.seriesId` is set, and the route deliberately
 * never set it — because stamping an id with no row made the sender throw
 * `unknown campaign series` and dead-letter every recurring schedule. The guard
 * was right; the missing row was the bug. Meanwhile the Ad tags screen wrote
 * fills that nothing on the live path ever read.
 */
test("a recurring schedule creates its series registry row", async () => {
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("series-row", { when: { type: "recurring", cron: "cron(0 13 * * ? *)" } })),
    { scheduler },
  );

  const series = await stores.series.get(ORG, "series-row");
  assert.ok(series, "the registry row must exist, or ad fills can never apply");
  assert.equal(series.seriesId, "series-row");
  assert.deepEqual(series.adSlotFills, [], "a new series starts with no fills");
});

test("the descriptor is stamped with the series id", async () => {
  // This is what makes `sendCampaign` read the series and apply its fills.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("series-stamp", { when: { type: "recurring", cron: "cron(0 13 * * ? *)" } })),
    { scheduler },
  );

  const payload = scheduler.recurring[0]?.payload as { descriptor?: { seriesId?: string } };
  assert.equal(payload?.descriptor?.seriesId, "series-stamp");
});

test("re-scheduling never clobbers ad fills an operator configured", async () => {
  // This route runs again on every re-schedule of the same id. Overwriting the
  // fills would silently drop sold placements.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("series-fills", { when: { type: "recurring", cron: "cron(0 13 * * ? *)" } })),
    { scheduler },
  );
  const created = await stores.series.get(ORG, "series-fills");
  await stores.series.put({
    ...created!,
    adSlotFills: [
      { slot: "ad_top", html: "<AD>", binding: { kind: "series", seriesId: "series-fills" }, version: 1 },
    ],
  });

  // Re-schedule: same id, edited subject.
  await api.scheduleCampaignHandler(
    scheduleEvent(
      composeBody("series-fills", {
        subject: "Edited",
        when: { type: "recurring", cron: "cron(0 13 * * ? *)" },
      }),
    ),
    { scheduler },
  );

  const after = await stores.series.get(ORG, "series-fills");
  assert.equal(after?.adSlotFills.length, 1, "configured fills must survive a re-schedule");
  assert.equal(after?.adSlotFills[0]?.html, "<AD>");
});

test("a one-off gets no series row", async () => {
  // Series-wide fills are for series. A one-off carries its ads inline.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("no-series")), { scheduler });
  assert.equal(await stores.series.get(ORG, "no-series"), undefined);
});

/**
 * The content route, for re-opening a campaign in Compose (#307).
 *
 * Distinct from the archive route: that returns RENDERED html of a campaign
 * that already sent — merge values resolved, ad fills applied, block kinds
 * flattened into anchors. It answers "what did subscribers receive"; this
 * answers "what did the operator compose", and only this can be loaded back
 * into an editor.
 */
test("the content route returns the structured body", async () => {
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("content-read", { previewText: "Preview line" })),
    { scheduler },
  );

  const res = await api.campaignContentHandler(getEvent("content-read"));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as { subject: string; previewText?: string; template: unknown };
  assert.equal(body.subject, "Weekly ledger");
  assert.equal(body.previewText, "Preview line");
  assert.deepEqual(body.template, { blocks: [{ kind: "text", html: "<p>Hello</p>" }] });
});

test("MJML comes back as MJML, not as the compiled html", async () => {
  // Without `editorSource` a re-opened campaign would land in the Raw HTML
  // editor with the operator's source gone.
  const scheduler = new CaptureScheduler();
  const mjml = "<mjml><mj-body><mj-text>Hi</mj-text></mj-body></mjml>";
  await api.scheduleCampaignHandler(
    scheduleEvent(
      composeBody("content-mjml", {
        template: { mjmlHtml: "<p>Hi</p>" },
        editorSource: { mode: "mjml", mjml },
      }),
    ),
    { scheduler },
  );

  const res = await api.campaignContentHandler(getEvent("content-mjml"));
  const body = JSON.parse(res.body) as { editorSource?: { mode: string; mjml?: string } };
  assert.equal(body.editorSource?.mode, "mjml");
  assert.equal(body.editorSource?.mjml, mjml);
});

test("a campaign with no stored body is distinguished from one that does not exist", async () => {
  // "not found" for a campaign that predates body storage would read as data
  // loss. The console needs to say "compose it again" instead.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("content-legacy")), { scheduler });
  // Simulate a pre-#298 campaign: the record exists, the body does not.
  await stores.campaignBodies.put({
    orgId: ORG,
    campaignId: "content-legacy",
    template: { blocks: [] },
    subject: "x",
    rootCampaignId: "content-legacy",
    version: 1,
    savedAt: "t",
  });
  const real = await api.campaignContentHandler(getEvent("content-legacy"));
  assert.equal(real.statusCode, 200, "a stored body is returned");

  const missing = await api.campaignContentHandler(getEvent("no-such-campaign"));
  assert.equal(missing.statusCode, 404);
  assert.equal(JSON.parse(missing.body).error, "not found", "an unknown campaign is plainly not found");
});

test("reading a body requires campaigns:manage, not merely reports:view", async () => {
  // The body is what an operator edits, and it carries unrendered template
  // markup including ad tags — not a report an analyst reads.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("content-rbac")), { scheduler });

  const res = await api.campaignContentHandler(getEvent("content-rbac", "analyst"));
  assert.equal(res.statusCode, 403);
});

/**
 * Sending a recurring series off-cycle (#305).
 *
 * The operator need: a morning newsletter went out before someone updated the
 * feed, so it must run again later the same day with everything current.
 *
 * Deliberately not a cadence edit — rescheduling the cron to 10am and back
 * needs `scheduler:UpdateSchedule` and relies on the operator remembering to
 * set it back. This needs no IAM change and cannot be forgotten.
 */
/** Stands in for SQS, which has no local emulator — same shape as CaptureScheduler. */
class CaptureQueue {
  public enqueued: SendDescriptor[] = [];
  async enqueue(d: SendDescriptor) {
    this.enqueued.push(d);
  }
}

const sendNowEvent = (seriesId: string, role = "developer_admin", orgs = ORG) => ({
  body: JSON.stringify({ orgId: ORG, seriesId }),
  requestContext: {
    http: { method: "POST", sourceIp: "203.0.113.7" },
    authorizer: { jwt: { claims: { "custom:role": role, "custom:orgs": orgs, sub: "admin-1" } } },
  },
});

test("send-now queues an off-cycle edition of the series", async () => {
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("sn-basic", { when: { type: "recurring", cron: "cron(0 6 * * ? *)" } })),
    { scheduler },
  );

  const queue = new CaptureQueue();
  const res = await api.sendNowHandler(sendNowEvent("sn-basic"), { queue });
  assert.equal(res.statusCode, 202);
  const body = JSON.parse(res.body) as { seriesId: string; campaignId: string };
  assert.equal(body.seriesId, "sn-basic");
  assert.ok(
    body.campaignId.startsWith("sn-basic-"),
    "the edition belongs to the series, so it reports under it rather than as an orphan one-off",
  );

  assert.equal(queue.enqueued.length, 1, "and it is actually queued");
  const sent = queue.enqueued[0]!;
  assert.equal(sent.seriesId, "sn-basic", "stamped so the sender applies the series ad fills");
  assert.equal(sent.subject, "Weekly ledger", "content comes from the STORED body, not the payload");
});

test("send-now is refused on a paused series", async () => {
  // Otherwise it is a way around the lifecycle gate an operator just used.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("sn-paused", { when: { type: "recurring", cron: "cron(0 6 * * ? *)" } })),
    { scheduler },
  );
  await api.scheduleLifecycleHandler({
    body: JSON.stringify({ orgId: ORG, scheduleId: "sn-paused", action: "pause" }),
    requestContext: {
      http: { method: "POST", sourceIp: "203.0.113.7" },
      authorizer: { jwt: { claims: { "custom:role": "developer_admin", "custom:orgs": ORG, sub: "a" } } },
    },
  });

  const res = await api.sendNowHandler(sendNowEvent("sn-paused"));
  assert.equal(res.statusCode, 409);
});

test("send-now is refused on a one-off", async () => {
  // A one-off is scheduled once; "again" has no meaning for it.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(scheduleEvent(composeBody("sn-oneoff")), { scheduler });

  const res = await api.sendNowHandler(sendNowEvent("sn-oneoff"));
  assert.equal(res.statusCode, 400);
});

test("send-now on an unknown series is a 404", async () => {
  const res = await api.sendNowHandler(sendNowEvent("sn-nope"));
  assert.equal(res.statusCode, 404);
});

test("send-now requires campaigns:schedule", async () => {
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("sn-rbac", { when: { type: "recurring", cron: "cron(0 6 * * ? *)" } })),
    { scheduler },
  );

  const res = await api.sendNowHandler(sendNowEvent("sn-rbac", "analyst"));
  assert.equal(res.statusCode, 403);
});

test("two send-nows produce two distinct editions", async () => {
  // The edition key is the request instant, so a second press is a second
  // edition rather than a collision on one id.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("sn-twice", { when: { type: "recurring", cron: "cron(0 6 * * ? *)" } })),
    { scheduler },
  );

  const queue = new CaptureQueue();
  const a = JSON.parse((await api.sendNowHandler(sendNowEvent("sn-twice"), { queue })).body) as { campaignId: string };
  await new Promise((r) => setTimeout(r, 2));
  const b = JSON.parse((await api.sendNowHandler(sendNowEvent("sn-twice"), { queue })).body) as { campaignId: string };
  assert.notEqual(a.campaignId, b.campaignId);
});

/**
 * Replacing a pending one-off (#308).
 *
 * Archive-then-create, in that order: a failure between the two leaves nothing
 * sending and the operator retries, whereas the reverse order risks both going
 * out.
 *
 * Archive rather than pause, deliberately. A paused one-off used to be parked
 * and re-enqueued on resume (#179), so an operator resuming later would send
 * BOTH versions. #304 made pause a skip, but archive is still the right verb:
 * it is terminal, and the sender's gate skips it permanently.
 */
test("superseding archives the old schedule and creates the new", async () => {
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("sup-v1", { when: { type: "at", at: "2027-01-01T12:00:00.000Z" } })),
    { scheduler },
  );

  const res = await api.scheduleCampaignHandler(
    scheduleEvent(
      composeBody("sup-v2", {
        supersedes: "sup-v1",
        subject: "Corrected",
        when: { type: "at", at: "2027-01-01T12:00:00.000Z" },
      }),
    ),
    { scheduler },
  );
  assert.equal(res.statusCode, 202);

  const oldState = await stores.schedules.get(ORG, "sup-v1");
  assert.equal(oldState?.status, "archived", "the old send must be terminally stopped");
  const newState = await stores.schedules.get(ORG, "sup-v2");
  assert.equal(newState?.status, "active");
});

test("a revision inherits the lineage and bumps the version", async () => {
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("lin-v1", { when: { type: "at", at: "2027-01-01T12:00:00.000Z" } })),
    { scheduler },
  );
  await api.scheduleCampaignHandler(
    scheduleEvent(
      composeBody("lin-v2", { supersedes: "lin-v1", when: { type: "at", at: "2027-01-01T12:00:00.000Z" } }),
    ),
    { scheduler },
  );

  const body = await stores.campaignBodies.get(ORG, "lin-v2");
  assert.equal(body?.rootCampaignId, "lin-v1", "lineage follows the original, not the new id");
  assert.equal(body?.version, 2);
});

test("a send that has already started cannot be replaced", async () => {
  // The gate runs per SLICE, so a campaign mid fan-out may have delivered some
  // recipients. Replacing it would mail those people twice.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("started", { when: { type: "at", at: "2027-01-01T12:00:00.000Z" } })),
    { scheduler },
  );
  const state = await stores.schedules.get(ORG, "started");
  await stores.schedules.put({ ...state!, completedRanges: [{ until: "s500" }] });

  const res = await api.scheduleCampaignHandler(
    scheduleEvent(
      composeBody("started-v2", { supersedes: "started", when: { type: "now" } }),
    ),
    { scheduler },
  );
  assert.equal(res.statusCode, 409);
});

test("a halted campaign cannot be revived under a new id", async () => {
  // The halt exists precisely to stop an operator re-sending past a bounce or
  // complaint gate, so a revision must not be the way around it.
  const scheduler = new CaptureScheduler();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("halted", { when: { type: "at", at: "2027-01-01T12:00:00.000Z" } })),
    { scheduler },
  );
  const c = await stores.campaigns.get(ORG, "halted");
  await stores.campaigns.put({ ...c!, status: "halted" });

  const res = await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("halted-v2", { supersedes: "halted", when: { type: "now" } })),
    { scheduler },
  );
  assert.equal(res.statusCode, 409);
});

test("superseding an unknown or recurring schedule is refused", async () => {
  const scheduler = new CaptureScheduler();
  const unknown = await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("sup-unknown", { supersedes: "nope", when: { type: "now" } })),
    { scheduler },
  );
  assert.equal(unknown.statusCode, 404);

  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("sup-series", { when: { type: "recurring", cron: "cron(0 6 * * ? *)" } })),
    { scheduler },
  );
  const series = await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("sup-series-v2", { supersedes: "sup-series", when: { type: "now" } })),
    { scheduler },
  );
  assert.equal(series.statusCode, 400, "a series is edited in place, not superseded");
});

test("inside the last minute, replacing is refused and cancelling is the answer", async () => {
  // The race is unwinnable there: the sender may pick the message up between
  // the check and the archive write. The console disables Edit at this point
  // and leaves Cancel, which is what the operator actually needs — they are in
  // a hurry and want to know whether it went out.
  const scheduler = new CaptureScheduler();
  const soon = new Date(Date.now() + 30_000).toISOString();
  await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("imminent", { when: { type: "at", at: soon } })),
    { scheduler },
  );
  // effectiveOneOffTime floors a one-off at now + 5 minutes, so force the
  // stored sendAt to the imminent value this test is about.
  const state = await stores.schedules.get(ORG, "imminent");
  await stores.schedules.put({ ...state!, sendAt: soon });

  const res = await api.scheduleCampaignHandler(
    scheduleEvent(composeBody("imminent-v2", { supersedes: "imminent", when: { type: "now" } })),
    { scheduler },
  );
  assert.equal(res.statusCode, 409);
  assert.equal(
    JSON.parse(res.body).reason,
    "too-close-to-send",
    "the console keys its Edit/Cancel switch on this",
  );

  // And the original is untouched — a refused revision must not have archived it.
  const after = await stores.schedules.get(ORG, "imminent");
  assert.equal(after?.status, "active", "a refusal must leave the original sending");
});
