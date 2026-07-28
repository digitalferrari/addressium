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

  // SNS is at-least-once, and every branch below mutates counters or
  // suppression, so a redelivery would double-count opens/clicks and skew the
  // deliverability math that gates the halt. The claim store is a conditional
  // put — reuse it as a dedupe key when SES gave us a message id.
  if (notif.messageId) {
    const key = `sesevent:${notif.messageId}:${notif.eventType}`;
    if (!(await s.sendClaims.claim(notif.orgId, key))) {
      return { ok: true, deduped: true };
    }
  }

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
    // A Transient bounce (mailbox full, greylisting, throttled) must NOT
    // suppress — recordBounce always suppresses and flips the subscriber, so
    // treating every bounce alike permanently kills valid addresses over a
    // temporary condition.
    if (notif.eventType === "Bounce" && notif.bounceType && notif.bounceType !== "Permanent") {
      console.warn("events: transient bounce, not suppressing", {
        orgId: notif.orgId,
        campaignId: notif.campaignId,
        bounceType: notif.bounceType,
      });
      return { ok: true, transient: true };
    }
    const input = {
      orgId: notif.orgId,
      subscriberId: notif.subscriberId,
      email: notif.email,
      campaignId: notif.campaignId,
      listId: notif.listId,
    };
    if (notif.eventType === "Bounce") await recordBounce(s, clock, input);
    else await recordComplaint(s, clock, input);
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
