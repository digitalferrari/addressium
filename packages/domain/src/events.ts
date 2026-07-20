/**
 * Events processing + click map (docs/ARCHITECTURE.md §4.5, §4.8).
 *
 * The click handler is where token REDACTION happens: SES reports the full
 * destination URL of an editorial link (token in the fragment), and we must
 * strip the token before anything is persisted (docs/SECURITY.md §4.7).
 */
import type { EngagementEvent } from "@addressium/core";
import type { Clock, Stores } from "./ports.js";

export interface RecordClickInput {
  orgId: string;
  campaignId: string;
  subscriberId: string;
  /** Full clicked URL as reported by SES — may carry the token in the fragment. */
  clickedUrl: string;
}

/** Strip the token so it never lands at rest. Returns the bare URL (no fragment). */
export function redactToken(clickedUrl: string): string {
  const hash = clickedUrl.indexOf("#");
  return hash === -1 ? clickedUrl : clickedUrl.slice(0, hash);
}

export async function recordOpen(
  stores: Stores,
  clock: Clock,
  orgId: string,
  campaignId: string,
  subscriberId: string,
): Promise<void> {
  await stores.events.append({
    orgId,
    campaignId,
    subscriberId,
    type: "open",
    at: clock.now().toISOString(),
  });
}

/** Records a click, resolving the redacted URL to its stable link-id. */
export async function recordClick(
  stores: Stores,
  clock: Clock,
  input: RecordClickInput,
): Promise<string | undefined> {
  const bareUrl = redactToken(input.clickedUrl);
  const archive = await stores.archive.get(input.orgId, input.campaignId);
  let linkId: string | undefined;
  if (archive) {
    for (const [id, entry] of Object.entries(archive.linkMap)) {
      if (entry.urlTemplate === bareUrl) {
        linkId = id;
        break;
      }
    }
  }
  const evt: EngagementEvent = {
    orgId: input.orgId,
    subscriberId: input.subscriberId,
    campaignId: input.campaignId,
    type: "click",
    linkId, // token is NOT stored — only the resolved link-id
    at: clock.now().toISOString(),
  };
  await stores.events.append(evt);
  return linkId;
}

export interface ClickMapRow {
  linkId: string;
  label: string;
  urlTemplate: string;
  clicks: number;
  unique: number;
}
export interface ClickMap {
  sent: number;
  rows: ClickMapRow[];
}

export async function buildClickMap(
  stores: Stores,
  orgId: string,
  campaignId: string,
): Promise<ClickMap> {
  const archive = await stores.archive.get(orgId, campaignId);
  const events = await stores.events.all(orgId, campaignId);
  const sent = events.filter((e) => e.type === "sent").length;
  const rows: ClickMapRow[] = [];

  if (archive) {
    for (const [linkId, entry] of Object.entries(archive.linkMap)) {
      const clicks = events.filter((e) => e.type === "click" && e.linkId === linkId);
      const unique = new Set(clicks.map((e) => e.subscriberId)).size;
      rows.push({
        linkId,
        label: entry.label,
        urlTemplate: entry.urlTemplate,
        clicks: clicks.length,
        unique,
      });
    }
  }
  rows.sort((a, b) => b.clicks - a.clicks);
  return { sent, rows };
}
