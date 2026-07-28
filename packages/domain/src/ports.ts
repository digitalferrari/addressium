/**
 * Ports (hexagonal boundaries) for the vertical slice.
 *
 * Domain logic depends only on these interfaces, so it runs against in-memory
 * adapters in tests and against DynamoDB / SES / KMS in production — no rewrite.
 */
import type {
  AlertConfig,
  Campaign,
  CampaignSeries,
  DripSequence,
  EmailArchive,
  EngagementEvent,
  EntitlementSync,
  ImportBatch,
  ImportMapping,
  List,
  Organization,
  Segment,
  SendScheduleState,
  Subscriber,
  Template,
  Subscription,
  SuppressionEntry,
  SuppressionScope,
  UsageRecord,
  DeployedVersion,
} from "@addressium/core";
import type { EmailTemplate } from "./render.js";

/** The unit of work sent through the queue and produced by a schedule firing. */
export interface SendDescriptor {
  orgId: string;
  campaignId: string;
  listId: string;
  subject: string;
  template: EmailTemplate;
  /**
   * Recipient window for SQS fan-out of large lists. Absent → the whole list is
   * a candidate for fan-out; present → send only this slice of confirmed
   * recipients (offset/limit over the confirmed set).
   */
  slice?: { offset: number; limit: number };
}

/**
 * Paces sends to respect the SES account/org rate. `acquire` resolves once a
 * send token is available (TokenBucket in prod; immediate in tests).
 */
export interface SendThrottle {
  acquire(n?: number): Promise<void>;
}

export interface OrganizationStore {
  get(orgId: string): Promise<Organization | undefined>;
  put(org: Organization): Promise<void>;
  list(): Promise<Organization[]>;
}

/**
 * A conditional write lost a race (#194). The caller re-reads and decides: for
 * erasure that means retrying against the record that actually exists now, and
 * for a template save it means telling the operator their edit was overwritten
 * rather than silently discarding one of the two bodies.
 */
export class ConcurrentModificationError extends Error {
  constructor(what: string) {
    super(`${what} was modified concurrently`);
    this.name = "ConcurrentModificationError";
  }
}

export interface SubscriberStore {
  get(orgId: string, sub: string): Promise<Subscriber | undefined>;
  findByEmail(orgId: string, email: string): Promise<Subscriber | undefined>;
  /** Resolve by the external pool's Cognito `sub` (the stable identity join key). */
  findByExternalId(orgId: string, externalId: string): Promise<Subscriber | undefined>;
  /**
   * Write the subscriber, bumping `rev`.
   *
   * `opts.ifRev` makes it conditional (#194): the write is refused with a
   * `ConcurrentModificationError` unless the stored `rev` still matches. Use it
   * on any read-modify-write whose loss would be a compliance failure rather
   * than an inconvenience — erasure above all, where a concurrent upsert
   * silently un-erases someone. Unconditional stays the default because most
   * writes are last-writer-wins by intent (a status bump, an engagement stamp).
   */
  put(sub: Subscriber, opts?: { ifRev?: number }): Promise<void>;
  /**
   * Claim `email` for `sub`, atomically (#194).
   *
   * Returns the `sub` that HOLDS the address — `sub` itself if this call won,
   * someone else's if it did not. Callers must use the returned id rather than
   * the one they proposed.
   *
   * `findByEmail` reads an eventually-consistent GSI with no uniqueness
   * constraint, so two concurrent signups for one address both saw "no such
   * subscriber" and both created a record. Later lookups then resolved
   * non-deterministically, and an erasure could report success while a complete
   * duplicate profile survived alongside it. A conditional write on a single
   * item is the only thing that actually decides a race.
   */
  reserveEmail(orgId: string, email: string, sub: string): Promise<{ sub: string }>;
  /** Strongly-consistent read, for the moment after losing a reservation. */
  getConsistent(orgId: string, sub: string): Promise<Subscriber | undefined>;
  /** Enumerate every subscriber for an org — batch sweeps (re-engagement, reporting). */
  list(orgId: string): Promise<Subscriber[]>;
  /**
   * The same enumeration, one page at a time (#224, #182). Bulk export is the
   * one caller for which `list` is wrong: an org's entire subscriber base in a
   * single array is exactly the Lambda OOM #182 is about, and it is the largest
   * org — the one most likely to be leaving — that hits it first.
   */
  stream(orgId: string): AsyncIterable<Subscriber>;
  /**
   * Advance `lastEngagedAt` to `at` if it's newer (monotonic). Called on a CLICK
   * only — opens don't count. No-op if the subscriber is unknown. O(1) update.
   */
  markEngaged(orgId: string, sub: string, at: string): Promise<void>;
}

export interface SubscriptionStore {
  get(orgId: string, sub: string, listId: string): Promise<Subscription | undefined>;
  put(s: Subscription): Promise<void>;
  listConfirmed(orgId: string, listId: string): Promise<Subscription[]>;
  /** All of a subscriber's subscriptions across lists (preference center, unsub-all). */
  listBySubscriber(orgId: string, subscriberId: string): Promise<Subscription[]>;
}

