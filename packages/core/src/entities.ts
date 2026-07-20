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
export type SuppressionSource = "bounce" | "complaint" | "manual" | "unsubscribe";
export type SuppressionScope = "global" | "org";
export type DeploymentSuppressionScope = "global" | "org" | "hybrid";
export type MergeTagSource = "profile" | "feed" | "system" | "token_claim";
export type MergeTagScope = "per_recipient" | "per_campaign" | "token_claim";
export type IpMode = "shared" | "dedicated";
export type LinkClass = "editorial" | "advertising";
export type EventType =
  | "sent"
  | "delivered"
  | "open"
  | "click"
  | "bounce"
  | "complaint"
  | "unsubscribe";

export interface Consent {
  timestamp: string; // ISO-8601
  ip: string;
  sourceUrl: string;
}

// ---- tenancy & identity ----
export interface Organization {
  orgId: OrgId;
  name: string;
  domains: string[];
  /** Cognito user pool, shared with this org's main website. */
  subscriberPoolId: string;
  /** Per-org magic-link signing config (resolved by the sender at send time). */
  magicLink: {
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
  ipMode: IpMode;
  suppressionScope: DeploymentSuppressionScope;
  /**
   * IANA time zone (e.g. "America/Denver"). Storage stays UTC; this is the zone
   * used to interpret RECURRING wall-clock send schedules (DST-aware) and to
   * bucket/display reporting. A recurring campaign may override it.
   */
  defaultTimezone: string;
  /**
   * Optional AI provider for LLM-assisted analytics (§4.8, #32). The API key is
   * held in Secrets Manager; only the ARN + vendor/model live here.
   */
  aiConfig?: AiConfig;
  /** Subscriber-site branding/theme (§4.10, #31). */
  branding?: Branding;
  /** Public-signup bot protection + optional post-verify account provisioning (#62). */
  signupProtection?: SignupProtection;
  setupComplete: boolean;
}

export interface SignupProtection {
  /** reCAPTCHA secret ARN for server-side verification. The site key lives in the embed snippet. */
  recaptchaSecretArn?: string;
  /**
   * When true, provision a subscriber Cognito account in the org's pool AFTER the
   * subscriber clicks their double opt-in link. Off by default — addressium
   * normally never writes to your user pool; this is an explicit opt-in.
   */
  createAccountsOnConfirm?: boolean;
}

export type AiVendor = "anthropic" | "openai" | "gemini";
export interface AiConfig {
  vendor: AiVendor;
  model: string;
  apiKeySecretArn: string;
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

export interface AbTest {
  variantA: string; // subject A
  variantB: string; // subject B
  splitPct: number; // holdout size for the test
  winnerMetric: "open" | "click";
  decisionWindowMins: number;
  winner?: "A" | "B";
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
  abTest?: AbTest;
  status: "draft" | "scheduled" | "sending" | "sent" | "halted";
  counters: HotCounters;
}

export interface HotCounters {
  sent: number;
  delivered: number;
  opens: number; // unique
  clicks: number; // unique
  bounces: number;
  complaints: number;
  unsubscribes: number;
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

// ---- ops ----
export interface AlertConfig {
  orgId: OrgId;
  snsTopicArn: string;
  rules: Array<{
    metric: "complaint_rate" | "bounce_rate" | "send_failures" | "reputation";
    warnAt: number;
    haltAt: number;
    enabled: boolean;
  }>;
  notifyTargets: string[];
}

/** Cost model inputs (USD) for per-org chargeback (§11). Operator-configurable. */
export interface CostRates {
  perEmail: number; // SES per-message
  perGbStorageMonth: number; // S3 archive
  perDedicatedIpMonth: number; // SES dedicated IP lease
}

/** Aggregated usage + estimated cost for one org over one billing period. */
export interface UsageRecord {
  orgId: OrgId;
  period: string; // "YYYY-MM"
  emailsSent: number;
  storageBytes: number;
  dedicatedIps: number;
  cost: { email: number; storage: number; dedicatedIp: number; total: number };
  computedAt: string;
}

export interface AuditEntry {
  orgId: OrgId | null; // null for cross-org actions (e.g. provisioning)
  memberSub: string;
  action: string;
  target?: string;
  at: string;
}
