/**
 * addressium service: api — thin HTTP handlers over the domain.
 *
 * Handlers validate/authorize, then call pure functions from @addressium/domain
 * against DynamoDB-backed stores (@addressium/adapters-aws). No business logic
 * lives here. See docs/ARCHITECTURE.md §4.2–4.3.
 */
import { DynamoStores, EventBridgeScheduler, SqsSendQueue } from "@addressium/adapters-aws";
import {
  HmacConfirmationSigner,
  SystemClock,
  applyEntitlementSync,
  confirmOptIn,
  signup,
  unsubscribeFromList,
  verifyWebhookSignature,
  type SendDescriptor,
} from "@addressium/domain";

export interface HttpEvent {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
}
export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const json = (statusCode: number, obj: unknown): HttpResult => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
});

const clock = new SystemClock();
let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));
let _confirm: HmacConfirmationSigner | undefined;
const confirmSigner = () => (_confirm ??= new HmacConfirmationSigner(env("CONFIRM_SECRET")));
let _queue: SqsSendQueue | undefined;
const queue = () => (_queue ??= new SqsSendQueue(env("SEND_QUEUE_URL")));
let _scheduler: EventBridgeScheduler | undefined;
const scheduler = () =>
  (_scheduler ??= new EventBridgeScheduler({
    roleArn: env("SCHEDULER_ROLE_ARN"),
    groupName: env("SCHEDULER_GROUP"),
    queueArn: env("SEND_QUEUE_ARN"),
    launchArn: env("LAUNCH_FN_ARN"),
  }));

/** POST /signup — public, double opt-in (§4.2). */
export async function signupHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const input = JSON.parse(event.body ?? "{}") as unknown;
    const res = await signup(stores(), confirmSigner(), clock, input);
    // TODO: enqueue the confirmation email carrying res.confirmationToken.
    return json(202, { subscriberId: res.subscriber.sub, status: res.subscription.status });
  } catch (e) {
    return json(400, { error: (e as Error).message });
  }
}

/** GET /confirm?token=... — double opt-in landing (§4.2). */
export async function confirmHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const token = event.queryStringParameters?.token ?? "";
    const sub = await confirmOptIn(stores(), confirmSigner(), clock, token);
    return json(200, { status: sub.status });
  } catch (e) {
    return json(400, { error: (e as Error).message });
  }
}

export interface ScheduleBody extends SendDescriptor {
  when:
    | { type: "now" }
    | { type: "at"; at: string } // absolute instant (offset/Z) — no zone needed
    | { type: "recurring"; cron: string; timezone?: string };
}

/** POST /campaigns/schedule — send now, at a time, or recurring (§4.6, §4.16). */
export async function scheduleCampaignHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const body = JSON.parse(event.body ?? "{}") as ScheduleBody;
    const descriptor: SendDescriptor = {
      orgId: body.orgId,
      campaignId: body.campaignId,
      listId: body.listId,
      subject: body.subject,
      template: body.template,
    };
    switch (body.when.type) {
      case "now":
        await queue().enqueue(descriptor);
        return json(202, { status: "queued" });
      case "at":
        await scheduler().scheduleOneOff({
          name: `camp-${body.orgId}-${body.campaignId}`,
          at: new Date(body.when.at),
          descriptor,
        });
        return json(202, { status: "scheduled" });
      case "recurring": {
        // Zone: per-campaign override ?? org defaultTimezone (§4.21).
        // TODO: resolve the org's defaultTimezone via an OrganizationStore when
        // no override is given; env default is the interim fallback.
        const timezone = body.when.timezone ?? process.env.DEFAULT_TIMEZONE ?? "UTC";
        await scheduler().scheduleRecurring({
          name: `series-${body.orgId}-${body.campaignId}`,
          cron: body.when.cron,
          timezone,
          payload: descriptor,
        });
        return json(202, { status: "recurring", timezone });
      }
      default:
        return json(400, { error: "unknown schedule type" });
    }
  } catch (e) {
    return json(400, { error: (e as Error).message });
  }
}

/** POST /unsubscribe?token=... — RFC 8058 one-click, no login (§4.2). */
export async function unsubscribeHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const token =
      event.queryStringParameters?.token ??
      new URLSearchParams(event.body ?? "").get("token") ??
      "";
    const { orgId, sub, listId } = confirmSigner().verify(token);
    await unsubscribeFromList(stores(), clock, { orgId, subscriberId: sub, listId });
    return json(200, { status: "unsubscribed" });
  } catch (e) {
    return json(400, { error: (e as Error).message });
  }
}

/** POST /webhooks/entitlement — signed webhook from the billing SoR (§4.3). */
export async function entitlementSyncHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const raw = event.body ?? "";
    const sig = event.headers?.["x-addressium-signature"] ?? "";
    if (!verifyWebhookSignature(env("WEBHOOK_SECRET"), raw, sig)) {
      return json(401, { error: "bad signature" });
    }
    const updated = await applyEntitlementSync(stores(), clock, JSON.parse(raw) as unknown);
    return json(200, { entitlement: updated.entitlement });
  } catch (e) {
    return json(400, { error: (e as Error).message });
  }
}
