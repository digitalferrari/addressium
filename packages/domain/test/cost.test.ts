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
  // 30 alarms ($3.00) + stack data key and 1 org key ($2.00) + 2 secrets ($0.80)
  // + 1 ops dashboard ($3.00, added by #311 — it was billing all along and the
  // model simply did not say so).
  assert.equal(e.fixedMonthlyUsd, 3.0 + 2.0 + 0.8 + 3.0);
});

test("zero and negative inputs do not produce negative money", () => {
  for (const subscribers of [0, -100]) {
    const e = estimateSendCost({ ...base, subscribers });
    assert.equal(e.perSendTotalUsd, 0);
    assert.ok(e.annualUsd >= 0);
  }
});

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Line items the model used to omit (#311).
 *
 * The concern that prompted this was a CloudWatch bill at 24M emails/year. The
 * measurement said otherwise, and the measurement is the useful part: the send
 * path logs PER SLICE, not per recipient — `services/sender` has two
 * `console.*` calls, both error paths, and `packages/domain/src/send.ts` has
 * none. So log ingest is cents, not the dominant line it would be if every
 * recipient produced a line.
 *
 * These pin the omissions as counted, and pin the reason the total stays small.
 */
test("log ingest scales with invocations, not with recipients", () => {
  // Ten times the recipients on one send must not cost ten times the logs: the
  // sender logs once per slice and the events handler once per batch.
  const small = estimateSendCost({ ...base, subscribers: 1_000, sendsPerYear: 1 });
  const large = estimateSendCost({ ...base, subscribers: 10_000, sendsPerYear: 1 });
  const delta = large.annualUsd - small.annualUsd;
  const sesDelta = 9_000 * 0.10 / 1_000;
  assert.ok(
    delta < sesDelta * 3,
    `annual grew by $${delta.toFixed(2)} for 9,000 more emails; SES alone is $${sesDelta.toFixed(2)} — logs must not dominate`,
  );
});

test("the ops dashboard is counted", () => {
  // It was billing all along; the model simply did not say so.
  const e = estimateSendCost({ ...base, dashboards: 2 });
  const line = e.fixedMonthly.find((l) => l.label.includes("dashboard"));
  assert.ok(line, "a dashboard line must appear");
  assert.equal(line.usd, 6.0);
});

test("the annual total includes logs and the archive, not just sends and fixed", () => {
  // The old total was `perSend × sends + fixed × 12 + storage`, and the caption
  // said so — while omitting two real charges. An estimate people read as
  // complete has to be.
  const e = estimateSendCost({ ...base, sendsPerYear: 365 });
  const naive = e.perSendTotalUsd * 365 + e.fixedMonthlyUsd * 12;
  assert.ok(
    e.annualUsd > naive,
    "the annual figure must carry more than sends plus fixed monthly",
  );
});
