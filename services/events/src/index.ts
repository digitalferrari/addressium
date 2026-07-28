/**
 * addressium service: events — SES engagement event processor.
 *
 * Resolves opens/clicks to the domain, which redacts the magic-link token and
 * aggregates by link-id (docs/ARCHITECTURE.md §4.5, docs/SECURITY.md §4.7).
 *
 * This handler is subscribed to an SNS topic fed by the per-org SES
 * configuration set. SNS delivers `{Records:[{Sns:{Message:"<json>"}}]}`, NOT
 * the SES notification itself, and the SES notification is nested/typed quite
 * differently from our internal shape — so the payload must be unwrapped and
 * normalized before anything can act on it (#184).
 */
import {
  DynamoStores,
  SnsAlertPublisher,
  unwrap,
  normalize,
  type Notification,
  type SesNotification,
} from "@addressium/adapters-aws";
import {
  SystemClock,
  checkDeliverability,
  recordBounce,
  recordClick,
  recordComplaint,
  recordOpen,
} from "@addressium/domain";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const clock = new SystemClock();
let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));
const alerts = new SnsAlertPublisher();

/** Process one resolved notification. */
async function apply(notif: Notification) {
  const s = stores();

  // SNS is at-least-once, so redeliveries must not double-count. Idempotency is
  // carried by the deterministic `eventId` (#183): the event row's sort key is
  // derived from it, so re-writing the same source event overwrites its own row.
  // This replaced a coarser claim-per-(messageId,type) scheme, which ALSO
  // discarded a subscriber's genuine second open — the eventId includes the
  // provider's per-occurrence timestamp, so real repeats survive.

  if (notif.eventType === "Click" && notif.link) {
    const linkId = await recordClick(s, clock, {
      orgId: notif.orgId,
      campaignId: notif.campaignId,
      subscriberId: notif.subscriberId,
      clickedUrl: notif.link, // token stripped inside recordClick
      eventId: notif.eventId,
    });
    return { ok: true, linkId };
  }
  if (notif.eventType === "Open") {
    await recordOpen(s, clock, notif.orgId, notif.campaignId, notif.subscriberId, notif.eventId);
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
    if (notif.eventType === "Bounce") {
      // The Permanent-only gate lives in recordBounce (#211), so every caller
      // gets it — this just forwards SES's classification.
      const r = await recordBounce(s, clock, { ...input, bounceType: notif.bounceType as never });
      if (!r.suppressed) {
        console.warn("events: transient bounce recorded, not suppressed", {
          orgId: notif.orgId,
          campaignId: notif.campaignId,
          bounceType: notif.bounceType,
        });
        return { ok: true, transient: true };
      }
    } else {
      await recordComplaint(s, clock, input);
    }
    // Evaluate the org's deliverability thresholds; publish to SNS + halt on breach (§4.18).
    const result = await checkDeliverability(s, alerts, clock, notif.orgId, notif.campaignId);
    return { ok: true, alert: result };
  }
  return { ok: true };
}

export async function handler(event: unknown) {
  const payloads = unwrap(event);
  let processed = 0;
  let unresolved = 0;
  const errors: string[] = [];

  for (const p of payloads) {
    const notif = normalize(p);
    if (!notif) {
      // Never silently drop: an unresolved event means bounces aren't reaching
      // suppression, which is exactly the failure this handler used to have.
      unresolved++;
      const t = (p as SesNotification)?.eventType ?? (p as SesNotification)?.notificationType;
      console.warn("events: unresolved notification", { eventType: t });
      continue;
    }
    try {
      await apply(notif);
      processed++;
    } catch (e) {
      errors.push(`${notif.eventType}/${notif.campaignId}: ${(e as Error).message}`);
    }
  }

  if (unresolved > 0) console.warn("events: unresolved count", { unresolved });
  // Surface failures so the delivery is retried and the error alarm fires,
  // instead of the old unconditional `{ok:true}` that hid everything.
  if (errors.length > 0) throw new Error(`events: ${errors.length} failed — ${errors.join("; ")}`);
  return { ok: true, processed, unresolved };
}
