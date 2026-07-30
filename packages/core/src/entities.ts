/**
 * Core domain entities for addressium.
 *
 * This mirrors the data model in docs/ARCHITECTURE.md §5. DynamoDB is a single
 * table; every item carries an `orgId` that prefixes its partition key so silos
 * never intermix (§4.11). These types are the single source of truth shared by
 * the API, sender, events processor and the frontends.
 */

// ---- id aliases (branding kept lightweight for now) ----
export type OrgId = string;
export type SubscriberId = string; // Cognito `sub`, unique within an org
export type ListId = string;
export type SegmentId = string;
export type SeriesId = string;
export type CampaignId = string;
export type TemplateId = string;

// ---- enums ----
export type Entitlement = "free" | "paid";
export type OptInPolicy = "single" | "double";
export type ListVisibility = "open" | "closed";
export type ListAccess = "free" | "paid";
export type SubscriptionStatus =
  | "pending"
  | "confirmed"
  | "unsubscribed"
  | "bounced"
  | "complained";
export type Cadence = "one_off" | "daily" | "weekly" | "biweekly" | "monthly";
export type TemplateMode = "visual" | "mjml" | "raw_html";
export type SuppressionSource = "bounce" | "complaint" | "manual" | "unsubscribe" | "inactive";
/**
 * What kind of message this is (#237).
 *
 * The distinction is not cosmetic — it decides ELIGIBILITY. A newsletter
 * unsubscribe is a statement about marketing, not about the password-reset mail
 * or the receipt the same person triggers ten minutes later; sending those
 * anyway is normal and lawful. A hard bounce or a spam complaint is a statement
 * about the ADDRESS, and binds both classes absolutely.
 *
 * `SUPPRESSION_BINDING_ON_TRANSACTIONAL` in the domain is where that line lives.
 */
export type EmailClass = "marketing" | "transactional";
export type SuppressionScope = "global" | "org";
export type DeploymentSuppressionScope = "global" | "org" | "hybrid";
export type MergeTagSource = "profile" | "feed" | "system" | "token_claim";
export type MergeTagScope = "per_recipient" | "per_campaign" | "token_claim";
export type IpMode = "shared" | "dedicated";
/**
 * DMARC enforcement published in the org's `_dmarc` record (#200). `none` is
 * monitor-only: receivers report failures and deliver the mail anyway, so a
 * domain left there has DMARC records without DMARC protection.
 */
export type DmarcPolicy = "none" | "quarantine" | "reject";
export type OrgEnvironment = "prod" | "dev";
export type LinkClass = "editorial" | "advertising";
export type EventType =
  | "sent"
  | "delivered"
  | "open"
  | "click"
  | "bounce"
  | "complaint"
  | "unsubscribe"
  /**
   * SES accepted the message and then refused to send it — a virus or blocked
   * content (#241). Deliberately NOT `bounce`: nothing was delivered and no
   * receiver rejected it, so suppressing the address would punish a subscriber
   * for our attachment. It is also not `delivered`, which is why it needs a type
   * of its own — folded into either one, `sent` overstates what left the building
   * and the operator has no signal at all.
   */
  | "reject"
  /**
   * A merge tag failed to substitute, so SES could not build the message (#241).
   * The one event in the feed that points at OUR bug rather than a recipient's
   * mailbox, which is why it is surfaced loudly rather than merely counted.
   */
  | "rendering_failure"
  /**
   * Temporary trouble on the way to the inbox — a full mailbox, a throttling
   * receiver, an expired handshake (#241). Informational: it is the early warning
   * ahead of a possible bounce, and it MUST NOT suppress, because most delays
   * resolve on their own. Same reasoning as the transient-bounce gate (#211).
   */
  | "delivery_delay";

export interface Consent {
  timestamp: string; // ISO-8601
  /**
   * The requester's IP, when it is genuinely known. OMITTED otherwise — this
   * used to be hardcoded `"0.0.0.0"`, and a consent record asserting an address
   * that is false is worse evidence than one that admits the field is missing
   * (#220).
   */
  ip?: string;
  userAgent?: string;
  sourceUrl?: string;
}

