/**
 * addressium service: events — SES engagement event processor.
 *
 * Resolves opens/clicks to the domain, which redacts the magic-link token and
 * aggregates by link-id (docs/ARCHITECTURE.md §4.5, docs/SECURITY.md §4.7).
 */
import { DynamoStores } from "@addressium/adapters-aws";
import {
  SystemClock,
  recordBounce,
  recordClick,
  recordComplaint,
  recordOpen,
} from "@addressium/domain";

export interface Notification {
  eventType: "Open" | "Click" | "Bounce" | "Complaint";
  orgId: string;
  campaignId: string;
  subscriberId: string;
  /** Full clicked URL (token in fragment) for Click events. */
  link?: string;
  /** Present for Bounce/Complaint. */
  email?: string;
  listId?: string;
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
    return { ok: true };
  }
  if ((notif.eventType === "Bounce" || notif.eventType === "Complaint") && notif.email) {
    const input = {
      orgId: notif.orgId,
      subscriberId: notif.subscriberId,
      email: notif.email,
      campaignId: notif.campaignId,
      listId: notif.listId,
    };
    if (notif.eventType === "Bounce") await recordBounce(s, clock, input);
    else await recordComplaint(s, clock, input);
    // TODO: publish a deliverability alert to SNS when rates cross thresholds (§4.18).
    return { ok: true };
  }
  return { ok: true };
}
