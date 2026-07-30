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
  ErasureRecord,
  SweepCheckpoint,
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
/**
 * Resolves a stored segment predicate to subscriber ids (#203).
 *
 * A PORT, not an import: `@addressium/segment` depends on this package, so
 * depending on it here would be a cycle. The shape is `SegmentEngine.resolve`,
 * so `GsiSegmentEngine` (and the OpenSearch one) satisfy it structurally with
 * nothing to adapt. Declared as a method so TypeScript's bivariant method
 * parameters accept an engine whose predicate type is narrower than `unknown`.
 */
export interface SegmentResolver {
  resolve(orgId: string, predicate: never): AsyncIterable<string>;
}

export interface SendDescriptor {
  orgId: string;
  campaignId: string;
  listId: string;
  subject: string;
  template: EmailTemplate;
  /**
   * Narrow this send to a segment's members (#203). The list still selects the
   * base set — a segment targets WITHIN a list, and the list is what carries the
   * from-address and the CAN-SPAM footer. Absent → the whole confirmed list.
   */
  segmentId?: string;
  /**
   * Recipient window for SQS fan-out of large lists. Absent → the whole list is
   * a candidate for fan-out; present → send only this slice of confirmed
   * recipients — a KEY RANGE over the confirmed set, never a numeric offset
   * (#171). See `RecipientSlice`.
   */
  slice?: RecipientSlice;
}

/**
 * One fan-out window, expressed as a half-open KEY RANGE `(after, until]` over
 * subscriber ids (#171).
 *
 * It used to be `{offset, limit}`. That is wrong for a set that can change while
 * the fan-out runs, and it changes constantly — people confirm and unsubscribe
 * during a send. Slices re-read the confirmed set at T1..Tn and re-sliced by a
 * number computed at T0, while DynamoDB returns rows ordered by subscriber id,
 * so a new signup lands at a RANDOM position and shifts every later index:
 *
 *  - an unsubscribe before the window pulls the boundary back by one, and the
 *    recipient who was last in the previous slice is **never sent**;
 *  - a confirmation before the window pushes it forward by one, and the
 *    recipient who was last in the previous slice is **sent twice**.
 *
 * A key range has no such dependency. Boundaries are ids fixed at plan time, so
 * a mutation elsewhere in the set cannot move them. The ranges are disjoint and
 * the last one is open-ended, so every id falls in exactly one window — and
 * someone who confirms mid-fan-out is picked up rather than dropped.
 */
