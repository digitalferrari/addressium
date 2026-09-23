/**
 * Thin client for the addressium HTTP API. Attaches the Cognito access token as
 * a Bearer; the API Gateway JWT authorizer + server-side RBAC are the boundary.
 */
import { clearTokens, getTokens, login } from "./auth.js";

const BASE = import.meta.env.VITE_API_BASE ?? "";

/**
 * The API origin this console is talking to, for screens that must SHOW a URL
 * rather than fetch it (the public JWKS endpoint an org's website consumes).
 *
 * Empty when the console is served same-origin as the API, which is why this
 * resolves against `window.location` instead of concatenating: an operator
 * copying "/orgs/x/.well-known/jwks.json" into their site's config would be
 * copying something that only resolves inside this tab.
 */
export function absoluteApiUrl(path: string): string {
  try {
    return new URL(`${BASE}${path}`, window.location.origin).toString();
  } catch {
    return `${BASE}${path}`;
  }
}

/**
 * Marks that this tab has already bounced through Cognito for one 401 (#197).
 *
 * Not every 401 means "expired". A disabled operator, a revoked client, or a
 * clock skew produces one too — and Cognito's SSO cookie would hand back a fresh
 * token instantly, so an unguarded redirect becomes an infinite loop between the
 * console and the Hosted UI with nothing on screen. One automatic re-auth per
 * tab; after that the operator lands on the sign-in card and can read the error.
 */
const REAUTH_KEY = "addressium.reauth";

