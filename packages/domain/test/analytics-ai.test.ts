/**
 * LLM analytics: the prompt carries aggregates (never subscriber PII), redaction
 * scrubs email-shaped text, and analyzeCampaign runs report → prompt → advisor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { EngagementEvent } from "@addressium/core";
import {
  buildAnalysisPrompt,
  redactForLlm,
  analyzeCampaign,
  buildCampaignReport,
  memStores,
  type AnalyticsAdvisor,
} from "@addressium/domain";

const ORG = "summit";
const C = "camp-1";

async function seededStores() {
  const stores = memStores();
  const evt = (type: EngagementEvent["type"], sub: string): EngagementEvent => ({
    orgId: ORG,
    campaignId: C,
    subscriberId: sub,
    type,
    at: "2026-07-20T00:00:00Z",
  });
  for (const e of [evt("sent", "a"), evt("sent", "b"), evt("open", "a"), evt("bounce", "b")]) {
    await stores.events.append(e);
  }
  // An archive gives the click map labels.
  await stores.archive.put({
    orgId: ORG,
    campaignId: C,
    s3Key: "k",
    linkMap: { l0: { urlTemplate: "https://northwindtimes.example/a", position: 1, label: "Lead story", class: "editorial" } },
  });
  return stores;
}

test("redactForLlm scrubs email-shaped text", () => {
  assert.equal(redactForLlm("contact jordan@example.com now"), "contact [redacted] now");
});

test("buildAnalysisPrompt includes aggregates + labels but no PII", async () => {
  const report = await buildCampaignReport(await seededStores(), ORG, C);
  const prompt = buildAnalysisPrompt(report);
  assert.match(prompt, /Sent: 2/);
  assert.match(prompt, /Unique opens: 1/);
  assert.match(prompt, /Lead story/); // editorial label is fine to send
  assert.doesNotMatch(prompt, /@/); // no email addresses anywhere
});

test("analyzeCampaign runs report → prompt → advisor and returns the analysis", async () => {
  const stores = await seededStores();
  let seenPrompt = "";
  const advisor: AnalyticsAdvisor = {
    async analyze(prompt) {
      seenPrompt = prompt;
      return { vendor: "anthropic", model: "claude-x", text: "Solid open rate; tighten subject lines." };
    },
  };
  const { analysis, prompt } = await analyzeCampaign(stores, advisor, ORG, C);
  assert.equal(analysis.text, "Solid open rate; tighten subject lines.");
  assert.equal(seenPrompt, prompt);
  assert.match(prompt, /performance/i);
});