/**
 * Per-subscription proof of consent (#220, GDPR Art. 7(1) — "the controller
 * shall be able to demonstrate").
 *
 * Consent lives on the SUBSCRIBER too, but that record answers "did this person
 * ever agree to anything", not "did they agree to THIS newsletter". A reader who
 * opted into one list in 2019 and another in 2026 has two different consents,
 * and only the per-list record can answer a dispute about either.
 *
 * Written once at signup and completed at confirmation; nothing else may
 * overwrite it. `updatedAt` cannot serve this purpose because every later status
 * change — unsubscribe, erase, import — rewrites it.
 */
export interface SubscriptionConsent {
  /** When this list was requested. */
  requestedAt: string;
  /** When double opt-in completed. Absent means never confirmed. */
  confirmedAt?: string;
  /** Omitted when unknown; never fabricated. */
  requestIp?: string;
  confirmIp?: string;
  userAgent?: string;
  sourceUrl?: string;
  /**
   * How we claim the right to mail them: `explicit` is double opt-in evidence,
   * `implicit` an existing relationship (an import, #223), `manual_admin` an
   * operator who confirmed the subscription by hand from the console (#205).
   * Absent on records written before this field existed — read as unknown, never
   * as explicit.
   *
   * `manual_admin` is a distinct value on purpose. A hand-confirmed subscription
   * bypassed double opt-in, and recording it as `explicit` would make an
   * administrative act indistinguishable from a real signup in precisely the
   * record a consent dispute turns on.
   */
  basis?: "explicit" | "implicit" | "manual_admin";
  /** The admin who acted, when the basis is `manual_admin` (#205). */
  actor?: string;
  /** Import batch that created this row, when it came from a file (#223). */
  importBatchId?: string;
}

