/**
 * addressium service: api — thin HTTP handlers over the domain.
 *
 * Handlers validate/authorize, then call pure functions from @addressium/domain
 * against DynamoDB-backed stores (@addressium/adapters-aws). No business logic
 * lives here. See docs/ARCHITECTURE.md §4.2–4.3.
 */
import { DynamoStores } from "@addressium/adapters-aws";
import {
  HmacConfirmationSigner,
  SystemClock,
  applyEntitlementSync,
  confirmOptIn,
  signup,
  unsubscribeFromList,
  verifyWebhookSignature,
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
