/**
 * LLM-assisted campaign analytics (docs/ARCHITECTURE.md §4.8, #32).
 *
 * Assembles a campaign's AGGREGATE analytics into a compact, PII-free prompt and
 * asks the org's configured LLM (Anthropic / OpenAI / Gemini) for a performance
 * read + suggestions. Guardrail: only counts, rates, and editorial link labels
 * are sent — never subscriber emails or ids. `redactForLlm` is a defense-in-depth
 * scrub that strips anything email-shaped before the outbound call. The vendor
 * call is an injected AnalyticsAdvisor port so the assembly is unit-testable.
 */
import type { AiVendor } from "@addressium/core";
import type { Stores } from "./ports.js";
import { buildCampaignReport, type CampaignReport } from "./reporting.js";

export interface AnalysisResult {
  vendor: AiVendor;
  model: string;
  text: string;
}

/** The vendor call, injected so the prompt assembly stays pure/testable. */
export interface AnalyticsAdvisor {
  analyze(prompt: string): Promise<AnalysisResult>;
}

// Domain written as dot-separated labels (no `.` inside the class) so the class
// and the literal dot can't overlap — removes the polynomial-ReDoS ambiguity.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;

/** Strip anything email-shaped — belt-and-braces even though we only pass aggregates. */
export function redactForLlm(text: string): string {
  return text.replace(EMAIL_RE, "[redacted]");
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/** Build the PII-free analytics prompt from a campaign report. */
export function buildAnalysisPrompt(report: CampaignReport): string {
  const c = report.counters;
  const r = report.rates;
  const topLinks = report.clickMap.rows
    .slice(0, 10)
    .map((row, i) => `  ${i + 1}. "${row.label}" — ${row.clicks} clicks (${row.unique} unique)`)
    .join("\n");

  const body = [
    "You are an email deliverability + engagement analyst. Analyze this newsletter",
    "campaign's AGGREGATE performance and give concise, actionable suggestions.",
    "Do not ask for subscriber-level data; only aggregates are available.",
    "",
    `Campaign: ${report.campaignId}`,
    `Sent: ${c.sent}`,
    `Delivered: ${c.delivered}`,
    `Unique opens: ${c.opens} (${pct(r.openRate)})`,
    `Unique clicks: ${c.clicks} (${pct(r.clickRate)})`,
    `Bounces: ${c.bounces} (${pct(r.bounceRate)})`,
    `Complaints: ${c.complaints} (${pct(r.complaintRate)})`,
    `Unsubscribes: ${c.unsubscribes}`,
    "",
    "Top editorial links by clicks:",
    topLinks || "  (none tracked)",
    "",
    "Return: (1) a 2-3 sentence performance read, (2) 3-5 specific suggestions to",
    "improve open/click rates and protect deliverability.",
  ].join("\n");

  return redactForLlm(body);
}

/**
 * Build the report, assemble the prompt, and ask the advisor. The caller wires
 * the advisor from the org's aiConfig (vendor/model + key from Secrets Manager).
 */
export async function analyzeCampaign(
  stores: Stores,
  advisor: AnalyticsAdvisor,
  orgId: string,
  campaignId: string,
): Promise<{ report: CampaignReport; analysis: AnalysisResult; prompt: string }> {
  const report = await buildCampaignReport(stores, orgId, campaignId);
  const prompt = buildAnalysisPrompt(report);
  const analysis = await advisor.analyze(prompt);
  return { report, analysis, prompt };
}
