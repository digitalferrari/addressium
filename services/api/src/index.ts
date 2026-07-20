/**
 * addressium service: api — thin HTTP handlers over the domain.
 *
 * Handlers validate/authorize, then call pure functions from @addressium/domain
 * against DynamoDB-backed stores (@addressium/adapters-aws). No business logic
 * lives here. See docs/ARCHITECTURE.md §4.2–4.3, §4.12.
 */
import {
  CognitoSubscriberAccounts,
  DynamoStores,
  EventBridgeScheduler,
  GoogleRecaptchaVerifier,
  SesEmailSender,
  getSecret,
  upsertSecret,
} from "@addressium/adapters-aws";
import { schemas } from "@addressium/core";
import {
  HmacConfirmationSigner,
  SystemClock,
  applyEntitlementSync,
  applyIdentitySync,
  buildConfirmationEmail,
  buildBatchConfirmationEmail,
  confirmOptInAny,
  effectiveOneOffTime,
  isHoneypotTripped,
  provisionSubscriberAccount,
  manualSuppress,
  publicListView,
  setAiConfig,
  setBranding,
  setListPresentation,
  saveCampaignDraft,
  saveList,
  saveSegment,
  setListVisibility,
  signup,
  signupMany,
  unsubscribeAll,
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
  pathParameters?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    http?: { method?: string };
    authorizer?: { jwt?: { claims?: Record<string, string | undefined> } };
  };
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

/**
 * POST /signup/batch — opt into several lists at once (the "All newsletters"
 * page, #61). Unauthenticated like /signup; one double opt-in email covers all.
 */
export async function signupBatchHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const raw = JSON.parse(event.body ?? "{}") as Record<string, unknown>;

    // Honeypot: a filled hidden field means bot. Accept silently so scrapers
    // can't distinguish success from rejection — but do nothing.
    if (isHoneypotTripped(raw)) return json(202, { status: "pending", lists: [] });

    // reCAPTCHA: verify only if this org configured a secret (opt-in).
    const orgId = typeof raw.orgId === "string" ? raw.orgId : "";
    const org = orgId ? await stores().organizations.get(orgId) : undefined;
    const secretArn = org?.signupProtection?.recaptchaSecretArn;
    if (secretArn) {
      const verifier = new GoogleRecaptchaVerifier(await getSecret(secretArn));
      const ok = await verifier.verify(typeof raw.recaptchaToken === "string" ? raw.recaptchaToken : "");
      if (!ok) return json(400, { error: "captcha verification failed" });
    }

    const res = await signupMany(stores(), await confirmSigner(), clock, raw);
    if (res.lists.length > 0) {
      const org = await stores().organizations.get(res.subscriber.orgId);
      const confirmUrl = `${env("CONFIRM_URL_BASE")}?token=${encodeURIComponent(res.confirmationToken)}`;
      const ses = new SesEmailSender(org?.sesConfigSet);
      await ses.send(buildBatchConfirmationEmail(res.lists, res.subscriber.email, confirmUrl));
    }
    return json(202, { subscriberId: res.subscriber.sub, status: "pending", lists: res.lists.map((l) => l.listId) });
  } catch (e) {
    return fail(e);
  }
}

/** GET /confirm?token=... — double opt-in landing; confirms every list in the token (§4.2). */
export async function confirmHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const token = event.queryStringParameters?.token ?? "";
    const subs = await confirmOptInAny(stores(), await confirmSigner(), clock, token);

    // Opt-in (#62): after the double opt-in is verified, provision a subscriber
    // Cognito account IF this org enabled it. Off by default — addressium
    // normally never writes to your pool. Best-effort: a provisioning hiccup
    // must not fail the confirmation the subscriber just completed.
    const first = subs[0];
    if (first) {
      const org = await stores().organizations.get(first.orgId);
      if (org?.signupProtection?.createAccountsOnConfirm && org.subscriberPoolId) {
        try {
          await provisionSubscriberAccount(
            stores(),
            new CognitoSubscriberAccounts(),
            first.orgId,
            org.subscriberPoolId,
            first.subscriberId,
          );
        } catch {
          // swallow — confirmation already succeeded; account sync can be retried
        }
      }
    }
    return json(200, { status: first?.status ?? "confirmed", confirmed: subs.length });
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
    if (!listId) throw new Error("token has no list");
    await unsubscribeFromList(stores(), clock, { orgId, subscriberId: sub, listId });
    return json(200, { status: "unsubscribed" });
  } catch (e) {
    return fail(e);
  }
}

// ---- Admin CRUD (authenticated, org-scoped, RBAC-gated) — §4.1, §4.12, #18 ----

/** GET /orgs/{org}/lists — list newsletters. POST — create/edit one. */
export async function listsHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "POST") {
      const input = schemas.createListSchema.parse(JSON.parse(event.body ?? "{}"));
      requireGrant(event, "campaigns:manage", input.orgId);
      return json(200, await saveList(stores(), input));
    }
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    return json(200, await stores().lists.list(orgId));
  } catch (e) {
    return fail(e);
  }
}

/** POST /lists/visibility — open (reopen) or close a newsletter (destructive). */
export async function listVisibilityHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const { orgId, listId, visibility } = JSON.parse(event.body ?? "{}") as {
      orgId: string;
      listId: string;
      visibility: "open" | "closed";
    };
    if (!orgId || !listId || !visibility) return json(400, { error: "orgId, listId, visibility required" });
    requireGrant(event, "newsletters:close", orgId);
    return json(200, await setListVisibility(stores(), orgId, listId, visibility));
  } catch (e) {
    return fail(e);
  }
}

