/**
 * Stored-template → EmailTemplate conversion for server-side sends (#95) and the
 * campaign list projection used by the report picker (#103).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Campaign, Template } from "@addressium/core";
import {
  emailTemplateFromStored,
  UnrenderableTemplateError,
  memStores,
} from "@addressium/domain";

const base = { orgId: "o", version: 1, mergeTags: [], adSlots: [] };

test("raw_html templates render through the shared HTML pipeline", () => {
  const t: Template = { ...base, templateId: "t1", name: "Welcome", mode: "raw_html", source: "<h1>Hi {{first_name}}</h1>" };
  assert.deepEqual(emailTemplateFromStored(t), { html: "<h1>Hi {{first_name}}</h1>" });
});

test("mjml/visual templates can't render server-side and fail loudly", () => {
  for (const mode of ["mjml", "visual"] as const) {
    const t: Template = { ...base, templateId: "t2", name: "Fancy", mode, source: "<mjml></mjml>" };
    assert.throws(() => emailTemplateFromStored(t), UnrenderableTemplateError);
  }
});

test("campaigns.list returns only the org's campaigns", async () => {
  const stores = memStores();
  const mk = (orgId: string, campaignId: string): Campaign => ({
    orgId,
    campaignId,
    type: "one_off",
    subject: campaignId,
    templateId: "t",
    audience: { listId: "l" },
    status: "draft",
    counters: { sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 },
  });
  await stores.campaigns.put(mk("o1", "c1"));
  await stores.campaigns.put(mk("o1", "c2"));
  await stores.campaigns.put(mk("o2", "c3"));

  const list = await stores.campaigns.list("o1");
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((c) => c.campaignId).sort(), ["c1", "c2"]);
});
