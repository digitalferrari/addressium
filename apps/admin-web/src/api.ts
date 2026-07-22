/**
 * Thin client for the addressium HTTP API. Attaches the Cognito access token as
 * a Bearer; the API Gateway JWT authorizer + server-side RBAC are the boundary.
 */
import { getTokens } from "./auth.js";

const BASE = import.meta.env.VITE_API_BASE ?? "";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const tokens = getTokens();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
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
  counters: { sent: number; delivered: number; opens: number; clicks: number; bounces: number; complaints: number; unsubscribes: number };
  rates: { openRate: number; clickRate: number; bounceRate: number; complaintRate: number };
  clickMap: { sent: number; rows: ClickMapRow[] };
  abResults?: { aScore: number; bScore: number; winner?: "A" | "B"; metric: string };
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
  aiConfig?: { vendor: string; model: string };
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

export interface SubscriberRow {
  sub: string;
  email: string;
  status: "active" | "suppressed";
  entitlement: string;
  lastEngagedAt?: string;
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

export const api = {
  orgMeta: (org: string) => call<OrgMeta>("GET", `/orgs/${org}`),
  campaigns: (org: string) => call<CampaignRow[]>("GET", `/orgs/${org}/campaigns`),
  dripSequences: (org: string) => call<DripSequence[]>("GET", `/orgs/${org}/drip-sequences`),
  saveDripSequence: (body: SaveDripSequenceBody) => call<DripSequence>("POST", `/drip-sequences`, body),
  segments: (org: string) => call<Segment[]>("GET", `/orgs/${org}/segments`),
  saveSegment: (orgId: string, segmentId: string, name: string, predicate: unknown) =>
    call<Segment>("POST", `/segments`, { orgId, segmentId, name, predicate }),
  subscribers: (org: string, q?: string) =>
    call<SubscriberRow[]>("GET", `/orgs/${org}/subscribers${q ? `?q=${encodeURIComponent(q)}` : ""}`),
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
  saveList: (input: unknown) => call<unknown>("POST", `/lists`, input),
  setVisibility: (orgId: string, listId: string, visibility: "open" | "closed") =>
    call<unknown>("POST", `/lists/visibility`, { orgId, listId, visibility }),
  report: (org: string, campaign: string) => call<CampaignReport>("GET", `/orgs/${org}/campaigns/${campaign}/report`),
  analyze: (orgId: string, campaignId: string) =>
    call<{ vendor: string; model: string; analysis: string }>("POST", `/reports/analyze`, { orgId, campaignId }),
  getBranding: (org: string) => call<Branding | null>("GET", `/orgs/${org}/branding`),
  setBranding: (orgId: string, branding: Branding) => call<Branding>("POST", `/orgs/branding`, { orgId, branding }),
  setPresentation: (orgId: string, listId: string, presentation: ListPresentation) =>
    call<unknown>("POST", `/lists/presentation`, { orgId, listId, presentation }),
  setAiConfig: (orgId: string, vendor: string, model: string, apiKey: string) =>
    call<unknown>("POST", `/orgs/ai-config`, { orgId, vendor, model, apiKey }),
  suppress: (orgId: string, email: string) => call<unknown>("POST", `/subscribers/suppress`, { orgId, email }),
};