export class UnauthorizedError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const tokens = getTokens();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      // The ID token, not the access token: Cognito access tokens never carry
      // `custom:*` attributes, so the server's RBAC claims (custom:role /
      // custom:orgs) were never arriving and every call 403'd (#161). The
      // authorizer validates `aud` against this client, and the server asserts
      // token_use === "id" so the two token types can't be confused.
      ...(tokens ? { authorization: `Bearer ${tokens.idToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // 401 is the authorizer rejecting the token; 403 is RBAC rejecting the CALLER,
  // which re-authenticating would not fix. Only the first routes to login.
  if (res.status === 401) {
    clearTokens();
    if (!sessionStorage.getItem(REAUTH_KEY)) {
      sessionStorage.setItem(REAUTH_KEY, "1");
      void login();
    }
    // Thrown, not swallowed: several screens `.catch(() => undefined)`, and an
    // expired session used to show them a blank panel with no prompt (#197).
    throw new UnauthorizedError(`${method} ${path} → 401: session expired`);
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  // A call got through, so the session is good and the next 401 deserves its own
  // redirect rather than being mistaken for a loop.
  sessionStorage.removeItem(REAUTH_KEY);
  return (await res.json()) as T;
}

export interface Branding {
  logoUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  background: { type: "solid"; color: string } | { type: "gradient"; from: string; to: string; angle: number };
}

export interface ListPresentation {
  showFrequency: boolean;
  showSendTime: boolean;
  showDescription: boolean;
  showReaderCount: boolean;
  showFreePaidCount: boolean;
  frequencyLabel?: string;
  sendTimeLabel?: string;
}

export interface ClickMapRow {
  linkId: string;
  label: string;
  urlTemplate: string;
  clicks: number;
  unique: number;
}
export interface CampaignReport {
  campaignId: string;
  /** Mirrors `HotCounters`. `rejects`/`renderingFailures`/`deliveryDelays` were
   * typed as the literal `0` (#253), which asserted the API never returns a
   * nonzero one — it does, and a rendering failure is our bug, not a
   * recipient's mailbox. */
  counters: { sent: number; delivered: number; opens: number; clicks: number; bounces: number; complaints: number; unsubscribes: number; rejects: number; renderingFailures: number; deliveryDelays: number };
  rates: { openRate: number; clickRate: number; bounceRate: number; complaintRate: number };
  clickMap: { sent: number; rows: ClickMapRow[] };
}
export interface SeriesReport {
  orgId: string;
  seriesId: string;
  editions: Array<{ campaignId: string; subject: string; status: string; counters: CampaignReport["counters"] }>;
  aggregate: CampaignReport["counters"];
  rates: CampaignReport["rates"];
}
export interface TrendPoint {
  date: string;
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  bounces: number;
  complaints: number;
  openRate: number;
  clickRate: number;
}
export interface AnalyticsTrends {
  orgId: string;
  from: string;
  through: string;
  days: number;
  points: TrendPoint[];
  summary?: {
    subscriberCount: number;
    current: { emailsSent: number; openRate: number; clickRate: number };
    previous: { emailsSent: number; openRate: number; clickRate: number };
  };
}

export interface UsageRecord {
  period: string;
  emailsSent: number;
  storageBytes: number;
  dedicatedIps: number;
  athenaBytesScanned: number;
  cost: { email: number; storage: number; dedicatedIp: number; athena: number; total: number };
  computedAt: string;
}

export interface SetupStep {
  id: string;
  label: string;
  done: boolean;
  required: boolean;
  hint: string;
}
export interface SetupState {
  steps: SetupStep[];
  requiredDone: number;
  requiredTotal: number;
  complete: boolean;
}

export interface OrgMeta {
  orgId: string;
  name: string;
  /** IANA zone scheduled sends resolve against; editable in Settings (#294). */
  defaultTimezone?: string;
  /**
   * Where THIS org's subscriber pages live, e.g. `https://news.example.com`
   * (#294). Orgs are siloed: the portal is a subdomain of the org's own domain,
   * not a shared addressium host. Required before the org can send.
   */
  siteUrl?: string;
  environment: "prod" | "dev";
  setupComplete: boolean;
  /**
   * The org's own sending domain — `Organization.domains[0]`, the one SES
   * verified at provisioning. Optional: an org provisioned without a domain
   * has none, and the shell shows the org id rather than inventing one.
   */
  primaryDomain?: string;
  /**
   * Every sending domain on the org record — `domains[0]` is `primaryDomain`.
   * Provisioning creates an SES identity and a configuration set per entry, so
   * this is the list Settings → Domains renders. Empty on an org provisioned
   * with none, which is exactly the setup checklist's failing `sending_domain`
   * step.
   */
  domains?: string[];
  /** True when this org mints magic-link tokens (it has a signing key). */
  magicLinkEnabled?: boolean;
  hourlyEnabled?: boolean;
  /** Segment resolver selected by deployment: GSI or the OpenSearch mirror. */
  segmentEngine?: "gsi" | "opensearch";
  /** Configured AI analytics provider (vendor + model only; key never echoed) — #144. */
}

export interface SearchResult {
  kind: "newsletters" | "campaigns" | "drips" | "templates" | "segments";
  id: string;
  label: string;
}

/**
 * Read-only identity configuration for one org (`GET /orgs/{org}/identity`).
 *
 * `magicLink.enabled === false` is the documented FEATURE-OFF state, not a
 * loading or half-provisioned one: the org has no linked subscriber pool, no
 * KMS signing key, no JWKS and no token, and editorial links render
 * untokenized. The screen must render that as a deliberate configuration, never
 * as blank fields.
 *
 * `jwksPath` is a PATH, not a URL — the JWKS endpoint is one shared API route
 * serving every org, so the console resolves it against the API base it already
 * calls rather than the payload naming a host.
 */
export type OrgIdentity = {
  orgId: string;
  /** Linked (never created) Cognito pool shared with the org's main site. */
  subscriberPoolId?: string;
  magicLink:
    | { enabled: false }
    | {
        enabled: true;
        kmsKeyArn: string;
        kid: string;
        issuer: string;
        audience: string;
        keyCount: number;
        rotatedAt?: string;
        jwksPath: string;
      };
};

/**
 * Live SES verification and sandbox state (`GET /orgs/{org}/sending-identity`,
 * #285) — the only identity readout in the console that asks SES rather than
 * our own table.
 *
 * Read the states, not a boolean. `unknown` means the check could not RUN — a
 * missing IAM grant, a throttle, SES unreachable — and it is deliberately not
 * the same as `pending` or `failed`. A screen that renders `unknown` as "not
 * verified" tells an operator to go edit DNS when the actual problem is an IAM
 * policy, which is the exact fabrication this route was built to avoid.
 *
 * `not_found` is SES having no identity for a domain the org record names:
 * provisioning half-ran, or the identity was deleted underneath us. Publishing
 * DNS records will not fix it.
 *
 * There is no DMARC field and there will not be one from here. SES reports DKIM
 * and the custom MAIL FROM (the SPF-alignment leg); `_dmarc` is a TXT record on
 * the operator's own zone that SES never reads back.
 */
export type DomainVerificationState = "verified" | "pending" | "failed" | "not_found" | "unknown";

export interface DomainIdentityStatus {
  domain: string;
  state: DomainVerificationState;
  /** Why the state is `unknown`. Present only then. */
  reason?: string;
  /** SES's own spelling: `SUCCESS` / `PENDING` / `FAILED` / `NOT_STARTED` / `TEMPORARY_FAILURE`. */
  dkimStatus?: string;
  /** The custom MAIL FROM subdomain (#200), when one is configured. */
  mailFromDomain?: string;
  /** Its status in SES's spelling — `PENDING` here means SPF is not aligned yet. */
  mailFromStatus?: string;
}

export interface AccountSendingStatus {
  /** False IS the SES sandbox: only verified addresses may be mailed. */
  productionAccess?: boolean;
  /** False means SES has paused sending for the account entirely. */
  sendingEnabled?: boolean;
  /** `HEALTHY` / `PROBATION` / `SHUTDOWN`. */
  enforcementStatus?: string;
  /** SES reports -1 for an unlimited quota. */
  max24HourSend?: number;
  maxSendRate?: number;
  sentLast24Hours?: number;
  /** Why none of the above could be read. Present only then; the rest are absent, never 0. */
  reason?: string;
}

export interface SendingIdentityReport {
  orgId: string;
  account: AccountSendingStatus;
  domains: DomainIdentityStatus[];
  /**
   * Whether SES would accept a message to an arbitrary recipient right now.
   * Tri-state on purpose: `undefined` means the checks did not complete, and
   * rendering that as "cannot send" would report an IAM gap as a deliverability
   * problem.
   */
  canSend?: boolean;
}

export type TemplateMode = "visual" | "mjml" | "raw_html";
export interface Template {
  orgId: string;
  templateId: string;
  name: string;
  mode: TemplateMode;
  source: string;
  version: number;
  mergeTags: string[];
  adSlots: string[];
}
export interface SaveTemplateBody {
  orgId: string;
  templateId: string;
  name: string;
  mode: TemplateMode;
  source: string;
  mergeTags?: string[];
  adSlots?: string[];
}
export interface Feed {
  orgId: string;
  feedId: string;
  url: string;
  format: "rss" | "atom" | "json";
  targetListId: string;
  fieldMap: Record<string, string>;
  pullIntervalMins: number;
  lastPulledAt?: string;
  lastItemCount?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
}
export interface SaveFeedBody {
  orgId: string;
  feedId: string;
  url: string;
  format: Feed["format"];
  targetListId: string;
  fieldMap: Record<string, string>;
  pullIntervalMins: number;
}
export type Cadence = "daily" | "weekly" | "biweekly" | "monthly";
export interface AdSlotFill {
  slot: string;
  html: string;
  binding: { kind: "series"; seriesId: string };
  version: number;
}
export interface CampaignSeries {
  orgId: string;
  seriesId: string;
  name: string;
  cadence: Cadence;
  templateId: string;
  adSlotFills: AdSlotFill[];
  aggregate: Record<string, number>;
}
export interface SaveSeriesBody {
  orgId: string;
  seriesId: string;
  name: string;
  cadence: Cadence;
  templateId: string;
  adSlotFills: Array<{ slot: string; html: string; version?: number }>;
}

export type MergeTagSource = "profile" | "feed" | "system" | "token_claim";
export type MergeTagScope = "per_recipient" | "per_campaign" | "token_claim";
/**
 * One row of the merge-tag registry. `reserved` is computed server-side — the
 * screen must not re-derive it from `source === "system"`, because an org may
 * legitimately register a `system`-sourced tag that the send path does not
 * supply, and guessing would mark it uneditable for no reason.
 */
export interface MergeTagEntry {
  orgId: string;
  name: string;
  source: MergeTagSource;
  scope: MergeTagScope;
  example?: string;
  fallback?: string;
  reserved: boolean;
}
export interface SaveMergeTagBody {
  orgId: string;
  name: string;
  source: MergeTagSource;
  scope: MergeTagScope;
  example?: string;
  fallback?: string;
}

// ---- API keys (#280) ----

/** Mirrors `ApiKeyScope` in `@addressium/core`. A closed set — the server refuses anything else. */
export type ApiKeyScope =
  | "subscribers:read"
  | "subscribers:write"
  | "entitlement:write"
  | "campaigns:read"
  | "suppression:write";

/**
 * One issued key as the API returns it. NOTE WHAT IS ABSENT: the plaintext key
 * and its SHA-256 digest. Neither ever crosses this boundary after issuance —
 * `displayPrefix` is the only part of the secret a screen can render, which is
 * why the Key column shows that and not a masked full value it does not have.
 *
 * `lastUsedAt` absent means the key has genuinely never been presented to
 * `POST /api-keys/verify`, the one route that records a use. It is not a
 * loading state and must never be rendered as a guess.
 */
export interface ApiKeyEntry {
  orgId: string;
  keyId: string;
  name: string;
  scopes: ApiKeyScope[];
  displayPrefix: string;
  createdAt: string;
  createdBy?: string;
  revokedAt?: string;
  lastUsedAt?: string;
  revoked: boolean;
}

/** The ONE response carrying a plaintext key. There is no way to fetch it again. */
export interface IssuedApiKey {
  key: ApiKeyEntry;
  plaintext: string;
}

export interface IssueApiKeyBody {
  orgId: string;
  keyId: string;
  name: string;
  scopes: ApiKeyScope[];
}

/** What POST /lists requires. Mirrors `createListSchema` — CAN-SPAM makes the
 * footer and physical address mandatory, not optional niceties (#6). */
export interface CreateListInput {
  orgId: string;
  listId: string;
  name: string;
  description?: string;
  optInPolicy: "single" | "double";
  fromAddress: string;
  replyTo?: string;
  access: "free" | "paid";
  visibility: "open" | "closed";
  complianceFooter: string;
  physicalAddress: string;
}

export interface AdminList {
  orgId: string;
  listId: string;
  name: string;
  visibility?: "open" | "closed";
  fromAddress?: string;
  /** Current subscriber-site presentation toggles (#33) — used to prefill the Presentation editor. */
  presentation?: ListPresentation;
}

export type EmailBlock =
  | { kind: "text"; html: string }
  | { kind: "editorial"; label: string; url: string }
  | { kind: "ad"; slot: string; html: string };

export type ScheduleWhen =
  | { type: "now" }
  | { type: "at"; at: string }
  | { type: "recurring"; cron: string; timezone?: string };

export type EmailTemplateBody = { blocks: EmailBlock[] } | { html: string } | { mjmlHtml: string };
export interface CampaignBody {
  orgId: string;
  campaignId: string;
  template: EmailTemplateBody;
  subject: string;
  previewText?: string;
  listId?: string;
  segmentId?: string;
  editorSource?: { mode: "blocks" | "html" | "mjml"; mjml?: string };
  rootCampaignId: string;
  version: number;
  savedAt: string;
}

export interface ScheduleCampaignBody {
  orgId: string;
  campaignId: string;
  listId: string;
  /** Narrow the send to a segment's members (#203); the list still selects the base set. */
  segmentId?: string;
  feedId?: string;
  subject: string;
  /** Inbox preview line (#302) — hidden at the top of the body, shown beside the subject. */
  previewText?: string;
  template: EmailTemplateBody;
  /**
   * What the operator was editing, kept so the campaign can be re-opened (#298).
   * Never sent: MJML is compiled here, so only the compiled html reaches
   * `template` and the source would otherwise be lost on a re-open.
   */
  editorSource?: { mode: "blocks" | "html" | "mjml"; mjml?: string };
  when: ScheduleWhen;
}

export interface ScheduleResult {
  status: string;
  at?: string;
  timezone?: string;
  scheduleId: string;
}

export interface SendScheduleState {
  orgId: string;
  scheduleId: string;
  kind: "one_off" | "recurring";
  /**
   * `"completed"` is terminal and one-off-only (#263): the sender records it
   * once the full recipient range has gone out. This mirror carried only the
   * three operator-driven states, so a fired one-off arrived as a status the
   * console had no case for and fell through to the ACTIVE-vs-not branches —
   * a green badge and a live Start button on a send that already happened.
   * `schedulesListHandler` returns the stored record verbatim, so the server
   * has been sending `"completed"` since the domain side shipped.
   */
  status: "active" | "paused" | "archived" | "completed";
  /**
   * Recipient key ranges the sender has finished. A single `{}` means the whole
   * send is covered — which is what `status: "completed"` is written FROM.
   *
   * Mirrored because `status` alone does not answer "has this already sent".
   * `completeScheduleRange` deliberately preserves `archived` over `completed`
   * (archiving is an operator decision the sender must not overwrite), so a
   * one-off archived mid-send lands on full ranges with `status: "archived"` —
   * and the domain refuses start/pause on THAT too. See `scheduleHasSent`.
   */
  completedRanges?: Array<{ after?: string; until?: string }>;
  cron?: string;
  timezone?: string;
  /**
   * When a ONE-OFF fires, ISO-8601 (#248). Absent on a recurring series, whose
   * `cron` above is the answer instead.
   *
   * This mirror was never updated when #248 added the field to
   * `SendScheduleState` in `packages/core/src/entities.ts`, so `Schedules.tsx`
   * — which has read `r.sendAt` since that issue shipped — did not typecheck.
   * `schedulesListHandler` returns the stored record verbatim, so the server
   * has always sent it.
   */
  sendAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Has this one-off already sent? (#263)
 *
 * Mirrors the rule `transitionSchedule` and `markScheduleActive` enforce in
 * `packages/domain/src/schedule-state.ts`, which is TWO conditions, not one:
 * `status === "completed"` OR a `completedRanges` entry covering the whole key
 * space. The second is not redundant — `completeScheduleRange` writes
 * `complete && status !== "archived" ? "completed" : status`, deliberately
 * letting an operator's archive stand, so a one-off archived mid-send finishes
 * with full ranges and `status: "archived"`. Gating on the status alone would
 * leave Start live on that row and the server would answer with the
 * `InvalidInputError` #263 is about: a control implying an action it cannot
 * perform.
 *
 * This only HIDES controls. Server-side RBAC and these same domain checks are
 * the boundary; the console mirrors them so it does not offer a refused action.
 */
export function scheduleHasSent(s: Pick<SendScheduleState, "status" | "completedRanges">): boolean {
  if (s.status === "completed") return true;
  return !!s.completedRanges?.some((r) => r.after === undefined && r.until === undefined);
}

export interface CampaignRow {
  campaignId: string;
  subject: string;
  status: string;
  type: string;
  listId?: string;
  segmentId?: string;
  sent: number;
  sendAt?: string;
}

export interface Segment {
  orgId: string;
  segmentId: string;
  name: string;
  predicate: unknown;
}

/** One member of an explicit-membership segment (#203). */
export interface SegmentMember {
  subscriberId: string;
  email: string;
  status: "active" | "suppressed";
  entitlement: "free" | "paid";
  /** True when the send path will skip this address regardless of membership. */
  suppressed: boolean;
}

/** An explicitly-enumerated test cohort, as opposed to a rule (#203). */
export interface ExplicitPredicate {
  match: "explicit";
  subscriberIds: string[];
}
export const EMPTY_EXPLICIT: ExplicitPredicate = { match: "explicit", subscriberIds: [] };

export function isExplicitPredicate(p: unknown): p is ExplicitPredicate {
  return !!p && typeof p === "object" && (p as ExplicitPredicate).match === "explicit";
}

/** One page of the Subscribers screen (#182). */
export interface SubscriberPage {
  rows: SubscriberRow[];
  /** Opaque; pass back to fetch the next page. Absent on the last page. */
  cursor?: string;
}

export interface SubscriberRow {
  sub: string;
  email: string;
  status: "active" | "suppressed";
  entitlement: string;
  lastEngagedAt?: string;
}

export type SubscriptionStatus = "pending" | "confirmed" | "unsubscribed" | "bounced" | "complained";

/** One list, with this subscriber's standing on it (#205). */
export interface SubscriberListState {
  listId: string;
  name: string;
  status?: SubscriptionStatus;
  updatedAt?: string;
  consent?: {
    requestedAt?: string;
    confirmedAt?: string;
    sourceUrl?: string;
    basis?: "explicit" | "implicit" | "manual_admin";
    actor?: string;
    importBatchId?: string;
  };
}

/** The full subscriber record behind one row of the Subscribers screen (#205). */
export interface SubscriberDetail {
  orgId: string;
  sub: string;
  email: string;
  status: "active" | "suppressed";
  entitlement: "free" | "paid";
  lastEngagedAt?: string;
  externalId?: string;
  attributes: Record<string, string>;
  lists: SubscriberListState[];
  segments: { segmentId: string; name: string }[];
  suppressed: boolean;
}
export interface SubscriberTimelineEvent {
  campaignId: string;
  subject: string;
  type: string;
  at: string;
  linkId?: string;
}
export interface SubscriberTimeline {
  events: SubscriberTimelineEvent[];
  hasMore: boolean;
}

export interface SuppressionEntry {
  orgId: string;
  email: string;
  source: string;
  scope: "org" | "global";
  addedAt: string;
}

/** Mirrors the domain's `SuppressionImportReport` (#251). */
export interface SuppressionImportReport {
  /** Entries the provider returned. */
  read: number;
  /** Entries written — or that would be, on a dry run. */
  written: number;
  bySource: Record<string, number>;
  /**
   * Entries whose reason we do not map — never written, so these addresses stay
   * mailable. Listed rather than counted: "3 skipped" reads as housekeeping,
   * and what it means is "3 addresses we will now mail".
   */
  unmapped: { email: string; reason: string }[];
  malformed: number;
  dryRun: boolean;
}

/** SES's live account-list entry for one address, or the check could not be made (#247). */
export interface LiveSuppression {
  email: string;
  reason: string;
  at?: string;
}

/**
 * Both sources of truth for one address (#247): our own store (what the send
 * path actually gates on) and a live SES lookup. `live: null` means SES was
 * asked and said clear; `live` absent/undefined means the check could not be
 * made — a different answer, never collapsed into the other.
 */
export interface SuppressionCheckResult {
  email: string;
  local: SuppressionEntry[];
  live?: LiveSuppression | null;
  liveError?: string;
}

export interface ImportReport {
  imported: number;
  skipped: number;
  suppressed: number;
  dryRun: boolean;
}

export interface DripStepDef {
  stepId: string;
  waitSeconds: number;
  listId: string;
  templateId: string;
  subject: string;
  requireEntitlement?: "free" | "paid";
}
export interface DripSequence {
  orgId: string;
  sequenceId: string;
  name: string;
  trigger: { kind: "signup"; listId: string } | { kind: "manual" };
  steps: DripStepDef[];
}
export type SaveDripSequenceBody = Omit<DripSequence, "orgId"> & { orgId: string };

/**
 * What `POST /drip-sequences/enroll` returns — the execution input the drip
 * state machine was started with (`DripEnrollment` in `@addressium/domain`,
 * mirrored here the way `DripSequence` is rather than imported).
 *
 * `nextWaitSeconds` is step 0's OWN wait: the machine starts at the Wait, so
 * this is how long it is before the first mail, not a delay before the sequence
 * begins. `enrollmentId` is the execution identity — the console shows it back
 * so an operator has the one handle that exists for a run.
 */
export interface DripEnrollment {
  orgId: string;
  sequenceId: string;
  subscriberId: string;
  nextStepIndex: number;
  nextWaitSeconds: number;
  enrollmentId: string;
}

export interface AlertRule {
  metric: "complaint_rate" | "bounce_rate" | "send_failures" | "reputation";
  warnAt: number;
  haltAt: number;
  enabled: boolean;
}
export interface AlertConfig {
  orgId: string;
  snsTopicArn?: string;
  rules: AlertRule[];
  notifyTargets: string[];
}

export interface ReengagementPolicy {
  enabled: boolean;
  coldAfterDays: number;
  steps: number;
  stepIntervalDays: number;
  suppressScope?: "org" | "global";
  listId?: string;
}

export type ColumnMapping =
  | { kind: "email" }
  | { kind: "externalId" }
  | { kind: "attribute"; key: string }
  | {
      kind: "audience";
      list: { existingId: string } | { createNamed: string };
      consentBasis: "explicit" | "implicit";
    }
  | { kind: "optOut"; optedOutValues: string[] }
  | { kind: "endpointStatus"; activeValues: string[] }
  | { kind: "channel"; emailValues: string[] }
  | { kind: "discard" };

export interface MappingPlan {
  columns: Record<string, ColumnMapping>;
}
export interface SavedMapping {
  mappingId: string;
  name: string;
  fingerprint: string;
  plan: MappingPlan;
  updatedAt: string;
}
export interface ImportPreview {
  headers: string[];
  sample: Record<string, string>[];
  rowCount: number;
  fingerprint: string;
  suggested: MappingPlan;
  /** Mappings already saved against this exact header set (#216). */
  saved: SavedMapping[];
  problems: { column?: string; problem: string }[];
}
export interface MappedImportReport {
  created: number;
  updated: number;
  nonMailable: number;
  duplicates: number;
  suppressed: number;
  subscriptionsCreated: number;
  declinesRecorded: number;
  listsCreated: string[];
  discardedCells: number;
  errors: string[];
  /** Stamped by the server even when the caller supplied none (#223). */
  batchId?: string;
}

/** One recorded import run (#223). */
export interface ImportBatch {
  orgId: string;
  batchId: string;
  sourceFile?: string;
  consentBasis?: "explicit" | "implicit";
  startedAt: string;
  created: number;
  updated: number;
  subscriptionsCreated: number;
  rowCount: number;
  status?: "running" | "completed" | "failed";
  finishedAt?: string;
  error?: string;
}
export interface ImportBatchDetail {
  batch: ImportBatch;
  rows: { subscriberId: string; listId: string }[];
}
/**
 * A presigned download (#224). `url` is a bearer credential for the whole
 * export — anyone holding it can fetch the file until `expiresAt`.
 */
export interface ExportLink {
  format: "csv" | "jsonl";
  bytes: number;
  url: string;
  expiresAt: string;
}
/** One recorded privileged action (#191). */
export interface AuditRow {
  orgId: string | null;
  memberSub: string;
  action: string;
  target?: string;
  at: string;
}
export interface NewListDefaults {
  fromAddress: string;
  complianceFooter: string;
  physicalAddress: string;
}

export interface ImportUploadTicket {
  batchId: string;
  key: string;
  url: string;
}

export interface TeamMemberRow {
  username: string;
  email: string;
  role: "developer_admin" | "editor" | "analyst" | "support";
  orgs: string[];
  enabled: boolean;
  status?: string;
  capabilities: string[];
}

export interface HealthReport {
  status: "ok" | "degraded" | "unknown";
  alarmsInAlarm: number;
  reason?: string;
  checkedAt: string;
}

export interface CreateOrgInput {
  name: string;
  primaryDomain: string;
  siteDomain: string;
  defaultTimezone?: string;
  magicLinks: boolean;
  subscriberPool?: { poolId: string };
  environment: "prod" | "dev";
  devAllowlist?: string[];
  alertTopicArn?: string;
}
export interface CreateOrgResult {
  orgId: string;
  setupComplete: boolean;
  alreadyExisted: boolean;
  /** `note` explains what breaks without the record — MAIL FROM and DMARC
   * both fail quietly, so the row has to say so (#200). */
  dns: { type: string; name: string; value: string; note?: string }[];
}

/** One row in the org switcher. Deliberately small — see orgsListHandler. */
export interface OrgSummary {
  orgId: string;
  name: string;
  environment: string;
  setupComplete: boolean;
}

export const api = {
  createOrg: (input: CreateOrgInput) => call<CreateOrgResult>("POST", `/orgs`, input),
  listOrgs: () => call<{ orgs: OrgSummary[] }>("GET", `/orgs`),
  health: (org: string) => call<HealthReport>("GET", `/orgs/${org}/health`),
  team: (org: string) => call<TeamMemberRow[]>("GET", `/orgs/${org}/team`),
  inviteMember: (orgId: string, email: string, role: string, orgs: string[]) =>
    call<TeamMemberRow>("POST", `/team`, { orgId, action: "invite", email, role, orgs }),
  setMemberAccess: (orgId: string, username: string, role: string, orgs: string[]) =>
    call<TeamMemberRow>("POST", `/team`, { orgId, action: "access", username, role, orgs }),
  setMemberEnabled: (orgId: string, username: string, enabled: boolean) =>
    call<{ ok: boolean }>("POST", `/team`, { orgId, action: enabled ? "enable" : "disable", username }),
  /**
   * Bulk export (#224). The route streams the file to S3 and returns a
   * short-lived presigned URL, so the response is a pointer rather than the
   * export — an API Gateway response is capped at 6MB, which the org most likely
   * to be leaving would blow straight through.
   *
   * The call itself is still authorized (hence fetch, not a link); the URL it
   * returns is pre-authorized and needs no header.
   */
  exportData: (orgId: string, format: "csv" | "jsonl", includeUnsubscribed: boolean) =>
    call<ExportLink>(
      "GET",
      `/orgs/${orgId}/export?format=${format}${includeUnsubscribed ? "&includeUnsubscribed=true" : ""}`,
    ),
  saveMapping: (orgId: string, name: string, fingerprint: string, plan: MappingPlan) =>
    call<SavedMapping>("POST", `/orgs/${orgId}/import/mappings`, { name, fingerprint, plan }),
  importPreview: (orgId: string, csv: string, consentBasis?: "explicit" | "implicit") =>
    call<ImportPreview>("POST", `/orgs/${orgId}/import/preview`, { csv, consentBasis }),
  importMapped: (orgId: string, body: {
    csv: string;
    plan: MappingPlan;
    status?: "confirmed" | "pending";
    sourceFile?: string;
    newListDefaults?: NewListDefaults;
    dryRun?: boolean;
  }) => call<MappedImportReport>("POST", `/orgs/${orgId}/import/mapped`, body),
  importUploadUrl: (orgId: string) =>
    call<ImportUploadTicket>("POST", `/orgs/${orgId}/import/upload-url`, {}),
  importUploadPreview: (orgId: string, batchId: string, consentBasis?: "explicit" | "implicit") =>
    call<ImportPreview>("POST", `/orgs/${orgId}/import/upload-preview`, { batchId, consentBasis }),
  importAsync: (orgId: string, body: {
    batchId: string;
    plan: MappingPlan;
    status?: "confirmed" | "pending";
    sourceFile?: string;
    newListDefaults?: NewListDefaults;
  }) => call<{ batchId: string; status: "running" }>("POST", `/orgs/${orgId}/import/async`, body),
  uploadImportFile: async (orgId: string, file: File): Promise<ImportUploadTicket> => {
    const ticket = await call<ImportUploadTicket>("POST", `/orgs/${orgId}/import/upload-url`, {});
    const response = await fetch(ticket.url, {
      method: "PUT",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!response.ok) throw new Error(`PUT import file → ${response.status}`);
    return ticket;
  },
  /**
   * The WORM audit log (#191). `"GLOBAL"` reads the cross-org scope — org
   * creation and pool linking, which belong to no single org.
   */
  auditLog: (orgId: string, limit = 100) =>
    call<AuditRow[]>("GET", `/orgs/${orgId}/audit?limit=${limit}`),
  importBatches: (orgId: string) =>
    call<ImportBatch[]>("GET", `/orgs/${orgId}/import/batches`),
  importBatch: (orgId: string, batchId: string) =>
    call<ImportBatchDetail>("GET", `/orgs/${orgId}/import/batches?batchId=${encodeURIComponent(batchId)}`),
  /** null means this org has NO thresholds — render "unprotected", not zeros. */
  alertConfig: (org: string) => call<AlertConfig | null>("GET", `/orgs/${org}/alerts`),
  saveAlertConfig: (body: AlertConfig) => call<AlertConfig>("POST", `/orgs/alerts`, body),
  customerSync: (org: string) => call<{ configured: boolean; endpoint?: string; tableName?: string; enabled?: boolean }>("GET", `/orgs/${org}/customer-sync`),
  saveCustomerSync: (body: { orgId: string; endpoint: string; tableName: string; secret: string; enabled: boolean }) =>
    call<{ configured: boolean; endpoint: string; tableName: string; enabled: boolean }>("POST", `/orgs/customer-sync`, body),
  reengagement: (org: string) => call<{ configured: boolean; policy: ReengagementPolicy }>("GET", `/orgs/${org}/reengagement`),
  saveReengagement: (body: ReengagementPolicy & { orgId: string }) =>
    call<{ configured: boolean; policy: ReengagementPolicy }>("POST", `/orgs/reengagement`, body),
  orgMeta: (org: string) => call<OrgMeta>("GET", `/orgs/${org}`),
  search: (org: string, q: string) => call<{ results: SearchResult[] }>("GET", `/orgs/${org}/search?q=${encodeURIComponent(q)}`),
  orgIdentity: (org: string) => call<OrgIdentity>("GET", `/orgs/${org}/identity`),
  rotateMagicLinkKey: (org: string) =>
    call<{ orgId: string; kid: string; keyCount: number; rotatedAt: string }>("POST", `/orgs/${org}/identity/rotate-key`, { action: "rotateMagicLinkKey" }),
  /**
   * Live SES verification + sandbox state (#285). Every call is a fresh read of
   * SES, and deliberately so: this is the one readout whose whole value is that
   * it changes — a domain verifies, an account leaves the sandbox — so nothing
   * here memoizes it.
   */
  sendingIdentity: (org: string) =>
    call<SendingIdentityReport>("GET", `/orgs/${org}/sending-identity`),
  campaigns: (org: string) => call<CampaignRow[]>("GET", `/orgs/${org}/campaigns`),
  dripSequences: (org: string) => call<DripSequence[]>("GET", `/orgs/${org}/drip-sequences`),
  saveDripSequence: (body: SaveDripSequenceBody) => call<DripSequence>("POST", `/drip-sequences`, body),
  /**
   * Hand-enroll ONE subscriber into a manual sequence (#255/#283) — real sends.
   *
   * No `enrollmentId` is sent: absent it the server stamps the instant, so two
   * deliberate clicks are two enrollments. Deriving a stable key here would
   * silently swallow a re-enrolment an operator actually meant.
   */
  enrollInDrip: (orgId: string, sequenceId: string, subscriberId: string) =>
    call<DripEnrollment>("POST", `/drip-sequences/enroll`, { orgId, sequenceId, subscriberId }),
  segments: (org: string) => call<Segment[]>("GET", `/orgs/${org}/segments`),
  saveSegment: (orgId: string, segmentId: string, name: string, predicate: unknown) =>
    call<Segment>("POST", `/segments`, { orgId, segmentId, name, predicate }),
  /**
   * The cohort of an explicit-membership segment (#203). Gated on
   * `segments:manage` rather than `reports:view`, because the response is a list
   * of subscriber addresses — a subscriber read wearing a segment's name.
   */
  segmentMembers: (orgId: string, segmentId: string) =>
    call<SegmentMember[]>("GET", `/orgs/${orgId}/segments/${encodeURIComponent(segmentId)}/members`),
  /** Add or remove one address; returns the cohort as it stands afterwards. */
  segmentMember: (orgId: string, segmentId: string, action: "add" | "remove", email: string) =>
    call<SegmentMember[]>("POST", `/segments/members`, { orgId, segmentId, action, email }),
  /**
   * One PAGE of subscribers (#182). `q` is an email PREFIX, served as a key
   * condition by the email index — a substring match cannot use any index, and
   * the previous endpoint answered one by loading the whole org into memory.
   */
  subscribers: (org: string, q?: string, cursor?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (cursor) params.set("cursor", cursor);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return call<SubscriberPage>("GET", `/orgs/${org}/subscribers${qs ? `?${qs}` : ""}`);
  },
  /** The full subscriber record: attributes, per-list status, segments (#205). */
  subscriber: (org: string, sub: string) =>
    call<SubscriberDetail>("GET", `/orgs/${org}/subscribers/${encodeURIComponent(sub)}`),
  subscriberTimeline: (org: string, sub: string) =>
    call<SubscriberTimeline>("GET", `/orgs/${org}/subscribers/${encodeURIComponent(sub)}/timeline`),
  setSubscriberAttributes: (orgId: string, sub: string, attributes: Record<string, string>) =>
    call<SubscriberDetail>("POST", `/subscribers/attributes`, { orgId, sub, attributes }),
  /**
   * Set one list's opt-in status (#205). `acknowledgeManualConfirmation` is
   * required for `confirmed` — it asserts a double opt-in that never happened,
   * and the server refuses without it rather than trusting the client to ask.
   */
  setSubscriptionStatus: (
    orgId: string,
    sub: string,
    listId: string,
    status: "pending" | "confirmed" | "unsubscribed",
    acknowledgeManualConfirmation?: boolean,
  ) =>
    call<SubscriberDetail>("POST", `/subscribers/subscription`, {
      orgId, sub, listId, status,
      ...(acknowledgeManualConfirmation ? { acknowledgeManualConfirmation: true } : {}),
    }),
  suppressions: (org: string) => call<SuppressionEntry[]>("GET", `/orgs/${org}/suppressions`),
  /**
   * Import the SES ACCOUNT suppression list (#251). The half of a migration
   * nothing else can reconstruct: a subscriber export can be taken again, but
   * "this address hard-bounced two years ago" lives only on the account list.
   * Reads the deployment's own SES account — there is nothing to name.
   */
  importSuppression: (orgId: string, dryRun: boolean) =>
    call<SuppressionImportReport>("POST", `/orgs/${orgId}/import/suppression`, { dryRun }),
  /** Both local and live (SES) status for one address (#247) — used by the subscriber-detail view. */
  suppressionCheck: (org: string, email: string) =>
    call<SuppressionCheckResult>("GET", `/orgs/${org}/suppression/check?email=${encodeURIComponent(email)}`),
  unsuppress: (orgId: string, email: string) => call<unknown>("POST", `/subscribers/unsuppress`, { orgId, email }),
  adminUnsubscribe: (orgId: string, subscriberId: string, email?: string, listId?: string) =>
    call<unknown>("POST", `/subscribers/unsubscribe`, { orgId, subscriberId, email, listId }),
  importCsv: (orgId: string, listId: string, csv: string, dryRun: boolean, status?: "confirmed" | "pending") =>
    call<ImportReport>("POST", `/orgs/${orgId}/import`, { listId, csv, dryRun, status }),
  privacy: (orgId: string, action: "export" | "erase", email: string) =>
    call<{ found?: boolean; data?: unknown; erased?: boolean }>("POST", `/privacy`, { orgId, action, email }),
  lists: (org: string) => call<AdminList[]>("GET", `/orgs/${org}/lists`),
  schedules: (org: string) => call<SendScheduleState[]>("GET", `/orgs/${org}/schedules`),
  templates: (org: string) => call<Template[]>("GET", `/orgs/${org}/templates`),
  saveTemplate: (body: SaveTemplateBody) => call<Template>("POST", `/templates`, body),
  feeds: (org: string) => call<Feed[]>("GET", `/orgs/${org}/feeds`),
  saveFeed: (body: SaveFeedBody) => call<Feed>("POST", `/feeds`, body),
  series: (org: string) => call<CampaignSeries[]>("GET", `/orgs/${org}/series`),
  saveSeries: (body: SaveSeriesBody) => call<CampaignSeries>("POST", `/series`, body),
  mergeTags: (org: string) => call<MergeTagEntry[]>("GET", `/orgs/${org}/merge-tags`),
  saveMergeTag: (body: SaveMergeTagBody) => call<MergeTagEntry>("POST", `/merge-tags`, body),
  deleteMergeTag: (orgId: string, name: string) =>
    call<{ deleted: string }>("POST", `/merge-tags/delete`, { orgId, name }),
  apiKeys: (org: string) => call<ApiKeyEntry[]>("GET", `/orgs/${org}/api-keys`),
  /** The plaintext in the response is shown once and is not retrievable again. */
  issueApiKey: (body: IssueApiKeyBody) => call<IssuedApiKey>("POST", `/api-keys`, body),
  revokeApiKey: (orgId: string, keyId: string) =>
    call<ApiKeyEntry>("POST", `/api-keys/revoke`, { orgId, keyId }),
  /** Admin-gated. Succeeds only for a live key of this org, and RECORDS the use. */
  verifyApiKey: (orgId: string, key: string) =>
    call<ApiKeyEntry>("POST", `/api-keys/verify`, { orgId, key }),
  scheduleCampaign: (body: ScheduleCampaignBody) => call<ScheduleResult>("POST", `/campaigns/schedule`, body),
  scheduleLifecycle: (orgId: string, scheduleId: string, action: "start" | "pause" | "archive") =>
    call<SendScheduleState>("POST", `/campaigns/lifecycle`, { orgId, scheduleId, action }),
  /** Fire a recurring series off-cycle with current content (#305). */
  sendSeriesNow: (orgId: string, seriesId: string) =>
    call<{ status: string; seriesId: string; campaignId: string }>("POST", `/campaigns/send-now`, {
      orgId,
      seriesId,
    }),
  usage: (org: string) => call<UsageRecord[] | null>("GET", `/orgs/${org}/usage`),
  setup: (org: string) => call<SetupState>("GET", `/orgs/${org}/setup`),
  saveList: (input: CreateListInput) => call<AdminList>("POST", `/lists`, input),
  setVisibility: (orgId: string, listId: string, visibility: "open" | "closed") =>
    call<unknown>("POST", `/lists/visibility`, { orgId, listId, visibility }),
  report: (org: string, campaign: string) => call<CampaignReport>("GET", `/orgs/${org}/campaigns/${campaign}/report`),
  /**
   * The structured body, for re-opening a campaign in Compose (#307).
   *
   * Not the archive route: that returns RENDERED html of a sent campaign, with
   * merge values resolved and block kinds flattened. This is what the operator
   * composed, and the only thing that can be loaded back into an editor.
   */
  campaignContent: (org: string, campaign: string) =>
    call<CampaignBody>("GET", `/orgs/${org}/campaigns/${campaign}/content`),
  analyticsTrends: (org: string, days = 30) => call<AnalyticsTrends>("GET", `/orgs/${org}/analytics/trends?days=${days}`),
  archive: (org: string, campaign: string) => call<{ html: string }>("GET", `/orgs/${org}/campaigns/${campaign}/archive`),
  seriesReport: (org: string, series: string) => call<SeriesReport>("GET", `/orgs/${org}/series/${series}/report`),
  getBranding: (org: string) => call<Branding | null>("GET", `/orgs/${org}/branding`),
  setBranding: (orgId: string, branding: Branding) => call<Branding>("POST", `/orgs/branding`, { orgId, branding }),
  saveSettings: (orgId: string, settings: { hourlyEnabled: boolean }) =>
    call<{ hourlyEnabled: boolean }>("POST", `/orgs/settings`, { orgId, ...settings }),
  /**
   * Correct the org's name, timezone or sending domain (#294).
   *
   * A domain change ADDS an identity and promotes it; nothing is ever removed,
   * so the response may carry DNS records to publish and a warning about lists
   * still sending from the previous domain.
   */
  updateOrganization: (
    orgId: string,
    update: { name?: string; defaultTimezone?: string; addDomain?: string; siteUrl?: string },
  ) =>
    call<{
      orgId: string;
      changed: Array<{ field: string; from: string; to: string }>;
      dns: Array<{ type: string; name: string; value: string; note?: string }>;
      warning?: string;
      listsOnPreviousDomain?: string[];
      /** DNS/cert steps for a newly-set subscriber site URL (#294). */
      setupSteps?: string[];
    }>("POST", `/orgs/${encodeURIComponent(orgId)}/settings/organization`, {
      action: "updateOrganization",
      ...update,
    }),
  setPresentation: (orgId: string, listId: string, presentation: ListPresentation) =>
    call<unknown>("POST", `/lists/presentation`, { orgId, listId, presentation }),
  /** `source` picks the reason and, transitively, the scope (§4.13): omitted stays manual/org-scoped
   *  exactly as before #247; "bounce"/"complaint" lands global and mirrors to the live SES list. */
  suppress: (orgId: string, email: string, source?: "bounce" | "complaint") =>
    call<unknown>("POST", `/subscribers/suppress`, { orgId, email, ...(source ? { source } : {}) }),
};
