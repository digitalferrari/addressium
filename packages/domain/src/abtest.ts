/**
 * A/B subject-line test execution (docs/ARCHITECTURE.md §4.20, #25).
 *
 * Flow: split the confirmed set into two equal holdouts (A/B) plus a remainder.
 * Phase 1 sends variant A's subject to holdout A and variant B's to holdout B,
 * each under its own sub-campaign id so opens/clicks aggregate per variant.
 * After the decision window, the variant with more unique opens (or clicks) wins
 * and phase 2 sends the winning subject to the remainder. Holdouts/remainder are
 * disjoint windows of the stable `listConfirmed` order, reusing the send slice
 * mechanism so no separate recipient targeting is needed.
 */
import type { AbTest } from "@addressium/core";
import type { Clock, EmailSender, MagicLinkSigner, SendDescriptor, Stores } from "./ports.js";
import { sendCampaign, type SendOptions, type SendResult } from "./send.js";
import { deriveCounters } from "./reporting.js";

export type Variant = "A" | "B";

export interface AbSplit {
  total: number;
  holdoutA: { offset: number; limit: number };
  holdoutB: { offset: number; limit: number };
  remainder: { offset: number; limit: number };
}

/** Sub-campaign id for a variant / the winning remainder send. */
export function abCampaignId(baseCampaignId: string, part: Variant | "final"): string {
  return `${baseCampaignId}#ab-${part}`;
}

/**
 * Split `total` recipients into two equal test holdouts (`splitPct` total,
 * halved) plus the remainder. With too few recipients to split, both holdouts
 * are empty and everyone is remainder.
 */
export function planAbSplit(total: number, splitPct: number): AbSplit {
  if (splitPct < 0 || splitPct > 100) throw new Error("splitPct must be within 0..100");
  const holdoutTotal = Math.floor((total * splitPct) / 100);
  const perVariant = Math.floor(holdoutTotal / 2);
  return {
    total,
    holdoutA: { offset: 0, limit: perVariant },
    holdoutB: { offset: perVariant, limit: perVariant },
    remainder: { offset: perVariant * 2, limit: total - perVariant * 2 },
  };
}

export interface AbPhase1Result {
  split: AbSplit;
  a: SendResult;
  b: SendResult;
}

/** Phase 1: send both subject variants to their holdouts. */
export async function startAbTest(
  stores: Stores,
  sender: EmailSender,
  magic: MagicLinkSigner,
  clock: Clock,
  descriptor: SendDescriptor,
  test: AbTest,
  opts: SendOptions = {},
): Promise<AbPhase1Result> {
  const confirmed = await stores.subscriptions.listConfirmed(descriptor.orgId, descriptor.listId);
  const split = planAbSplit(confirmed.length, test.splitPct);

  const a = await sendCampaign(
    stores,
    sender,
    magic,
    clock,
    { ...descriptor, campaignId: abCampaignId(descriptor.campaignId, "A"), subject: test.variantA, slice: split.holdoutA },
    opts,
  );
  const b = await sendCampaign(
    stores,
    sender,
    magic,
    clock,
    { ...descriptor, campaignId: abCampaignId(descriptor.campaignId, "B"), subject: test.variantB, slice: split.holdoutB },
    opts,
  );
  return { split, a, b };
}

export interface AbDecision {
  winner: Variant;
  aScore: number;
  bScore: number;
  metric: AbTest["winnerMetric"];
}

/** Decide the winner by the configured metric (unique opens/clicks). Ties → A. */
export async function decideAbWinner(
  stores: Stores,
  baseCampaignId: string,
  orgId: string,
  test: AbTest,
): Promise<AbDecision> {
  const score = async (variant: Variant): Promise<number> => {
    const events = await stores.events.all(orgId, abCampaignId(baseCampaignId, variant));
    const c = deriveCounters(events);
    return test.winnerMetric === "click" ? c.clicks : c.opens;
  };
  const aScore = await score("A");
  const bScore = await score("B");
  return { winner: bScore > aScore ? "B" : "A", aScore, bScore, metric: test.winnerMetric };
}

/** Phase 2: send the winning subject to the remainder window. */
export async function sendAbWinnerToRemainder(
  stores: Stores,
  sender: EmailSender,
  magic: MagicLinkSigner,
  clock: Clock,
  descriptor: SendDescriptor,
  test: AbTest,
  split: AbSplit,
  winner: Variant,
  opts: SendOptions = {},
): Promise<SendResult> {
  const subject = winner === "A" ? test.variantA : test.variantB;
  return sendCampaign(
    stores,
    sender,
    magic,
    clock,
    { ...descriptor, campaignId: abCampaignId(descriptor.campaignId, "final"), subject, slice: split.remainder },
    opts,
  );
}

export interface AbReport {
  aScore: number;
  bScore: number;
  winner?: Variant;
  metric: AbTest["winnerMetric"];
}

/** Per-variant scores + declared winner, for the reporting surface. */
export async function buildAbReport(
  stores: Stores,
  baseCampaignId: string,
  orgId: string,
  test: AbTest,
): Promise<AbReport> {
  const decision = await decideAbWinner(stores, baseCampaignId, orgId, test);
  return { aScore: decision.aScore, bScore: decision.bScore, winner: test.winner, metric: test.winnerMetric };
}