// ---- tenancy & identity ----
export interface Organization {
  orgId: OrgId;
  name: string;
  domains: string[];
  /**
   * Cognito user pool shared with this org's main website, LINK-ONLY: the
   * operator creates and configures the pool, addressium only ever links to one
   * (a pool has far too many configuration options to own in-app) and creates
   * users inside it. Present if and only if `magicLink` is — see below.
   */
  subscriberPoolId?: string;
  /**
   * Per-org magic-link signing config (resolved by the sender at send time).
   *
   * ABSENT = the feature is OFF for this org: no linked pool, no KMS signing
   * key, no JWKS, no entitlement claim and no token — editorial links render
   * untokenized (still tracked) and addressium just sends the email. PRESENT
   * requires `subscriberPoolId`, because the token carries the pool's `sub` so
   * a paywall can resolve the reader entirely client-side (§4.9, §4.10).
   * `schemas.createOrgSchema` enforces that pair at the API boundary.
   */
  magicLink?: {
    /** KMS asymmetric key ARN — the key never leaves KMS. */
    kmsKeyArn: string;
    /** JWKS key id published for this key. */
    kid: string;
    /** Token issuer (`iss`). */
    issuer: string;
    /** Token audience (`aud`) — the org's main-site domain. */
    audience: string;
  };
  sesConfigSet: string;
  /**
   * The org's TRANSACTIONAL configuration set (#237). Absent on orgs provisioned
   * before it existed — the sender then falls back to `sesConfigSet` rather than
   * to no set at all, because a message with no configuration set publishes no
   * events, and a silent event plane is the failure mode #208 was.
   */
  sesTransactionalConfigSet?: string;
  /**
   * Custom MAIL FROM subdomain, e.g. `bounce.example.com` (#200). Absent on orgs
   * provisioned before it existed, which keeps the SES default return path and
   * therefore an SPF pass that DMARC will not count as aligned.
   */
  mailFromDomain?: string;
  /**
   * The DMARC policy published in the org's `_dmarc` record (#200).
   *
   * Optional because an org can be written straight to the store without going
   * through provisioning; absent is read as `none` everywhere. `none` is
   * monitor-only — the right place to START and the wrong place to stay, since
   * at `p=none` the domain is still freely spoofable.
   */
  dmarcPolicy?: DmarcPolicy;
  /**
   * Whether this org's mail leaves on a dedicated IP pool (#237).
   *
   * DERIVED from `dedicatedIpPoolName`, never set independently. It used to be
   * set from a `dedicatedIp` boolean on the create request and read by NOBODY —
   * no pool in CDK, no `PutDedicatedIpPool`, no assignment on any configuration
   * set. An operator could tick "dedicated IP", pay nothing extra, get shared
   * IPs, and have a database record saying otherwise. A field that reports a
   * capability the system does not have is worse than an absent one, because the
   * console shows it.
   */
  ipMode: IpMode;
  /**
   * An SES dedicated IP pool the OPERATOR created, assigned to this org's
   * configuration sets (#237).
   *
   * addressium does not create pools, for the same reason it does not create
   * WebACLs (#225): dedicated IPs are a standing charge (~$25/month each) and
   * need a deliberate warm-up plan, and provisioning one as a side effect of a
   * checkbox would bill the operator for infrastructure they did not knowingly
   * ask for. Create the pool in SES, then set this.
   */
  dedicatedIpPoolName?: string;
  suppressionScope: DeploymentSuppressionScope;
  /**
   * IANA time zone (e.g. "America/Denver"). Storage stays UTC; this is the zone
   * used to interpret RECURRING wall-clock send schedules (DST-aware) and to
   * bucket/display reporting. A recurring campaign may override it.
   */
  defaultTimezone: string;
  /** Subscriber-site branding/theme (§4.10, #31). */
  branding?: Branding;
  /** Public-signup bot protection (#62). */
  signupProtection?: SignupProtection;
  /**
   * Deployment environment for this org silo. `dev` orgs run on the exact same
   * prod workflows but are labeled in the console and excluded from cost/usage
   * rollups so a test publisher (e.g. devsummitdaily.com) can't be mistaken for
   * a live one. Absent on legacy records → treated as `prod`. (§4.11)
   */
  environment?: OrgEnvironment;
  /**
   * Send-time recipient allowlist, enforced only for `dev` orgs (§4.11). Each
   * entry is an exact email (case-insensitive) or an `@domain` suffix. A dev org
   * sends **only** to matching addresses; with no allowlist it sends to no one
   * (fail-closed), so a test campaign can never reach a real subscriber. Ignored
   * for `prod` orgs.
   */
  devAllowlist?: string[];
  /** Engagement-based sunset / win-back automation policy (§4.22). Off unless enabled. */
  reengagement?: ReengagementPolicy;
  setupComplete: boolean;
}

/**
 * Engagement-based list hygiene. When enabled, subscribers who haven't clicked
 * in `coldAfterDays` are enrolled into a win-back sequence of `steps` emails
 * spaced `stepIntervalDays` apart; if they click during it they graduate, and
 * if they never do they're unsubscribed from all lists and suppressed
 * (`source: "inactive"`, re-opt-in-able). Clicks — not opens — reset the clock.
 */
export interface ReengagementPolicy {
  enabled: boolean;
  /** No click for this many days → cold, enroll into the win-back sequence. Default 180. */
  coldAfterDays: number;
  /** Win-back emails to send before sunsetting. Default 3. */
  steps: number;
  /** Days between win-back steps. Default 7. */
  stepIntervalDays: number;
  /** Suppression scope applied on sunset. Default "org". */
  suppressScope?: SuppressionScope;
  /**
   * The list the win-back emails are sent on (#233).
   *
   * Required once the policy is enabled: the sweep sends real mail, and it has
   * to send it from a list that carries a from-address and a CAN-SPAM footer.
   * There is no sensible default — picking one for the operator would mail an
   * audience they did not choose.
   */
  listId?: string;
}

