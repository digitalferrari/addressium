/**
 * Deliverability auto-halt reachability (#217).
 *
 * The halt gate itself was correct and had been correct for a long time. What
 * was missing is that nothing in production ever wrote an `AlertConfig`, so
 * `checkDeliverability` short-circuited on the missing record and the campaign
 * ran to completion no matter what the complaint rate was. These assert the
 * config now exists by default and that the gate actually fires.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Campaign, EngagementEvent, List } from "@addressium/core";
import {
  DEFAULT_ALERT_RULES,
  checkDeliverability,
  defaultAlertConfig,
  memStores,
  provisionOrganization,
  type AlertPublisher,
  type Clock,
  type Stores,
} from "@addressium/domain";

const ORG = "northwind-times";
const clock: Clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };

class CapturePublisher implements AlertPublisher {
  published: { topicArn: string; action: string }[] = [];
  async publish(topicArn: string, message: { action: string }): Promise<void> {
    this.published.push({ topicArn, action: message.action });
  }
}

class ThrowingPublisher implements AlertPublisher {
  async publish(): Promise<void> {
    throw new Error("SNS unavailable");
  }
}

const providers = {
  linkSubscriberPool: async () => ({ poolId: "pool" }),
  createSigningKey: async () => ({ kmsKeyArn: "arn:kms", kid: "k1" }),
  ensureSesDomainIdentity: async () => ({
    configSet: "cs",
    dkimTokens: ["t"],
    verificationStatus: "pending" as const,
  }),
};

const orgInput = {
  name: "Northwind Times",
  primaryDomain: "northwindtimes.example",
  siteDomain: "northwindtimes.example",
  region: "us-east-1",
  defaultTimezone: "UTC",
  magicLinks: false,
  dedicatedIp: false,
  suppressionScope: "hybrid" as const,
  environment: "prod" as const,
};

/** A campaign plus enough events to push the complaint rate past `haltAt`. */
async function seedBreach(stores: Stores, complaints: number, sends: number) {
  const list: List = {
    orgId: ORG,
    listId: "ledger",
    name: "Ledger",
    optInPolicy: "double",
    fromAddress: "a@b.co",
    access: "free",
    visibility: "open",
    complianceFooter: "f",
    physicalAddress: "p",
  };
  await stores.lists.put(list);
  const campaign: Campaign = {
    orgId: ORG,
    campaignId: "c1",
    type: "one_off",
    subject: "x",
    audience: { listId: "ledger" },
    status: "sending",
    templateId: "t1",
    counters: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 },
  };
  await stores.campaigns.put(campaign);
  const ev = (i: number, type: EngagementEvent["type"]): EngagementEvent => ({
    orgId: ORG,
    campaignId: "c1",
    subscriberId: `s${i}`,
    type,
    at: "2026-01-01T00:00:00.000Z",
    eventId: `${type}-${i}`,
  });
  for (let i = 0; i < sends; i++) await stores.events.append(ev(i, "sent"));
  for (let i = 0; i < complaints; i++) await stores.events.append(ev(i, "complaint"));
}

test("a newly provisioned org has deliverability thresholds without any operator action", async () => {
  const stores = memStores();
  await provisionOrganization(stores, providers, orgInput);

  const config = await stores.alerts.get(ORG);
  assert.ok(config, "a control that is off by default is not a control");
  assert.equal(config.orgId, ORG);
  assert.ok(config.rules.some((r) => r.metric === "complaint_rate" && r.enabled));
  assert.ok(config.rules.some((r) => r.metric === "bounce_rate" && r.enabled));
});

test("default thresholds sit where mailbox providers actually act", () => {
  const complaint = DEFAULT_ALERT_RULES.find((r) => r.metric === "complaint_rate");
  const bounce = DEFAULT_ALERT_RULES.find((r) => r.metric === "bounce_rate");
  // Google Postmaster treats 0.3% as the line to stay under; SES puts an
  // account under review above a 5% bounce rate.
  assert.equal(complaint?.warnAt, 0.003);
  assert.equal(complaint?.haltAt, 0.005);
  assert.equal(bounce?.warnAt, 0.05);
  assert.equal(bounce?.haltAt, 0.1);
  for (const r of DEFAULT_ALERT_RULES) {
    assert.ok(r.haltAt >= r.warnAt, `${r.metric}: haltAt must not sit below warnAt`);
  }
});