export interface ListStore {
  get(orgId: string, listId: string): Promise<List | undefined>;
  put(l: List): Promise<void>;
  list(orgId: string): Promise<List[]>;
}

/**
 * Import batches (#223). `listRows` resolves via pointer items rather than a
 * GSI — the same trick `findByExternalId` uses — because an import writes them
 * once and reads them rarely.
 */
export interface ImportBatchStore {
  get(orgId: string, batchId: string): Promise<ImportBatch | undefined>;
  list(orgId: string): Promise<ImportBatch[]>;
  put(b: ImportBatch): Promise<void>;
  /** Record that this batch wrote this subscription. */
  addRow(orgId: string, batchId: string, subscriberId: string, listId: string): Promise<void>;
  listRows(orgId: string, batchId: string): Promise<{ subscriberId: string; listId: string }[]>;
}

/** Saved import mappings (#216), looked up by header fingerprint. */
export interface ImportMappingStore {
  list(orgId: string): Promise<ImportMapping[]>;
  /** Every mapping saved against this header set — usually zero or one. */
  findByFingerprint(orgId: string, fingerprint: string): Promise<ImportMapping[]>;
  put(m: ImportMapping): Promise<void>;
  remove(orgId: string, mappingId: string): Promise<void>;
}

export interface SegmentStore {
  get(orgId: string, segmentId: string): Promise<Segment | undefined>;
  put(s: Segment): Promise<void>;
  list(orgId: string): Promise<Segment[]>;
}

export interface SuppressionStore {
  /** Suppressed for this org given the deployment scope (§4.13). */
  isSuppressed(orgId: string, email: string): Promise<boolean>;
  add(e: SuppressionEntry): Promise<void>;
  /** The matching suppression entries (org + global) for an email — to inspect source/scope (#58). */
  entriesFor(orgId: string, email: string): Promise<SuppressionEntry[]>;
  /** Remove a suppression entry (e.g. self-clear a prior unsubscribe on genuine re-opt-in). */
  remove(orgId: string, email: string, scope: SuppressionScope): Promise<void>;
  /** Org-scoped suppression entries, for the admin suppression-list view (#102). */
  list(orgId: string): Promise<SuppressionEntry[]>;
}

export interface ArchiveStore {
  get(orgId: string, campaignId: string): Promise<EmailArchive | undefined>;
  put(a: EmailArchive): Promise<void>;
}

export interface EventStore {
  append(e: EngagementEvent): Promise<void>;
  all(orgId: string, campaignId: string): Promise<EngagementEvent[]>;
}

export interface EntitlementStore {
  put(e: EntitlementSync): Promise<void>;
  latest(orgId: string, subscriberId: string): Promise<EntitlementSync | undefined>;
}

/**
 * The deployed-version marker (#213). A singleton item, not org-scoped: it
 * describes the installation, and the migration runner reads it to decide which
 * migrations are pending.
 */
export interface VersionStore {
  get(): Promise<DeployedVersion | undefined>;
  put(v: DeployedVersion): Promise<void>;
}

/** Idempotency guard: claim a campaign send exactly once (SQS is at-least-once). */
export interface SendClaimStore {
  /** True if newly claimed (dispatch it); false if already dispatched. */
  claim(orgId: string, campaignId: string): Promise<boolean>;
  /**
   * Give a claim back when the dispatch it guarded did NOT happen, so a retry
   * can try that recipient again. Without this a failed send burns the claim and
   * the recipient is silently never emailed (#163). Must be idempotent.
   */
  release(orgId: string, campaignId: string): Promise<void>;
}

export interface CampaignStore {
  get(orgId: string, campaignId: string): Promise<Campaign | undefined>;
  put(c: Campaign): Promise<void>;
  list(orgId: string): Promise<Campaign[]>;
}

export interface CampaignSeriesStore {
  get(orgId: string, seriesId: string): Promise<CampaignSeries | undefined>;
  put(s: CampaignSeries): Promise<void>;
}

/** Send-schedule lifecycle records (§4.6). Never deleted — pause/archive flip status. */
export interface SendScheduleStore {
  get(orgId: string, scheduleId: string): Promise<SendScheduleState | undefined>;
  put(s: SendScheduleState): Promise<void>;
  list(orgId: string): Promise<SendScheduleState[]>;
}

/** Reusable templates (§4.15): visual (MJML), MJML source, or raw HTML. */
export interface TemplateStore {
  get(orgId: string, templateId: string): Promise<Template | undefined>;
  /** `opts.ifVersion` guards the read-modify-write in `saveTemplate` (#194). */
  put(t: Template, opts?: { ifVersion?: number }): Promise<void>;
  list(orgId: string): Promise<Template[]>;
}

/** Drip/journey sequence definitions (§4.6). */
export interface DripSequenceStore {
  get(orgId: string, sequenceId: string): Promise<DripSequence | undefined>;
  put(s: DripSequence): Promise<void>;
  list(orgId: string): Promise<DripSequence[]>;
}

