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
/**
 * Rough DynamoDB table size for an org (#321).
 *
 * Subscriber rows plus the engagement events they generate. Events dominate at
 * any real send cadence — a subscriber row is written once, while every send
 * produces a `sent` and a `delivered` plus opens and clicks.
 *
 * Measured against the live dev table: an event row is ~310 bytes and a
 * subscriber row ~400, both well under DynamoDB's 1 KB billing unit.
 */
function estimatedTableGb(input: SendCostInput): number {
  const eventsPerSend = input.subscribers * (2 + input.openRate + input.clickRate + input.bounceRate);
  const bytes = input.subscribers * 400 + eventsPerSend * input.sendsPerYear * 410;
  return bytes / 1024 ** 3;
}

export const PRICES = {
  /** SES: $0.10 per 1,000 outbound messages. Attachments are extra; we send none. */
  sesPerEmail: 0.10 / 1_000,
  /** DynamoDB on-demand write request unit (1 KB). */
  ddbWriteUnit: 1.25 / 1_000_000,
  /** DynamoDB on-demand read request unit (4 KB, eventually consistent = 0.5). */
  ddbReadUnit: 0.25 / 1_000_000,
  /** DynamoDB storage, per GB-month. */
  ddbStorageGbMonth: 0.25,
  /**
   * AWS Backup warm storage for DynamoDB, per GB-month.
   *
   * Billed on the SIZE OF EACH RECOVERY POINT, not on the table once: a daily
   * plan keeping 35 days holds 35 copies. That is what makes backup a multiple
   * of table size rather than an increment, and it is the line operators are
   * most often surprised by.
   *
   * Restores are billed separately and are not modelled: they are a one-off
   * incident cost, not a running one.
   */
  backupDdbGbMonth: 0.10,
  /** AWS Backup warm storage for S3, per GB-month. */
  backupS3GbMonth: 0.05,
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
  /** CloudWatch dashboard, per dashboard-month (first 3 are free). */
  dashboardMonth: 3.00,
  /** CloudWatch Logs ingest, per GB. */
  logsIngestGb: 0.50,
  /** S3 Standard storage, per GB-month. */
  s3StorageGbMonth: 0.023,
  /** S3 PUT/COPY/POST/LIST request. */
  s3PutRequest: 5.00 / 1_000_000,
} as const;

/**
 * Bytes of CloudWatch Logs a send generates, measured rather than guessed.
 *
 * The send path logs PER SLICE, not per recipient: `services/sender` has two
 * `console.*` calls and both are error paths, and `packages/domain/src/send.ts`
 * has none. So the sender contributes only Lambda's own START/END/REPORT lines
 * once per slice — a few thousand lines a year, not a few million.
 *
 * The events handler is the real volume: roughly four engagement events per
 * email, batched ten to an invocation.
 */
const LOG_BYTES_PER_INVOCATION = 600;
const EVENTS_PER_EMAIL = 4;
const EVENTS_BATCH_SIZE = 10;

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
  /** CloudWatch dashboards. The stack ships one ops dashboard. */
  dashboards: number;
  /** Secrets Manager secrets. */
  secrets: number;
  /**
   * Is AWS Backup on? (#321)
   *
   * Default true, because it is on for prod and for any stage running with
   * `prodParity` — and a cost model that omits a standing charge the deployment
   * actually incurs is worse than one that overstates it.
   */
  backupEnabled?: boolean;
}

export const DEFAULT_COST_INPUT: SendCostInput = {
  subscribers: 40_000,
  sendsPerYear: 1,
  openRate: 0.40,
  clickRate: 0.05,
  bounceRate: 0.02,
  orgs: 1,
  alarms: 30,
  dashboards: 1,
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
    ...(input.backupEnabled === false
      ? []
      : [
          {
            /*
             * Backup is billed per RECOVERY POINT, not per table. The plan keeps
             * 35 daily points plus 12 monthly ones, so warm storage holds ~35
             * copies of the table in steady state — which is why this is a
             * MULTIPLE of table size rather than an increment, and the line
             * operators are most often surprised by.
             *
             * Incremental after the first: DynamoDB backups store changed data
             * only, so 35 points cost far less than 35 full tables. Modelled at
             * ~4x the table (one full plus 34 deltas of a list that grows
             * slowly) rather than 35x, which would be alarmist.
             */
            label: "AWS Backup (35 daily + 12 monthly)",
            usd: round(estimatedTableGb(input) * 4 * PRICES.backupDdbGbMonth),
            detail: `~${(estimatedTableGb(input) * 4).toFixed(2)} GB warm storage × $0.10/GB-month`,
          },
        ]),
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
    {
      // The ops dashboard. Counted because it is the single largest of the
      // items this model used to omit — and, at $3, still smaller than one
      // day of SES at this volume. Worth stating rather than hiding.
      label: "CloudWatch dashboard",
      usd: round(input.dashboards * PRICES.dashboardMonth),
      detail: `${input.dashboards} × $3.00/month`,
    },
  ];
  const fixedMonthlyUsd = round(fixedMonthly.reduce((s, l) => s + l.usd, 0));

  // Logs, measured from what the code actually emits. The sender contributes
  // one invocation's worth per SLICE; the events handler one per batch of ten
  // engagement events. Neither logs per recipient, which is why this is cents
  // rather than the dominant line it would otherwise be.
  const eventInvocations = (events * input.sendsPerYear) / EVENTS_BATCH_SIZE;
  const logGb =
    ((eventInvocations + senderInvocations * input.sendsPerYear) * LOG_BYTES_PER_INVOCATION) / 1e9;
  const logsUsd = round(logGb * PRICES.logsIngestGb);

  // One rendered body archived per campaign, kept indefinitely.
  const archiveUsd = round(
    input.sendsPerYear * PRICES.s3PutRequest +
      ((input.sendsPerYear * 60_000) / 1e9) * PRICES.s3StorageGbMonth * 6,
  );

  const storageUsd = round(
    averageStorageGb(events, input.sendsPerYear) * PRICES.ddbStorageGbMonth * 12,
  );

  return {
    perSend,
    perSendTotalUsd,
    fixedMonthly,
    fixedMonthlyUsd,
    annualUsd: round(
      perSendTotalUsd * input.sendsPerYear + fixedMonthlyUsd * 12 + storageUsd + logsUsd + archiveUsd,
    ),
    eventsPerSend: Math.round(events),
  };
}