/** GET /orgs/{org}/campaigns/{id} — read draft. POST /campaigns — save draft. */
export async function campaignsHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "POST") {
      const input = schemas.saveCampaignSchema.parse(JSON.parse(event.body ?? "{}"));
      requireGrant(event, "campaigns:manage", input.orgId);
      return json(200, await saveCampaignDraft(stores(), input));
    }
    const orgId = event.pathParameters?.org ?? "";
    const campaignId = event.pathParameters?.id ?? "";
    requireGrant(event, "reports:view", orgId);
    const campaign = await stores().campaigns.get(orgId, campaignId);
    return campaign ? json(200, campaign) : json(404, { error: "not found" });
  } catch (e) {
    return fail(e);
  }
}

/** GET /orgs/{org}/segments — list. POST /segments — create/edit one. */
export async function segmentsHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "POST") {
      const input = schemas.saveSegmentSchema.parse(JSON.parse(event.body ?? "{}"));
      requireGrant(event, "segments:manage", input.orgId);
      return json(200, await saveSegment(stores(), input));
    }
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    return json(200, await stores().segments.list(orgId));
  } catch (e) {
    return fail(e);
  }
}

/** POST /subscribers/suppress — manual suppression (admin). */
export async function subscriberSuppressHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const input = schemas.manualSuppressSchema.parse(JSON.parse(event.body ?? "{}"));
    requireGrant(event, "suppression:manage", input.orgId);
    return json(200, await manualSuppress(stores(), clock, input));
  } catch (e) {
    return fail(e);
  }
}

/** POST /subscribers/unsubscribe — admin-initiated unsubscribe (one list or all). */
export async function subscriberUnsubscribeHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const { orgId, subscriberId, listId, email } = JSON.parse(event.body ?? "{}") as {
      orgId: string;
      subscriberId: string;
      listId?: string;
      email?: string;
    };
    if (!orgId || !subscriberId) return json(400, { error: "orgId and subscriberId required" });
    requireGrant(event, "subscribers:manage", orgId);
    if (listId) {
      await unsubscribeFromList(stores(), clock, { orgId, subscriberId, listId });
      return json(200, { status: "unsubscribed", scope: "list" });
    }
    if (!email) return json(400, { error: "email required for unsubscribe-all" });
    const n = await unsubscribeAll(stores(), clock, { orgId, subscriberId, email });
    return json(200, { status: "unsubscribed", scope: "all", lists: n });
  } catch (e) {
    return fail(e);
  }
}

/** POST /orgs/branding — set subscriber-site branding/theme (#31). GET is public. */
export async function brandingHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "GET") {
      // Public: the subscriber site reads branding to theme itself.
      const orgId = event.pathParameters?.org ?? "";
      const org = await stores().organizations.get(orgId);
      return json(200, org?.branding ?? null);
    }
    const { orgId, branding } = JSON.parse(event.body ?? "{}") as {
      orgId?: string;
      branding?: import("@addressium/core").Branding;
    };
    if (!orgId || !branding) return json(400, { error: "orgId and branding required" });
    requireGrant(event, "branding:manage", orgId);
    const org = await setBranding(stores(), orgId, branding);
    return json(200, org.branding);
  } catch (e) {
    return fail(e);
  }
}

/** POST /lists/presentation — set a list's subscriber-site toggles (#33). */
export async function listPresentationHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const { orgId, listId, presentation } = JSON.parse(event.body ?? "{}") as {
      orgId?: string;
      listId?: string;
      presentation?: import("@addressium/core").ListPresentation;
    };
    if (!orgId || !listId || !presentation) return json(400, { error: "orgId, listId, presentation required" });
    requireGrant(event, "branding:manage", orgId);
    return json(200, await setListPresentation(stores(), orgId, listId, presentation));
  } catch (e) {
    return fail(e);
  }
}

/** GET /orgs/{org}/lists/{list}/public — public list view honoring toggles (#33). */
export async function publicListHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    const listId = event.pathParameters?.list ?? "";
    if (!orgId || !listId) return json(400, { error: "org and list required" });
    const view = await publicListView(stores(), orgId, listId);
    return view ? json(200, view) : json(404, { error: "not found" });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /orgs/ai-config — set the org's LLM analytics provider (#32). The
 * plaintext API key is written to Secrets Manager here; only the ARN + vendor/
 * model are persisted on the org. Gated by identity:manage.
 */
export async function aiConfigHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const { orgId, vendor, model, apiKey } = JSON.parse(event.body ?? "{}") as {
      orgId?: string;
      vendor?: "anthropic" | "openai" | "gemini";
      model?: string;
      apiKey?: string;
    };
    if (!orgId || !vendor || !model || !apiKey) {
      return json(400, { error: "orgId, vendor, model, apiKey required" });
    }
    requireGrant(event, "identity:manage", orgId);
    const apiKeySecretArn = await upsertSecret(`addressium/${orgId}/ai-provider`, apiKey);
    const org = await setAiConfig(stores(), orgId, { vendor, model, apiKeySecretArn });
    // Never echo the key back.
    return json(200, { orgId: org.orgId, aiConfig: { vendor, model, apiKeySecretArn } });
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

/**
 * POST /webhooks/identity — signed webhook from the main user pool / SoR (§4.3).
 * Applies add / email-change / delete keyed by the immutable Cognito `sub`.
 * One-directional: addressium never writes back to the pool.
 */
export async function identitySyncHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const raw = event.body ?? "";
    const sig = event.headers?.["x-addressium-signature"] ?? "";
    const secret = await getSecret(env("WEBHOOK_SECRET_ARN"));
    if (!verifyWebhookSignature(secret, raw, sig)) {
      return json(401, { error: "bad signature" });
    }
    const result = await applyIdentitySync(stores(), clock, JSON.parse(raw) as unknown);
    return json(200, result);
  } catch (e) {
    return fail(e);
  }
}
