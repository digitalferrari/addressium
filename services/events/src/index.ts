/**
 * addressium service: events — SES engagement event processor.
 *
 * Resolves opens/clicks to the domain, which redacts the magic-link token and
 * aggregates by link-id (docs/ARCHITECTURE.md §4.5, docs/SECURITY.md §4.7).
 */
import { DynamoStores } from "@addressium/adapters-aws";
import { SystemClock, recordClick, recordOpen } from "@addressium/domain";

export interface Notification {
  eventType: "Open" | "Click" | "Bounce" | "Complaint";
  orgId: string;
  campaignId: string;
  subscriberId: string;
  /** Full clicked URL (token in fragment) for Click events. */
  link?: string;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const clock = new SystemClock();
let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));

export async function handler(notif: Notification) {
  const s = stores();
  if (notif.eventType === "Click" && notif.link) {
    const linkId = await recordClick(s, clock, {
      orgId: notif.orgId,
      campaignId: notif.campaignId,
      subscriberId: notif.subscriberId,
      clickedUrl: notif.link, // token stripped inside recordClick
    });
    return { ok: true, linkId };
  }
  if (notif.eventType === "Open") {
    await recordOpen(s, clock, notif.orgId, notif.campaignId, notif.subscriberId);
  }
  // TODO: Bounce/Complaint -> suppression + alerts (§4.5, §4.18).
  return { ok: true };
}