export interface RecipientSlice {
  /** Exclusive lower bound. Absent on the first slice. */
  after?: string;
  /** Inclusive upper bound. Absent on the LAST slice, which runs to the end. */
  until?: string;
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
  /**
   * Give the address back, so it can be claimed again (#164).
   *
   * Only erasure calls this. The reservation item carries the plaintext address
   * in its SORT KEY, so leaving it behind means the erased person's email is
   * still sitting in the table under a different item — which is exactly the
   * "erasure did not erase" failure. Releasing it also means a later signup from
   * that address starts a genuinely new relationship with a new id, rather than
   * being handed the erased subscriber's.
   */
  releaseEmail(orgId: string, email: string): Promise<void>;
  /**
   * Delete the `externalId → sub` pointer (#164).
   *
   * Clearing `externalId` on the subscriber record is not enough: the pointer is
   * a SEPARATE item, and `findByExternalId` reads it first. Left behind, the
   * erased person is still resolvable from their Cognito `sub` — the single most
   * durable identifier in the system.
   */
  removeExternalIdPointer(orgId: string, externalId: string): Promise<void>;
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
   * One page of subscribers, optionally narrowed to an email PREFIX (#182).
   *
   * The admin search loaded EVERY subscriber for the org and filtered by
   * substring in Node. For a 500k-subscriber org that is hundreds of megabytes
   * across hundreds of sequential queries — typing in the console's search box
   * was a self-inflicted denial of service on the tenant's own table, and it
   * grew worse exactly as an org became more valuable.
   *
   * `emailPrefix` is served by the `gsi1` email index as a key condition, so the
   * read is proportional to the MATCHES rather than to the list. That is a
   * deliberate narrowing from substring to prefix: a substring match cannot use
   * any index, so the only honest choices were "prefix, bounded" or "substring,
   * unbounded". The console says which it is doing.
   *
   * `cursor` is opaque and comes from the previous page. It is the store's
   * pagination token verbatim, so callers cannot construct one that skips the
   * org scoping.
   */
  page(
    orgId: string,
    opts?: { limit?: number; emailPrefix?: string; cursor?: string },
  ): Promise<{ items: Subscriber[]; cursor?: string }>;
  /**
   * Advance `lastEngagedAt` to `at` if it's newer (monotonic). Called on a CLICK
   * only — opens don't count. No-op if the subscriber is unknown. O(1) update.
   */
  markEngaged(orgId: string, sub: string, at: string): Promise<void>;
}

export interface SubscriptionStore {
  get(orgId: string, sub: string, listId: string): Promise<Subscription | undefined>;
  put(s: Subscription): Promise<void>;
  /**
   * Every confirmed subscription on a list, ordered by subscriber id.
   *
   * Used to PLAN a fan-out, which needs the whole ordered set to compute
   * boundaries. Sending uses `confirmedRange` instead — see below.
   */
  listConfirmed(orgId: string, listId: string): Promise<Subscription[]>;
  /**
   * The confirmed subscriptions in one half-open key range `(after, until]`
   * (#182).
   *
   * `listConfirmed` + `recipientsInSlice` read the ENTIRE list and then threw
   * away everything outside the window, so a 250-slice campaign performed 250
   * full-list reads to send 250 windows — quadratic in list size, on the hottest
   * path in the system. This pushes the range into the query.
   *
   * The ordering and the range semantics must match `planFanOut` exactly: the
   * ranges are disjoint, the last is open-ended, and the boundaries are
   * subscriber ids rather than offsets (#171).
   */
  confirmedRange(orgId: string, listId: string, range?: RecipientSlice): Promise<Subscription[]>;
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
  /**
   * Add many entries at once (#240).
   *
   * Exists because the migration path is the one caller that arrives with a
   * whole list rather than one address. A Pinpoint account's suppression list is
   * years of accumulated hard bounces and complaints, and `add`-per-address
   * turns that into one round trip each — slow enough that an operator abandons
   * it half-done, which is the worst outcome available: subscribers imported,
   * suppressions partially applied, first campaign sent.
   *
   * Implementations MUST be idempotent per (scope, email) — re-running an import
   * overwrites rather than duplicating — and MUST NOT assume the input is free
   * of duplicates.
   */
  addMany(entries: SuppressionEntry[]): Promise<void>;
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
  /**
   * Delete every engagement event naming this subscriber, across campaigns
   * (#164). Returns how many were removed.
   *
   * Events live under the CAMPAIGN partition, so there is no per-subscriber
   * index and this walks the org's campaigns. That is deliberate: erasure is
   * rare and correctness matters more than its cost, and adding a GSI keyed by
   * subscriber would create a second place the identifier lives — the opposite
   * of what this method exists for.
   *
   * Campaign COUNTERS are not adjusted. They are stored separately and are
   * aggregate statistics, not personal data; decrementing them would rewrite
   * historical reports to hide that a send happened, which is not what an
   * erasure request asks for.
   */
  deleteForSubscriber(orgId: string, subscriberId: string): Promise<number>;
}

/**
 * Where a long-running org sweep got to (#233, #182).
 *
 * One item per (org, sweep). Kept in its own store rather than on the
 * Organization record: the org record is read on every send, and a sweep that
 * checkpoints every page would turn a hot read into a hot WRITE.
 */
export interface SweepCheckpointStore {
  get(orgId: string, sweep: SweepCheckpoint["sweep"]): Promise<SweepCheckpoint | undefined>;
  put(c: SweepCheckpoint): Promise<void>;
  clear(orgId: string, sweep: SweepCheckpoint["sweep"]): Promise<void>;
}

/** Erasure tombstones (#164) — see `ErasureRecord`. */
export interface ErasureStore {
  put(e: ErasureRecord): Promise<void>;
  get(orgId: string, subscriberId: string): Promise<ErasureRecord | undefined>;
  list(orgId: string): Promise<ErasureRecord[]>;
}

export interface EntitlementStore {
  put(e: EntitlementSync): Promise<void>;
  latest(orgId: string, subscriberId: string): Promise<EntitlementSync | undefined>;
  /**
   * Drop the entitlement record for an erased subject (#164). It carries the
   * subscriber id and the billing system's name — a direct link between the
   * person and their payment relationship, which survived erasure entirely.
   */
  remove(orgId: string, subscriberId: string): Promise<void>;
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

/**
 * Deliverability halt markers for send ids that have NO Campaign record —
 * recurring-series editions (`<base>-<editionKey>`), drip sub-campaigns and
 * re-engagement steps. Their halt cannot live on `Campaign.status` because
 * there is no row to flip; without this store, `checkDeliverability` silently
 * dropped the halt for exactly the sends most likely to need it. Written by
 * `checkDeliverability`, read by the send path's halt gate. Kept out of
 * `CampaignStore` so halted editions never appear as phantom campaigns in
 * `campaigns.list` (the console list, usage rollups).
 */
export interface HaltStore {
  isHalted(orgId: string, campaignId: string): Promise<boolean>;
  halt(orgId: string, campaignId: string, at: string): Promise<void>;
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
  /**
   * Marketing or transactional (#237). Drives which SES configuration set the
   * message goes out on, so a marketing complaint spike does not drag
   * confirmation mail down with it — and confirmation mail failing is what
   * stops new subscribers arriving, i.e. the reputation problem would otherwise
   * eat its own recovery path. Absent is read as `marketing`, the safer default:
   * it applies the STRICTER eligibility rules.
   */
  emailClass?: import("@addressium/core").EmailClass;
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
  /**
   * What this token is FOR (#74). Absent means `confirm`, which is what every
   * token minted before the preference centre existed is.
   *
   * This is a token-confusion guard, and it is the security property the whole
   * preference centre rests on. Without it, a confirmation link — which anyone
   * who can read one email holds — would also open a management session over
   * EVERY list that person is on, and the long-lived unsubscribe token in every
   * message ever sent would do the same. One scope, one capability.
   */
  scope?: "confirm" | "manage";
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

/**
 * One subscriber's enrollment into one drip sequence — the whole execution input
 * the drip state machine needs to run (§4.6, #245).
 *
 * The machine starts at its WAIT rather than at step 0 (#201), so the caller
 * supplies both the first step and the wait in front of it: `start` is a request
 * to ENROLL, not to send. Every field is required because the machine's step Task
 * reads each one by JSONPath, and a JSONPath onto a field the input omits is a
 * `States.Runtime` failure at the first transition rather than a validation error
 * anywhere useful.
 */
export interface DripEnrollment {
  orgId: string;
  sequenceId: string;
  subscriberId: string;
  /** Index of the first step to run. Always 0 for a new enrollment. */
  nextStepIndex: number;
  /** Seconds the machine waits before running `nextStepIndex`. */
  nextWaitSeconds: number;
  /**
   * WHICH enrollment this is — stable across retries of one opt-in, different
   * for a genuine re-subscribe. It is both the idempotency key (the execution
   * name is derived from it) and the send-claim namespace for every step in the
   * run, so a subscriber who leaves and comes back gets the sequence again
   * instead of finding every claim already burned (the #207 failure, one
   * automation over). See `enrollmentIdFor` in drip.ts for how it is derived.
   */
  enrollmentId: string;
}

/**
 * Starts a drip/journey execution for one subscriber (Step Functions in prod,
 * captured in tests — §4.6, #245).
 *
 * Implementations MUST be idempotent per `enrollmentId`: a subscriber who clicks
 * the confirmation link three times enrolls once, and a caller may safely retry.
 * Callers therefore do not — and must not — track what they have already started.
 */
export interface DripStarter {
  start(enrollment: DripEnrollment): Promise<void>;
}

/**
 * One entry from a sending provider's account-level suppression list (#240).
 *
 * `reason` is the provider's own classification, kept in the provider's spelling
 * rather than pre-mapped: the mapping to a `SuppressionSource`/`SuppressionScope`
 * is a domain decision with compliance weight, and it belongs in one reviewable
 * place (`importSuppressionList`) rather than spread across adapters.
 */
export interface SuppressedDestination {
  email: string;
  /** SES publishes exactly these two. An unrecognized value is not guessed at. */
  reason: string;
  /** When the provider recorded it (ISO). Absent if the provider did not say. */
  at?: string;
}

/**
 * Reads a provider's account suppression list, page by page (SES v2 in prod —
 * §4.7, §4.13, #240).
 *
 * An `AsyncIterable` rather than an array on purpose. The list is unbounded from
 * our side — it is however many addresses the operator's account accumulated
 * before they found us — so materializing it costs memory we cannot predict, in a
 * Lambda, at exactly the moment the operator is least willing to see a failure.
 * Pagination lives in the adapter; the domain consumes a stream and batches its
 * writes.
 */
export interface SuppressionListReader {
  list(): AsyncIterable<SuppressedDestination>;
}

/**
 * A live, single-address view of the provider's account suppression list (SES
 * in prod — §4.7, §4.13, #247). The console equivalent of
 * `aws sesv2 get-suppressed-destination` / `put-suppressed-destination`.
 *
 * Distinct from `SuppressionListReader`, which walks the WHOLE account list for
 * a bulk migration import. This is a point lookup and a single deliberate
 * write, both scoped to one address an operator is looking at right now — a
 * different risk shape from importing or overwriting the account list wholesale
 * (see `ses-suppression.ts`'s note on why bulk writing back to SES is never
 * automated).
 */
export interface SuppressionChecker {
  /**
   * The account-list entry for this address, or `undefined` if the provider
   * says it is NOT suppressed. Must not be confused with "the check failed" —
   * callers that need to tell those apart catch separately.
   */
  get(email: string): Promise<SuppressedDestination | undefined>;
  /**
   * Add this address to the PROVIDER's account suppression list — mirrors
   * `put-suppressed-destination`. `reason` is deliberately narrower than
   * `SuppressionSource`: SES's own API accepts only `BOUNCE` and `COMPLAINT`,
   * so a `manual` (no-reason) suppression never reaches this method — it stays
   * local only, which is also why the two reasons this DOES accept are exactly
   * the ones that scope GLOBAL in our own store (`scopeForSuppressionSource`).
   */
  put(email: string, reason: "BOUNCE" | "COMPLAINT"): Promise<void>;
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
  /** Halt markers for record-less send ids (recurring editions, drip, re-engagement). */
  halts: HaltStore;
  series: CampaignSeriesStore;
  schedules: SendScheduleStore;
  templates: TemplateStore;
  alerts: AlertConfigStore;
  usage: UsageStore;
  segments: SegmentStore;
  /** Erasure tombstones (#164). */
  erasures: ErasureStore;
  /** Resumable sweep progress (#233). */
  sweepCheckpoints: SweepCheckpointStore;
  importMappings: ImportMappingStore;
  importBatches: ImportBatchStore;
  dripSequences: DripSequenceStore;
}
