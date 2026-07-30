/**
 * Thin client for the addressium HTTP API. Attaches the Cognito access token as
 * a Bearer; the API Gateway JWT authorizer + server-side RBAC are the boundary.
 */
import { clearTokens, getTokens, login } from "./auth.js";

const BASE = import.meta.env.VITE_API_BASE ?? "";

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
  counters: { sent: number; delivered: number; opens: number; clicks: number; bounces: number; complaints: number; unsubscribes: number, rejects: 0, renderingFailures: 0, deliveryDelays: 0 };
  rates: { openRate: number; clickRate: number; bounceRate: number; complaintRate: number };
  clickMap: { sent: number; rows: ClickMapRow[] };
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
  environment: "prod" | "dev";
  setupComplete: boolean;
  /** Configured AI analytics provider (vendor + model only; key never echoed) — #144. */
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
export interface ScheduleCampaignBody {
  orgId: string;
  campaignId: string;
  listId: string;
  /** Narrow the send to a segment's members (#203); the list still selects the base set. */
  segmentId?: string;
  subject: string;
  template: EmailTemplateBody;
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
  status: "active" | "paused" | "archived";
  cron?: string;
  timezone?: string;
  createdAt: string;
  updatedAt: string;
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

export interface SuppressionEntry {
  orgId: string;
  email: string;
  source: string;
  scope: "org" | "global";
  addedAt: string;
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

export type ColumnMapping =
  | { kind: "email" }
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

export const api = {
  createOrg: (input: CreateOrgInput) => call<CreateOrgResult>("POST", `/orgs`, input),
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
  orgMeta: (org: string) => call<OrgMeta>("GET", `/orgs/${org}`),
  campaigns: (org: string) => call<CampaignRow[]>("GET", `/orgs/${org}/campaigns`),
  dripSequences: (org: string) => call<DripSequence[]>("GET", `/orgs/${org}/drip-sequences`),
  saveDripSequence: (body: SaveDripSequenceBody) => call<DripSequence>("POST", `/drip-sequences`, body),
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
  scheduleCampaign: (body: ScheduleCampaignBody) => call<ScheduleResult>("POST", `/campaigns/schedule`, body),
  scheduleLifecycle: (orgId: string, scheduleId: string, action: "start" | "pause" | "archive") =>
    call<SendScheduleState>("POST", `/campaigns/lifecycle`, { orgId, scheduleId, action }),
  usage: (org: string) => call<UsageRecord[] | null>("GET", `/orgs/${org}/usage`),
  setup: (org: string) => call<SetupState>("GET", `/orgs/${org}/setup`),
  saveList: (input: CreateListInput) => call<AdminList>("POST", `/lists`, input),
  setVisibility: (orgId: string, listId: string, visibility: "open" | "closed") =>
    call<unknown>("POST", `/lists/visibility`, { orgId, listId, visibility }),
  report: (org: string, campaign: string) => call<CampaignReport>("GET", `/orgs/${org}/campaigns/${campaign}/report`),
  getBranding: (org: string) => call<Branding | null>("GET", `/orgs/${org}/branding`),
  setBranding: (orgId: string, branding: Branding) => call<Branding>("POST", `/orgs/branding`, { orgId, branding }),
  setPresentation: (orgId: string, listId: string, presentation: ListPresentation) =>
    call<unknown>("POST", `/lists/presentation`, { orgId, listId, presentation }),
  suppress: (orgId: string, email: string) => call<unknown>("POST", `/subscribers/suppress`, { orgId, email }),
};
