/**
 * Send-cost estimator. The model exists so the README, the admin console and
 * these tests quote the same numbers; these assertions pin the shape and the
 * magnitudes so a pricing edit can't silently move them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { estimateSendCost, DEFAULT_COST_INPUT, PRICES } from "@addressium/domain";

const base = { ...DEFAULT_COST_INPUT, subscribers: 40_000, sendsPerYear: 1 };

test("SES dominates a single send, but is not the whole cost", () => {
  const e = estimateSendCost(base);
  const ses = e.perSend.find((l) => l.label.startsWith("SES"))!;
  assert.equal(ses.usd, 4, "40,000 × $0.10/1,000");
  // If SES were ~100% of the total the model would be ignoring the pipeline.
  const share = ses.usd / e.perSendTotalUsd;
  assert.ok(share > 0.5 && share < 0.9, `SES share ${(share * 100).toFixed(0)}% should be 50-90%`);
});

test("KMS signing is per recipient, and material relative to SES", () => {
  const e = estimateSendCost(base);
  const kms = e.perSend.find((l) => l.label.startsWith("KMS"))!;
  assert.equal(kms.usd, round(40_000 * PRICES.kmsAsymmetricRequest));
  // ~15% of SES — small in absolute terms, but the reason the per-recipient
  // Sign call is worth revisiting at volume.
  assert.ok(kms.usd > 0.5 && kms.usd < 0.7, `expected ~$0.60, got $${kms.usd}`);
});

test("cost scales linearly with recipients", () => {
  const one = estimateSendCost({ ...base, subscribers: 10_000 }).perSendTotalUsd;
  const four = estimateSendCost({ ...base, subscribers: 40_000 }).perSendTotalUsd;
  assert.ok(Math.abs(four - one * 4) < 0.02, `${four} should be ~4x ${one}`);
});

test("engagement rates drive event volume and therefore cost", () => {
  const quiet = estimateSendCost({ ...base, openRate: 0, clickRate: 0, bounceRate: 0 });
  const busy = estimateSendCost({ ...base, openRate: 0.8, clickRate: 0.2, bounceRate: 0.02 });
  assert.equal(quiet.eventsPerSend, 40_000, "delivered events alone");
  assert.ok(busy.eventsPerSend > quiet.eventsPerSend);
  assert.ok(busy.perSendTotalUsd > quiet.perSendTotalUsd);
});

test("the three headline scenarios land where the README says", () => {
  const once = estimateSendCost({ ...base, sendsPerYear: 1 });
  const weekly = estimateSendCost({ ...base, sendsPerYear: 52 });
  const daily = estimateSendCost({ ...base, sendsPerYear: 365 });

  assert.ok(once.perSendTotalUsd > 4.5 && once.perSendTotalUsd < 6.5, `once: $${once.perSendTotalUsd}`);
  assert.ok(weekly.annualUsd > 280 && weekly.annualUsd < 400, `weekly/yr: $${weekly.annualUsd}`);
  assert.ok(daily.annualUsd > 1_800 && daily.annualUsd < 2_300, `daily/yr: $${daily.annualUsd}`);

  // Annual must exceed the naive per-send multiple: fixed cost and accrued
  // event storage are real and must not be dropped from the model.
  assert.ok(daily.annualUsd > daily.perSendTotalUsd * 365);
});

test("fixed monthly cost accrues with zero sends", () => {
  const e = estimateSendCost({ ...base, subscribers: 0 });
  assert.equal(e.perSendTotalUsd, 0);
  assert.ok(e.fixedMonthlyUsd > 0, "alarms, KMS key and secrets bill regardless");
  assert.equal(e.fixedMonthlyUsd, 2.4 + 1.0 + 0.8);
});

test("zero and negative inputs do not produce negative money", () => {
  for (const subscribers of [0, -100]) {
    const e = estimateSendCost({ ...base, subscribers });
    assert.equal(e.perSendTotalUsd, 0);
    assert.ok(e.annualUsd >= 0);
  }
});

const round = (n: number) => Math.round(n * 10_000) / 10_000;