test("the reputation rule is disabled, because there is no live signal behind it", () => {
  const rep = DEFAULT_ALERT_RULES.find((r) => r.metric === "reputation");
  assert.equal(rep?.enabled, false, "an always-zero rule implies a signal we do not have");
});

test("provisioning does not overwrite thresholds an operator already tuned", async () => {
  const stores = memStores();
  await stores.alerts.put({
    orgId: ORG,
    rules: [{ metric: "complaint_rate", warnAt: 0.5, haltAt: 0.9, enabled: true }],
    notifyTargets: [],
  });
  await provisionOrganization(stores, providers, orgInput);

  const config = await stores.alerts.get(ORG);
  assert.equal(config?.rules[0]?.haltAt, 0.9, "a re-provision must not reset tuned thresholds");
});

test("a breaching campaign is halted and the breach is published", async () => {
  const stores = memStores();
  await stores.alerts.put(defaultAlertConfig(ORG, "arn:aws:sns:us-east-1:1:alerts"));
  await seedBreach(stores, 10, 100); // 10% complaint rate, far past haltAt

  const publisher = new CapturePublisher();
  const result = await checkDeliverability(stores, publisher, clock, ORG, "c1");

  assert.equal(result.halted, true);
  assert.ok(result.breaches.some((b) => b.metric === "complaint_rate" && b.level === "halt"));
  assert.equal((await stores.campaigns.get(ORG, "c1"))?.status, "halted");
  assert.deepEqual(publisher.published, [{ topicArn: "arn:aws:sns:us-east-1:1:alerts", action: "halted" }]);
});

test("an org with no SNS topic still halts — quietly, but it halts", async () => {
  const stores = memStores();
  await stores.alerts.put(defaultAlertConfig(ORG)); // no topic
  await seedBreach(stores, 10, 100);

  const publisher = new CapturePublisher();
  const result = await checkDeliverability(stores, publisher, clock, ORG, "c1");

  assert.equal(result.halted, true, "halting is the safety control; notification is secondary");
  assert.equal((await stores.campaigns.get(ORG, "c1"))?.status, "halted");
  assert.deepEqual(publisher.published, [], "nothing to publish to");
});

test("a publish failure does not prevent the halt", async () => {
  const stores = memStores();
  await stores.alerts.put(defaultAlertConfig(ORG, "arn:aws:sns:us-east-1:1:alerts"));
  await seedBreach(stores, 10, 100);

  const result = await checkDeliverability(stores, new ThrowingPublisher(), clock, ORG, "c1");

  // If SNS being down could stop the halt, the control would fail exactly when
  // the infrastructure is already unhealthy.
  assert.equal(result.halted, true);
  assert.equal((await stores.campaigns.get(ORG, "c1"))?.status, "halted");
});

test("a healthy campaign is left alone", async () => {
  const stores = memStores();
  await stores.alerts.put(defaultAlertConfig(ORG, "arn:sns"));
  await seedBreach(stores, 0, 100);

  const publisher = new CapturePublisher();
  const result = await checkDeliverability(stores, publisher, clock, ORG, "c1");

  assert.equal(result.halted, false);
  assert.deepEqual(result.breaches, []);
  assert.equal((await stores.campaigns.get(ORG, "c1"))?.status, "sending");
  assert.deepEqual(publisher.published, []);
});

test("the end-to-end default path halts a provisioned org's bad campaign", async () => {
  // The regression this issue is really about: provision an org the normal way,
  // touch no alert settings, and a complaint spike must still stop the send.
  const stores = memStores();
  await provisionOrganization(stores, providers, orgInput);
  await seedBreach(stores, 5, 100); // 5% — past the 0.5% halt threshold

  const result = await checkDeliverability(stores, new CapturePublisher(), clock, ORG, "c1");
  assert.equal(result.halted, true, "auto-halt must work on an untouched org");
  assert.equal((await stores.campaigns.get(ORG, "c1"))?.status, "halted");
});
