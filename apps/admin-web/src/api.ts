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

export const api = {
  lists: (org: string) => call<unknown[]>("GET", `/orgs/${org}/lists`),
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