export interface SignupProtection {
  /** reCAPTCHA secret ARN for server-side verification. The site key lives in the embed snippet. */
  recaptchaSecretArn?: string;
}

/** Subscriber-site branding/theme (§4.10, #31). */
export type Background =
  | { type: "solid"; color: string }
  | { type: "gradient"; from: string; to: string; angle: number };
export interface Branding {
  logoUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  background: Background;
}

/** Per-list subscriber-site presentation toggles (§4.10, #33). */
export interface ListPresentation {
  showFrequency: boolean;
  showSendTime: boolean;
  showDescription: boolean;
  showReaderCount: boolean;
  showFreePaidCount: boolean;
  frequencyLabel?: string;
  sendTimeLabel?: string;
}

export interface Subscriber {
  orgId: OrgId;
  /** addressium's own durable id for this person (immutable primary key). */
  sub: SubscriberId;
  /**
   * The main pool's Cognito `sub`, once known (linked via identity sync / login).
   * This — not email — is the stable join key to the external user pool, so an
   * email change is just an attribute update on the record found by this id.
   */
  externalId?: string;
  email: string; // normalized (lowercased, trimmed) — MUTABLE attribute, not identity

  attributes: Record<string, string>;
  locale?: string;
  source?: string;
  consent?: Consent;
  status: "active" | "suppressed";
  entitlement: Entitlement;
  entitlementAsof?: string;
  /**
   * Timestamp of this subscriber's last *meaningful* engagement — a click.
   * Opens are deliberately NOT counted (Apple Mail Privacy Protection auto-opens
   * make them noise), so recency here is click-weighted. Advanced monotonically
   * by the events processor and used to detect cold subscribers for the
   * re-engagement / sunset automation (§4.22).
   */
  lastEngagedAt?: string;
  /** Win-back automation enrollment state, present only while enrolled (§4.22). */
  reengagement?: ReengagementState;
  /**
   * Optimistic-concurrency counter (#194). Bumped by the store on every write.
   *
   * Absent on records written before this field existed — a caller passing
   * `ifRev: undefined` is asking "this must still be the pre-rev record", which
   * is the honest reading and still fails closed the moment anything writes.
   *
   * Only compliance paths guard on it. Erasure is the one that matters: it is a
   * read-modify-write, and a concurrent identity-sync upsert or CSV import
   * landing between the read and the write RESTORES the PII while the caller is
   * told `{erased: true}`.
   */
  rev?: number;
}

/**
 * Where a cold subscriber sits in the win-back sequence. Set when enrolled,
 * advanced per step, and cleared on graduation (re-engaged) or sunset.
 */
export interface ReengagementState {
  /** When the subscriber was enrolled (start of the win-back sequence). */
  enrolledAt: string;
  /** How many win-back emails have gone out so far. */
  stepsSent: number;
  /** When the most recent win-back step was sent (spacing gate). */
  lastStepAt: string;
}

// ---- audience ----
export interface List {
  orgId: OrgId;
  listId: ListId;
  name: string;
  description?: string;
  optInPolicy: OptInPolicy;
  fromAddress: string;
  replyTo?: string;
  access: ListAccess;
  /** Whether the list appears on the public opt-in page and accepts signups. */
  visibility: ListVisibility;
  complianceFooter: string;
  physicalAddress: string;
  /** Subscriber-site presentation toggles (§4.10, #33). */
  presentation?: ListPresentation;
}

export interface Subscription {
  orgId: OrgId;
  subscriberId: SubscriberId;
  listId: ListId;
  status: SubscriptionStatus;
  updatedAt: string;
  /**
   * Immutable proof of consent for THIS list (#220). Optional so records
   * written before it existed still read; absent means "no provenance", which
   * is a fact worth surfacing rather than papering over.
   */
  consent?: SubscriptionConsent;
}

