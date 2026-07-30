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
  unwrapRecords,
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
  recordDelivered,
  recordSendOutcome,
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
  if (notif.eventType === "Delivery") {
    await recordDelivered(s, clock, notif.orgId, notif.campaignId, notif.subscriberId, notif.eventId);
    return { ok: true };
  }
  // The three SES outcomes that used to fall through to `return { ok: true }`
  // (#241). None of them may suppress: a reject is our content, not the
  // recipient's mailbox, and a delay is transient by definition (the same
  // reasoning as the Permanent-only bounce gate, #211).
  if (
    notif.eventType === "Reject" ||
    notif.eventType === "RenderingFailure" ||
    notif.eventType === "DeliveryDelay"
  ) {
    const type =
      notif.eventType === "Reject"
        ? "reject"
        : notif.eventType === "RenderingFailure"
          ? "rendering_failure"
          : "delivery_delay";
    await recordSendOutcome(s, clock, {
      orgId: notif.orgId,
      campaignId: notif.campaignId,
      subscriberId: notif.subscriberId,
      type,
      eventId: notif.eventId,
    });
    if (notif.eventType === "RenderingFailure") {
      // Loud, and at error level, because this one is OUR defect: a merge tag
      // that failed to resolve for this recipient will fail for the rest of the
      // campaign. A counter in a dashboard is not a signal anybody sees during a
      // send, so this line is what the ConfirmRenderingFailure alarm watches —
      // the literal is shared with the CDK MetricFilter and asserted on both
      // sides.
      console.error("events: rendering failure", {
        orgId: notif.orgId,
        campaignId: notif.campaignId,
        templateName: notif.templateName,
        reason: notif.reason,
      });
    } else {
      console.warn(`events: ${type} recorded`, {
        orgId: notif.orgId,
        campaignId: notif.campaignId,
        ...(notif.reason ? { reason: notif.reason } : {}),
        ...(notif.delayType ? { delayType: notif.delayType } : {}),
      });
    }
    return { ok: true, [type]: true };
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
  const records = unwrapRecords(event);
  let processed = 0;
  let unresolved = 0;
  const errors: string[] = [];
  // Partial batch failure (#218): only the records that actually failed are
  // reported, so SQS redelivers those and deletes the rest. Throwing instead
  // would fail all ten of a batch's peers for one poison event — the same
  // defect #177 fixed on the send path.
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const { messageId, payload } of records) {
    const notif = normalize(payload);
    if (!notif) {
      // Never silently drop: an unresolved event means bounces aren't reaching
      // suppression, which is exactly the failure this handler used to have.
      // Not a batch failure though — a retry cannot make it resolvable, so it
      // is acknowledged and logged rather than cycled to the DLQ.
      unresolved++;
      const t = (payload as SesNotification)?.eventType ?? (payload as SesNotification)?.notificationType;
      console.warn("events: unresolved notification", { eventType: t });
      continue;
    }
    try {
      await apply(notif);
      processed++;
    } catch (e) {
      const msg = `${notif.eventType}/${notif.campaignId}: ${(e as Error).message}`;
      errors.push(msg);
      console.error("events: record failed", { messageId, error: msg });
      if (messageId) batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  if (unresolved > 0) console.warn("events: unresolved count", { unresolved });

  // A direct invoke (tests, manual replay) carries no SQS receipts, so there is
  // no partial-failure protocol to speak — surface the error instead of
  // returning a success the caller would believe.
  if (errors.length > 0 && batchItemFailures.length === 0) {
    throw new Error(`events: ${errors.length} failed — ${errors.join("; ")}`);
  }
  return { ok: errors.length === 0, processed, unresolved, batchItemFailures };
}
