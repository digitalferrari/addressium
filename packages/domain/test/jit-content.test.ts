/**
 * A recurring series picks up edited content on its next firing (#303).
 *
 * Before this, subject and template were whatever the scheduler payload froze
 * when the schedule was created. Editing either changed nothing until the
 * schedule was deleted and re-made — and `CampaignSeries.templateId`, whose own
 * comment says "editions reuse them", was never read on the launch path at all.
 *
 * `planLaunchDescriptor` stays pure: the handler does the store read and passes
 * the result in, so this is unit-testable without a DynamoDB double.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planLaunchDescriptor, type RecurringLaunchPayload } from "@addressium/domain";

const payload = (over: Partial<RecurringLaunchPayload> = {}): RecurringLaunchPayload => ({
  descriptor: {
    orgId: "acme",
    campaignId: "daily",
    listId: "ledger",
    subject: "Frozen subject",
    template: { blocks: [{ kind: "text", html: "<p>Frozen body</p>" }] },
  },
  editionKey: "2026-09-23",
  ...over,
});

test("with no stored body the frozen payload is used, exactly as before", () => {
  // The compatibility guarantee: schedules created before bodies were stored
  // must behave byte-for-byte as they did.
  const d = planLaunchDescriptor(payload(), undefined, undefined);
  assert.equal(d.subject, "Frozen subject");
  assert.deepEqual(d.template, { blocks: [{ kind: "text", html: "<p>Frozen body</p>" }] });
  assert.equal(d.campaignId, "daily-2026-09-23");
});

test("fresh content overrides the frozen subject and template", () => {
  const d = planLaunchDescriptor(payload(), undefined, {
    subject: "Edited subject",
    template: { blocks: [{ kind: "text", html: "<p>Edited body</p>" }] },
  });
  assert.equal(d.subject, "Edited subject");
  assert.deepEqual(d.template, { blocks: [{ kind: "text", html: "<p>Edited body</p>" }] });
});

test("a fresh preheader reaches the descriptor", () => {
  const d = planLaunchDescriptor(payload(), undefined, { previewText: "Today's ledger" });
  assert.equal(d.previewText, "Today's ledger");
});

test("partial fresh content overrides only what it carries", () => {
  // A body that set a subject but no preheader must not blank a preheader the
  // payload already had.
  const withPreheader = payload();
  withPreheader.descriptor.previewText = "Frozen preheader";
  const d = planLaunchDescriptor(withPreheader, undefined, { subject: "Edited subject" });
  assert.equal(d.subject, "Edited subject");
  assert.equal(d.previewText, "Frozen preheader", "an unset field must not erase the old one");
});

test("the edition id is stamped from the SERIES stem, not the fresh content", () => {
  // Idempotency depends on this: the same firing must always produce the same
  // edition id, whatever the content says.
  const d = planLaunchDescriptor(payload(), undefined, { subject: "Edited" });
  assert.equal(d.campaignId, "daily-2026-09-23");
});

test("a feed edition still takes its subject from the lead story", () => {
  // A daily newsletter's subject IS its lead headline. Letting a stored subject
  // win would pin every edition to a line the operator set months ago — a
  // different feature, not this one.
  const d = planLaunchDescriptor(
    payload({ feed: { url: "https://x.test/rss", format: "rss" } }),
    [{ title: "Today's lead story", link: "https://x.test/1" }],
    { subject: "Stored subject" },
  );
  assert.equal(d.subject, "Today's lead story");
});

test("a feed edition still carries a fresh preheader", () => {
  // The subject is the feed's to name; the preheader is not.
  const d = planLaunchDescriptor(
    payload({ feed: { url: "https://x.test/rss", format: "rss" } }),
    [{ title: "Lead", link: "https://x.test/1" }],
    { previewText: "Edited preheader" },
  );
  assert.equal(d.previewText, "Edited preheader");
});

test("everything else on the descriptor survives", () => {
  // listId, segmentId and orgId are not content and must pass through.
  const p = payload();
  p.descriptor.segmentId = "vips";
  const d = planLaunchDescriptor(p, undefined, { subject: "Edited" });
  assert.equal(d.listId, "ledger");
  assert.equal(d.segmentId, "vips");
  assert.equal(d.orgId, "acme");
});