export interface Segment {
  orgId: OrgId;
  segmentId: SegmentId;
  name: string;
  /** Opaque predicate; interpreted by @addressium/segment. */
  predicate: unknown;
}

// ---- messaging ----
export interface CampaignSeries {
  orgId: OrgId;
  seriesId: SeriesId;
  name: string;
  cadence: Cadence;
  /** Recurring series own their template + ad-tag fills; editions reuse them. */
  templateId: TemplateId;
  adSlotFills: AdSlotFill[];
  aggregate: HotCounters;
}

export interface Campaign {
  orgId: OrgId;
  campaignId: CampaignId;
  type: "one_off" | "series_edition";
  seriesId?: SeriesId;
  subject: string;
  previewText?: string;
  templateId: TemplateId;
  audience: { listId?: ListId; segmentId?: SegmentId };
  schedule?: { sendAt: string; timezone: string };
  status: "draft" | "scheduled" | "sending" | "sent" | "halted";
  counters: HotCounters;
}

export type ScheduleKind = "one_off" | "recurring";
export type ScheduleStatus = "active" | "paused" | "archived";

/**
 * Lifecycle record for a scheduled send (§4.6). It is the **source of truth** for
 * whether a send may fire: the launch handler (recurring series) and the campaign
 * sender (one-off) both gate on `status`. We **never delete** the underlying
 * EventBridge schedule — pausing or archiving just flips `status` here, so a
 * paused series can be resumed and history is retained. `scheduleId` is the
 * campaign-id stem the schedule was created under.
 */
