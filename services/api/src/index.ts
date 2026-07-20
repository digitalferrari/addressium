/**
 * addressium service: api — thin HTTP handlers over the domain.
 *
 * Handlers validate/authorize, then call pure functions from @addressium/domain
 * against DynamoDB-backed stores (@addressium/adapters-aws). No business logic
 * lives here. See docs/ARCHITECTURE.md §4.2–4.3, §4.12.
 */
import {
  DynamoStores,
  EventBridgeScheduler,
  SesEmailSender,
  getSecret,
} from "@addressium/adapters-aws";
import {
  HmacConfirmationSigner,
  SystemClock,
  applyEntitlementSync,
  buildConfirmationEmail,
  confirmOptIn,
  effectiveOneOffTime,
  signup,
  unsubscribeFromList,
  verifyWebhookSignature,
  type SendDescriptor,
} from "@addressium/domain";
import {
  ForbiddenError,
  authorize,
  grantFromClaims,
  type Capability,
} from "@addressium/rbac";

export interface HttpEvent {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, string | undefined> } } };
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
const fail = (e: unknown): HttpResult =>
  e instanceof ForbiddenError
    ? json(403, { error: e.message })
    : json(400, { error: (e as Error).message });

/** Server-side RBAC: derive the caller's grant from JWT claims and check it. */
function requireGrant(event: HttpEvent, capability: Capability, orgId: string): void {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  authorize(grantFromClaims(claims), capability, orgId);
}

const clock = new SystemClock();
let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));

let _confirmSigner: HmacConfirmationSigner | undefined;
async function confirmSigner(): Promise<HmacConfirmationSigner> {
  if (!_confirmSigner) {
    _confirmSigner = new HmacConfirmationSigner(await getSecret(env("CONFIRM_SECRET_ARN")));
  }
  return _confirmSigner;
}

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
    const res = await signup(stores(), await confirmSigner(), clock, input);

    // Send the double opt-in confirmation email (transactional, §4.2).
    const list = await stores().lists.get(res.subscription.orgId, res.subscription.listId);
    if (list) {
      const org = await stores().organizations.get(res.subscription.orgId);
      const confirmUrl = `${env("CONFIRM_URL_BASE")}?token=${encodeURIComponent(res.confirmationToken)}`;
      const ses = new SesEmailSender(org?.sesConfigSet);
      await ses.send(buildConfirmationEmail(list, res.subscriber.email, confirmUrl));
    }
    return json(202, { subscriberId: res.subscriber.sub, status: res.subscription.status });
  } catch (e) {
    return fail(e);
  }
}

/** GET /confirm?token=... — double opt-in landing (§4.2). */
export async function confirmHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const token = event.queryStringParameters?.token ?? "";
    const sub = await confirmOptIn(stores(), await confirmSigner(), clock, token);
    return json(200, { status: sub.status });
  } catch (e) {
    return fail(e);
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
    requireGrant(event, "campaigns:schedule", body.orgId); // admin-only (§4.12)
    const descriptor: SendDescriptor = {
      orgId: body.orgId,
      campaignId: body.campaignId,
      listId: body.listId,
      subject: body.subject,
      template: body.template,
    };
    const oneOffName = `camp-${body.orgId}-${body.campaignId}`;
    switch (body.when.type) {
      // "now" and "at" both become one-off schedules placed at least 5 minutes
      // out (§4.6), so the send stays cancellable until it fires.
      case "now":
      case "at": {
        const requested = body.when.type === "at" ? new Date(body.when.at) : undefined;
        const at = effectiveOneOffTime(clock.now(), requested);
        await scheduler().scheduleOneOff({ name: oneOffName, at, descriptor });
        return json(202, { status: "scheduled", at: at.toISOString(), cancelName: oneOffName });
      }
      case "recurring": {
        // Zone: per-campaign override ?? org defaultTimezone (§4.21).
        let timezone = body.when.timezone;
        if (!timezone) {
          const orgRec = await stores().organizations.get(body.orgId);
          timezone = orgRec?.defaultTimezone ?? process.env.DEFAULT_TIMEZONE ?? "UTC";
        }
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
    return fail(e);
  }
}

/** POST /campaigns/cancel — cancel a scheduled one-off before it fires (§4.6). */
export async function cancelCampaignHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const { orgId, campaignId } = JSON.parse(event.body ?? "{}") as {
      orgId: string;
      campaignId: string;
    };
    if (!orgId || !campaignId) return json(400, { error: "orgId and campaignId required" });
    requireGrant(event, "campaigns:schedule", orgId);
    await scheduler().cancel(`camp-${orgId}-${campaignId}`);
    return json(200, { status: "cancelled" });
  } catch (e) {
    return fail(e);
  }
}

/** POST /unsubscribe?token=... — RFC 8058 one-click, no login (§4.2). */
export async function unsubscribeHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const token =
      event.queryStringParameters?.token ??
      new URLSearchParams(event.body ?? "").get("token") ??
      "";
    const { orgId, sub, listId } = (await confirmSigner()).verify(token);
    await unsubscribeFromList(stores(), clock, { orgId, subscriberId: sub, listId });
    return json(200, { status: "unsubscribed" });
  } catch (e) {
    return fail(e);
  }
}

/** POST /webhooks/entitlement — signed webhook from the billing SoR (§4.3). */
export async function entitlementSyncHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const raw = event.body ?? "";
    const sig = event.headers?.["x-addressium-signature"] ?? "";
    const secret = await getSecret(env("WEBHOOK_SECRET_ARN"));
    if (!verifyWebhookSignature(secret, raw, sig)) {
      return json(401, { error: "bad signature" });
    }
    const updated = await applyEntitlementSync(stores(), clock, JSON.parse(raw) as unknown);
    return json(200, { entitlement: updated.entitlement });
  } catch (e) {
    return fail(e);
  }
}