/** Per-org deliverability alert configuration (SNS topic + thresholds, §4.18). */
export interface AlertConfigStore {
  get(orgId: string): Promise<AlertConfig | undefined>;
  put(config: AlertConfig): Promise<void>;
}

/** The payload published to an org's SNS topic on a threshold breach. */
export interface AlertMessage {
  orgId: string;
  campaignId: string;
  at: string;
  breaches: Array<{ metric: string; level: "warn" | "halt"; value: number; threshold: number }>;
  action: "warned" | "halted";
}

/** Publishes deliverability alerts (SNS in prod; captured in tests). */
export interface AlertPublisher {
  publish(topicArn: string, message: AlertMessage): Promise<void>;
}

/** Per-org usage/cost records for chargeback (§11). */
export interface UsageStore {
  get(orgId: string, period: string): Promise<UsageRecord | undefined>;
  put(record: UsageRecord): Promise<void>;
  listByOrg(orgId: string): Promise<UsageRecord[]>;
}

/** What actually puts mail on the wire (SES in prod; capture in tests). */
export interface SentMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text alternative part. Improves deliverability/spam scoring
   *  and is expected by many clients; the SES adapter emits it as Body.Text. */
  text?: string;
  /** RFC 8058 List-Unsubscribe header value, angle-bracketed. An `https` URI
   *  supports one-click POST; a `mailto:` value does not (see SesEmailSender). */
  listUnsubscribe: string;
  /**
   * Correlation ids stamped as SES message tags so the event feed can map a
   * bounce/complaint/open/click back to a subscriber. Without them SES events
   * carry no way to identify the recipient and are unprocessable (#184).
   */
  tags?: { orgId: string; campaignId: string; subscriberId: string };
}
export interface EmailSender {
  send(msg: SentMessage): Promise<void>;
}

/** Signs & verifies the internal double-opt-in confirmation token (HMAC). */
export interface ConfirmClaims {
  orgId: string;
  sub: string;
  /** Single-list opt-in (public signup). */
  listId?: string;
  /** Multi-list opt-in (the "All newsletters" page) — one confirmation covers all. */
  listIds?: string[];
  exp: number;
}
export interface ConfirmationTokenSigner {
  sign(payload: ConfirmClaims): string;
  verify(token: string): ConfirmClaims;
}

/**
 * Provisions a subscriber Cognito account in the org's LINKED pool (#62). This
 * is the one place addressium may WRITE to that pool, and it happens on double
 * opt-in confirm for every org with magic links on — the token has to carry a
 * pool `sub`, so there is nothing to opt into. A port so it stays injectable and
 * an org with magic links off never touches Cognito at all.
 *
 * The adapter — not this interface's callers — validates and normalizes the
 * address (it becomes the Cognito `Username`) and sets a random permanent
 * password, so `ensureAccount` is more than a thin AdminCreateUser.
 */
export interface SubscriberAccountProvisioner {
  /** Ensure a user exists for `email` in `poolId`; return its Cognito `sub`. Idempotent. */
  ensureAccount(poolId: string, email: string): Promise<{ externalId: string }>;
}

/** Mints the per-recipient magic-link JWT for editorial links (§4.15). */
export interface MagicLinkSigner {
  /** Returns a signed ES256 JWT for the given subscriber. */
  mint(input: {
    orgId: string;
    sub: string;
    /**
     * The subscriber's `sub` in the org's linked Cognito pool
     * (`Subscriber.externalId`). Required: a token minted without it cannot be
     * resolved to a pool user client-side, which is the whole point of the
     * claim, so the send path skips the token instead of minting a useless one.
     */
    externalId: string;
    entitlement: "free" | "paid";
    entitlementAsof?: string;
  }): Promise<string>;
}

/** Enqueue a send for the sender to consume (SQS in prod). */
export interface SendQueue {
  enqueue(descriptor: SendDescriptor): Promise<void>;
}

/**
 * Schedules future sends (EventBridge Scheduler in prod). One-off schedules
 * target the send queue directly and auto-delete after firing; recurring
 * schedules target a launch handler that builds each edition.
 */
export interface CampaignScheduler {
  scheduleOneOff(input: { name: string; at: Date; descriptor: SendDescriptor }): Promise<void>;
  scheduleRecurring(input: {
    name: string;
    /** cron/rate expression, e.g. "cron(0 6 * * ? *)". */
    cron: string;
    timezone: string;
    payload: unknown;
  }): Promise<void>;
  cancel(name: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Stores {
  organizations: OrganizationStore;
  subscribers: SubscriberStore;
  subscriptions: SubscriptionStore;
  lists: ListStore;
  suppression: SuppressionStore;
  archive: ArchiveStore;
  events: EventStore;
  entitlements: EntitlementStore;
  sendClaims: SendClaimStore;
  version: VersionStore;
  campaigns: CampaignStore;
  series: CampaignSeriesStore;
  schedules: SendScheduleStore;
  templates: TemplateStore;
  alerts: AlertConfigStore;
  usage: UsageStore;
  segments: SegmentStore;
  importMappings: ImportMappingStore;
  importBatches: ImportBatchStore;
  dripSequences: DripSequenceStore;
}