export interface SendScheduleState {
  orgId: OrgId;
  scheduleId: string;
  kind: ScheduleKind;
  status: ScheduleStatus;
  /** Cron + zone for recurring series (informational; drives the admin view). */
  cron?: string;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * A one-off delivery that fired while this schedule was PAUSED (#179).
   *
   * Pausing a one-off used to destroy it. The EventBridge schedule fires,
   * `ActionAfterCompletion: DELETE` removes it, the message lands on SQS, the
   * sender sees `paused` and returns `{skipped: true}`, and SQS deletes the
   * message. Nothing remains: Resume-then-Start produced no send at all, and
   * nothing reported it.
   *
   * So the send is parked here instead of dropped, and resuming re-enqueues it.
   * The whole descriptor — template included — because that is what makes it
   * re-sendable without reconstructing it from a draft that may have changed
   * since. Shape owned by @addressium/domain (`SendDescriptor`).
   *
   * Cleared on resume and on archive. Archive is terminal: a parked send is
   * discarded, which is what "archive" has to mean if it means anything.
   */
  deferred?: unknown;
}

export interface HotCounters {
  sent: number;
  delivered: number;
  opens: number; // unique
  clicks: number; // unique
  bounces: number;
  complaints: number;
  unsubscribes: number;
  /**
   * Accepted by SES then refused (#241). Kept apart from `bounces` and
   * `delivered` on purpose: it is neither, and merging it into either one makes
   * the number it joins a lie. `sent - delivered - bounces - rejects` is how far
   * the send actually got.
   */
  rejects: number;
  /** Messages SES could not build — a merge tag that did not resolve (#241). */
  renderingFailures: number;
  /** Deliveries SES is still retrying (#241). Informational, never suppressing. */
  deliveryDelays: number;
}

export interface Template {
  orgId: OrgId;
  templateId: TemplateId;
  name: string;
  mode: TemplateMode;
  /** MJML for visual/mjml modes; raw HTML for raw_html mode. */
  source: string;
  version: number;
  mergeTags: string[]; // declared placeholder names
  adSlots: string[]; // declared ad-slot names (e.g. "ad_top")
}

export interface MergeTag {
  orgId: OrgId;
  name: string; // e.g. "first_name"
  source: MergeTagSource;
  scope: MergeTagScope;
  example?: string;
  fallback?: string;
}

export interface AdSlotFill {
  slot: string; // e.g. "ad_top"
  html: string; // LiveIntent HTML, inserted verbatim, never tracked
  /** Series-bound for recurring newsletters; campaign-bound for one-offs. */
  binding: { kind: "series"; seriesId: SeriesId } | { kind: "campaign"; campaignId: CampaignId };
  version: number;
}

export interface Feed {
  orgId: OrgId;
  feedId: string;
  url: string;
  format: "rss" | "atom" | "json";
  targetListId: ListId;
  /** feed field -> merge tag name */
  fieldMap: Record<string, string>;
  pullIntervalMins: number;
}

// ---- drip automations (§4.6) ----
export interface DripStep {
  stepId: string;
  /** Delay before this step fires, relative to the previous step (seconds). */
  waitSeconds: number;
  listId: ListId;
  templateId: TemplateId;
  subject: string;
  /** Optional gate: only send if the subscriber still has this entitlement. */
  requireEntitlement?: Entitlement;
}

export interface DripSequence {
  orgId: OrgId;
  sequenceId: string;
  name: string;
  /** What enrolls a subscriber: a signup on a list, or manual enrollment. */
  trigger: { kind: "signup"; listId: ListId } | { kind: "manual" };
  steps: DripStep[];
}

// ---- engagement, suppression, archive ----
export interface EngagementEvent {
  orgId: OrgId;
  subscriberId: SubscriberId;
  campaignId: CampaignId;
  type: EventType;
  linkId?: string; // for clicks; token already redacted
  at: string;
  /**
   * Stable identity for this occurrence, used to make writes idempotent and to
   * let the analytics lake dedupe (#183).
   *
   * Derived from the SOURCE event (SES message id + type + the provider's
   * timestamp), so two deliveries of the same SNS notification collapse while
   * two genuine opens stay distinct. Absent for internally-generated events,
   * which fall back to a random id — those are written once by construction.
   */
  eventId?: string;
}

export interface SuppressionEntry {
  orgId: OrgId;
  email: string;
  source: SuppressionSource;
  scope: SuppressionScope;
  addedAt: string;
}

export interface EmailArchive {
  orgId: OrgId;
  campaignId: CampaignId;
  s3Key: string; // generic rendered body
  linkMap: Record<string, { urlTemplate: string; position: number; label: string; class: LinkClass }>;
}

export interface EntitlementSync {
  orgId: OrgId;
  subscriberId: SubscriberId;
  source: string; // e.g. your billing provider
  value: Entitlement;
  version: string;
  at: string;
}

/**
 * Proof that a subject was erased, and the key the data lake anti-joins on
 * (#164).
 *
 * Erasure deletes the DynamoDB items that name the subject. It cannot delete
 * rows already written to S3 — the fact tier is GZIP-compressed, partitioned,
 * append-only objects, and rewriting them per request is neither cheap nor
 * atomic. So the tombstone is exported into the lake alongside the events and
 * every query filters against it: the row survives on disk until its lifecycle
 * rule expires it, and nothing can resolve it to the subject in the meantime.
 *
 * It holds NO personal data. `subscriberId` is a random UUID whose link to a
 * person was destroyed by the same erasure that wrote this record — which is
 * precisely what makes retaining it lawful, and what makes it useless to anyone
 * who obtains it.
 */
export interface ErasureRecord {
  orgId: OrgId;
  subscriberId: SubscriberId;
  erasedAt: string;
}

/**
 * Where a long-running org sweep got to (#233, #182).
 *
 * The re-engagement sweep enumerates every subscriber in an org and does an
 * N+1 subscription read per subscriber. With no checkpoint a retry restarted
 * from zero, so on an org large enough to matter it never completed — it just
 * burned the same first N subscribers on every attempt. The cursor is the
 * subscriber-page token, so a resumed run continues rather than repeating.
 */
export interface SweepCheckpoint {
  orgId: OrgId;
  /** Which sweep — one checkpoint per kind, so they never overwrite each other. */
  sweep: "reengagement";
  /** Opaque page cursor. Absent means "start from the beginning". */
  cursor?: string;
  /** When the current pass began — a pass that never finishes is visible as an old value. */
  startedAt: string;
  updatedAt: string;
  /** Subscribers examined in the CURRENT pass, across all its invocations. */
  scanned: number;
  /** Passes completed end to end. */
  completedPasses: number;
}

// ---- ops ----
export interface AlertConfig {
  orgId: OrgId;
  /**
   * Where breach notifications go. OPTIONAL: halting is the safety control and
   * notification is secondary, so an org with no topic still stops a campaign
   * that breaches — it just does so quietly (#217).
   */
  snsTopicArn?: string;
  rules: Array<{
    metric: "complaint_rate" | "bounce_rate" | "send_failures" | "reputation";
    warnAt: number;
    haltAt: number;
    enabled: boolean;
  }>;
  notifyTargets: string[];
}

/**
 * A saved import column mapping (#216).
 *
 * Keyed by a fingerprint of the file's header SET, order-insensitive — a
 * publisher re-exporting monthly gets shuffled columns and the same mapping
 * should still be offered. Without this, a 73-column Pinpoint export has to be
 * remapped by hand every single month, which is how an operator ends up
 * clicking through it and getting one column wrong.
 */
export interface ImportMapping {
  orgId: OrgId;
  /** Stable id; the operator names these. */
  mappingId: string;
  name: string;
  /** `headerFingerprint(headers)` — what makes a saved mapping re-offerable. */
  fingerprint: string;
  /** The plan itself; shape owned by @addressium/domain. */
  plan: unknown;
  updatedAt: string;
}

/**
 * One import run (#223). Makes a bad file findable after the fact: without a
 * batch record the only handle an operator has is "everything imported around
 * then", which is not a handle at all when the fix is to reverse a specific
 * upload.
 */
export interface ImportBatch {
  orgId: OrgId;
  batchId: string;
  sourceFile?: string;
  consentBasis?: "explicit" | "implicit";
  startedAt: string;
  created: number;
  updated: number;
  subscriptionsCreated: number;
  /** Members written by this batch, so its rows can be listed without a scan. */
  rowCount: number;
  /**
   * Where the run got to (#242).
   *
   * An async import outlives the request that started it, so the batch record IS
   * the status endpoint — there is nowhere else to ask. Absent on batches written
   * before async imports existed, which is why every reader treats undefined as
   * `completed` rather than as an unfinished run: those DID finish, inline,
   * before the response was sent.
   */
  status?: "running" | "completed" | "failed";
  /** When the run stopped, either way. */
  finishedAt?: string;
  /**
   * Why it failed. Load-bearing: a job that dies leaves a partially-imported
   * list, and "which rows landed" is the first question. `rowCount` answers how
   * many, this answers why it stopped.
   */
  error?: string;
  /** The S3 key the run read, for an async import. */
  sourceKey?: string;
}

/** Cost model inputs (USD) for per-org chargeback (§11). Operator-configurable. */
export interface CostRates {
  perEmail: number; // SES per-message
  perGbStorageMonth: number; // S3 archive
  perDedicatedIpMonth: number; // SES dedicated IP lease
  perTbScanned: number; // Athena data scanned (reporting read-model, §4.23)
}

/** Aggregated usage + estimated cost for one org over one billing period. */
export interface UsageRecord {
  orgId: OrgId;
  period: string; // "YYYY-MM"
  emailsSent: number;
  storageBytes: number;
  dedicatedIps: number;
  /** Athena bytes scanned this period (reporting read-model, §4.23). */
  athenaBytesScanned: number;
  cost: { email: number; storage: number; dedicatedIp: number; athena: number; total: number };
  computedAt: string;
}

export interface AuditEntry {
  orgId: OrgId | null; // null for cross-org actions (e.g. provisioning)
  memberSub: string;
  action: string;
  target?: string;
  at: string;
}
