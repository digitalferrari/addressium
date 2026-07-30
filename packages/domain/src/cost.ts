/**
 * Send-cost estimator (docs/DESIGN-COMPENDIUM.md §7).
 *
 * A pure model of what one campaign costs in AWS, so the README, the admin
 * console and the tests all quote the SAME numbers instead of drifting. Every
 * unit price is named and dated below rather than folded into a magic constant,
 * because AWS pricing changes and a stale estimate that looks authoritative is
 * worse than no estimate.
 *
 * Scope: this models the marginal cost of SENDING. Fixed monthly cost (alarms,
 * secrets, per-org KMS key) is modelled separately in `fixedMonthlyUsd` because
 * it accrues whether or not anything is sent.
 */

/**
 * us-east-1 on-demand list prices, captured 2026-07. Other regions differ;
 * the estimate is explicitly labelled as us-east-1 in the UI.
 */
export const PRICES = {
  /** SES: $0.10 per 1,000 outbound messages. Attachments are extra; we send none. */
  sesPerEmail: 0.10 / 1_000,
  /** DynamoDB on-demand write request unit (1 KB). */
  ddbWriteUnit: 1.25 / 1_000_000,
  /** DynamoDB on-demand read request unit (4 KB, eventually consistent = 0.5). */
  ddbReadUnit: 0.25 / 1_000_000,
  /** DynamoDB storage, per GB-month. */
  ddbStorageGbMonth: 0.25,
  /** Lambda duration, per GB-second. */
  lambdaGbSecond: 0.0000166667,
  /** Lambda invocation. */
  lambdaRequest: 0.20 / 1_000_000,
  /**
   * KMS asymmetric (ECC_NIST_P256) sign request. NOT the $0.03/10k symmetric
   * rate — asymmetric keys other than RSA-2048 are 5x that, which matters
   * because we sign a magic-link token per recipient.
   */
  kmsAsymmetricRequest: 0.15 / 10_000,
  /** KMS customer-managed key, per key-month. */
  kmsKeyMonth: 1.00,
  /** SQS request (send, receive and delete are each billed). */
  sqsRequest: 0.40 / 1_000_000,
  /** SNS publish. Delivery to SQS is free. */
  snsPublish: 0.50 / 1_000_000,
  /** Secrets Manager, per secret-month. */
  secretMonth: 0.40,
  /** CloudWatch alarm, per alarm-month. */
  alarmMonth: 0.10,
} as const;

/** Work the pipeline does per unit, derived from the send and event paths. */
const UNITS = {
  /** Per recipient: send-claim conditional put (1) + transactional event+counter (4). */
  ddbWritesPerSend: 5,
  /** Per recipient: subscriber get + suppression check. */
  ddbReadsPerSend: 2,
  /** Per engagement event: transactional event row + counter increment. */
  ddbWritesPerEvent: 4,
  /** Sender compute per recipient: render, mint token, SES call. 512 MB × ~30 ms. */
  lambdaGbSecondsPerSend: 0.5 * 0.03,
  /** Events handler per event: parse, one transactional write. 512 MB × ~10 ms. */
  lambdaGbSecondsPerEvent: 0.5 * 0.01,
  /** SQS send + receive + delete for each engagement event. */
  sqsRequestsPerEvent: 3,
  /** Recipients per fan-out slice, so sender invocations scale sub-linearly. */
  recipientsPerSlice: 2_000,
  /** Stored bytes per engagement event row. */
  eventRowBytes: 300,
} as const;

export interface SendCostInput {
  /** Recipients per send. */
  subscribers: number;
  /** Sends per year. 1 = one-off, 52 = weekly, 365 = daily. */
  sendsPerYear: number;
  /** Fraction of delivered mail that is opened. Drives event volume. */
  openRate: number;
  /** Fraction that is clicked. */
  clickRate: number;
  /** Fraction that bounces or complains. */
  bounceRate: number;
  /** Organizations provisioned — each carries its own KMS key. */
  orgs: number;
  /** CloudWatch alarms retained. */
  alarms: number;
  /** Secrets Manager secrets. */
  secrets: number;
}

export const DEFAULT_COST_INPUT: SendCostInput = {
  subscribers: 40_000,
  sendsPerYear: 1,
  openRate: 0.40,
  clickRate: 0.05,
  bounceRate: 0.02,
  orgs: 1,
  alarms: 29,
  secrets: 2,
};

export interface CostLine {
  label: string;
  usd: number;
  /** Shown in the UI so a number can be argued with rather than trusted. */
  detail: string;
}

export interface SendCostEstimate {
  perSend: CostLine[];
  perSendTotalUsd: number;
  fixedMonthly: CostLine[];
  fixedMonthlyUsd: number;
  /** Sends × per-send, plus 12 months fixed, plus accrued event storage. */
  annualUsd: number;
  /** Events generated per send — the driver of everything but SES itself. */
  eventsPerSend: number;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Storage accrues as sends accumulate, so a year of daily sending averages
 * roughly half its final size. Charging the final size would overstate it and
 * charging the initial size would understate it.
 */
function averageStorageGb(eventsPerSend: number, sendsPerYear: number): number {
  const finalBytes = eventsPerSend * sendsPerYear * UNITS.eventRowBytes;
  return finalBytes / 2 / 1024 ** 3;
}

export function estimateSendCost(input: SendCostInput): SendCostEstimate {
  const n = Math.max(0, input.subscribers);

  // Every delivered message emits a `delivered` event; opens/clicks/bounces are
  // fractions on top. This is the volume the analytics plane must absorb.
  const events =
    n * (1 + Math.max(0, input.openRate) + Math.max(0, input.clickRate) + Math.max(0, input.bounceRate));

  const senderInvocations = Math.ceil(n / UNITS.recipientsPerSlice);

  const perSend: CostLine[] = [
    {
      label: "SES — outbound messages",
      usd: n * PRICES.sesPerEmail,
      detail: `${n.toLocaleString()} × $0.10/1,000`,
    },
    {
      label: "KMS — magic-link signing",
      usd: n * PRICES.kmsAsymmetricRequest,
      detail: `${n.toLocaleString()} asymmetric Sign calls × $0.15/10,000 — one per recipient`,
    },
    {
      label: "DynamoDB — send-path writes",
      usd: n * UNITS.ddbWritesPerSend * PRICES.ddbWriteUnit,
      detail: `${UNITS.ddbWritesPerSend} WRU/recipient (claim + transactional event & counter)`,
    },
    {
      label: "DynamoDB — send-path reads",
      usd: n * UNITS.ddbReadsPerSend * PRICES.ddbReadUnit,
      detail: `${UNITS.ddbReadsPerSend} RRU/recipient (subscriber + suppression)`,
    },
    {
      label: "DynamoDB — engagement event writes",
      usd: events * UNITS.ddbWritesPerEvent * PRICES.ddbWriteUnit,
      detail: `${Math.round(events).toLocaleString()} events × ${UNITS.ddbWritesPerEvent} WRU`,
    },
    {
      label: "Lambda — sender",
      usd:
        n * UNITS.lambdaGbSecondsPerSend * PRICES.lambdaGbSecond +
        senderInvocations * PRICES.lambdaRequest,
      detail: `${senderInvocations.toLocaleString()} invocations over ${UNITS.recipientsPerSlice.toLocaleString()}-recipient slices`,
    },
    {
      label: "Lambda — events handler",
      usd:
        events * UNITS.lambdaGbSecondsPerEvent * PRICES.lambdaGbSecond +
        events * PRICES.lambdaRequest,
      detail: `${Math.round(events).toLocaleString()} event invocations`,
    },
    {
      label: "SQS + SNS — event transport",
      usd: events * UNITS.sqsRequestsPerEvent * PRICES.sqsRequest + events * PRICES.snsPublish,
      detail: `${UNITS.sqsRequestsPerEvent} SQS requests + 1 SNS publish per event`,
    },
  ].map((l) => ({ ...l, usd: round(l.usd) }));

  const perSendTotalUsd = round(perSend.reduce((s, l) => s + l.usd, 0));

  const fixedMonthly: CostLine[] = [
    {
      label: "CloudWatch alarms",
      usd: round(input.alarms * PRICES.alarmMonth),
      detail: `${input.alarms} × $0.10/month`,
    },
    {
      // Per-org signing keys PLUS the stack's own customer-managed data key
      // (DynamoDB/SNS at rest) — forgetting it under-reports the standing bill.
      label: "KMS keys",
      usd: round((input.orgs + 1) * PRICES.kmsKeyMonth),
      detail: `1 stack data key + ${input.orgs} org key${input.orgs === 1 ? "" : "s"} × $1.00/month`,
    },
    {
      label: "Secrets Manager",
      usd: round(input.secrets * PRICES.secretMonth),
      detail: `${input.secrets} × $0.40/month`,
    },
  ];
  const fixedMonthlyUsd = round(fixedMonthly.reduce((s, l) => s + l.usd, 0));

  const storageUsd = round(
    averageStorageGb(events, input.sendsPerYear) * PRICES.ddbStorageGbMonth * 12,
  );

  return {
    perSend,
    perSendTotalUsd,
    fixedMonthly,
    fixedMonthlyUsd,
    annualUsd: round(perSendTotalUsd * input.sendsPerYear + fixedMonthlyUsd * 12 + storageUsd),
    eventsPerSend: Math.round(events),
  };
}
