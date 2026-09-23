/**
 * addressium service: api — thin HTTP handlers over the domain.
 *
 * Handlers validate/authorize, then call pure functions from @addressium/domain
 * against DynamoDB-backed stores (@addressium/adapters-aws). No business logic
 * lives here. See docs/ARCHITECTURE.md §4.2–4.3, §4.12.
 */
import {
  CloudWatchHealth,
  S3AuditLog,
  S3ExportWriter,
  CognitoAdminDirectory,
  CognitoSubscriberAccounts,
  DynamoStores,
  EventBridgeScheduler,
  GoogleRecaptchaVerifier,
  SesEmailSender,
  S3ImportFileStore,
  SesIdentityStatusReader,
  SesSuppressionListReader,
  SfnDripStarter,
  SqsSendQueue,
  SqsCustomerSyncQueue,
  getSecret,
  sanitizeEmailHtml,
} from "@addressium/adapters-aws";
import { gsiEngineLimitation, type SegmentPredicate } from "@addressium/segment";
import { randomUUID } from "node:crypto";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  schemas,
  APP_VERSION,
  EXPECTED_SCHEMA_VERSION,
  ZodError,
  type AlertConfig,
  type Subscription,
} from "@addressium/core";
import {
  HmacConfirmationSigner,
  InvalidInputError,
  StaleEntitlementError,
  InvalidTokenError,
  applyPreferences,
  buildPreferenceLinkEmail,
  preferenceCentre,
  requestPreferenceLink,
  RetiredKeyError,
  TokenExpiredError,
  SystemClock,
  applyEntitlementSync,
  applyIdentitySync,
  buildConfirmationEmail,
  buildBatchConfirmationEmail,
  confirmOptInAny,
  effectiveOneOffTime,
  enrollManually,
  enrollOnConfirmation,
  evaluateSetup,
  importObjectKey,
  importSuppressionList,
  importPinpointSegment,
  type PinpointSegmentResponse,
  isHoneypotTripped,
  markScheduleActive,
  recordScheduledCampaign,
  type CampaignScheduler,
  startImportJob,
  scheduleName,
  transitionSchedule,
  type EmailTemplate,
  provisionSubscriberAccount,
  manualSuppress,
  liftSuppression,
  checkSuppression,
  capabilitiesOf,
  exportCsvChunks,
  exportJsonlChunks,
  importCsvSubscribers,
  inviteMember,
  listTeam,
  setMemberAccess,
  setMemberEnabled,
  columnsBlockingConfirmed,
  importWithMapping,
  previewCsv,
  suggestMapping,
  validateMapping,
  type MappingPlan,
  type NewListDefaults,
  exportSubscriber,
  eraseSubscriber,
  publicListDirectory,
  publicListView,
  readSendingIdentity,
  type SesIdentityReader,
  recordAudit,
  setBranding,
  setListPresentation,
  saveCampaignDraft,
  saveList,
  saveSegment,
  listSegmentMembers,
  subscriberDetail,
  subscriberTimeline,
  setSubscriberAttributes,
  setSubscriptionStatus,
  updateSegmentMembership,
  saveDripSequence,
  saveTemplate,
  saveMergeTag,
  listMergeTags,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  authenticateApiKey,
  resolveReengagementPolicy,
  deleteMergeTag,
  saveCampaignSeries,
  listCampaignSeries,
  getCampaignSeries,
  setListVisibility,
  signup,
  signupMany,
  unsubscribeAll,
  unsubscribeAllWithChanges,
  unsubscribeFromList,
  verifyWebhookSignature,
  type DripStarter,
  type SendDescriptor,
  type SentMessage,
  type SuppressionChecker,
  type SuppressionListReader,
  type Stores,
  rotateCustomerSyncSigningSecret,
  serializeCustomerSyncSigningSecret,
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
    /** "METHOD /path" as registered in API Gateway; drives router dispatch. */
    routeKey?: string;
    http?: { method?: string; sourceIp?: string; userAgent?: string };
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
/** What a caller is told when the failure was ours, not theirs. */
const GENERIC_FAILURE = "Something went wrong on our end. Please try again.";

/**
 * What a subscriber is told when their confirm/unsubscribe/manage link does not
 * verify — one sentence for every cause (#265).
 *
 * The causes stay distinguishable in the domain and in the log, because they
 * matter there: a retired signing key is our doing and a forged signature is
 * not. To the holder of the link they are the same event with the same remedy,
 * and the differences — which key id, which scope was expected, whether the
 * subscription exists — are exactly what must not be published. The two
 * handlers that can do better than this (unsubscribe, preferences) still catch
 * `RetiredKeyError`/`TokenExpiredError` by type and answer 410 with their own
 * copy; this is the floor for everything else, including the confirm page,
 * which had no such branch and served the raw message.
 */
const INVALID_LINK =
  "That link is invalid or has expired. Please use the most recent email, or sign up again.";

/**
 * Turn an exception into a response, classifying by TYPE (#265).
 *
 * This used to be `403 if ForbiddenError, else 400 with the raw .message`, and
 * ~40 catch sites funnel through it. So EVERY failure was presented to the
 * caller as their own mistake, carrying whatever the message happened to hold:
 * a subscriber typing an address without an `@` was shown the entire serialized
 * ZodError including the email regex, and a perfectly good signup that our SES
 * identity could not yet send to was shown a 400 naming our region and echoing
 * their address back at them. Both are on the PUBLIC subscriber site.
 *
 * The branches, in the order they are matched:
 *
 * - `ForbiddenError` → 403. Unchanged.
 * - `ZodError` → 400 with ONE short sentence derived from the first issue. The
 *   issue array is never serialized: besides being unreadable, a Zod 4 issue can
 *   carry `input`, which would re-leak the very value we are trying not to echo.
 * - `InvalidTokenError` → 400 with one fixed sentence for every cause, real
 *   message logged. Matched BEFORE the line below, which would otherwise publish
 *   it.
 * - `InvalidInputError` → 400 with its message, which the domain has marked
 *   safe to show by choosing that type. See its definition in `ports.ts` for why
 *   this is a type and not an allowlist of message strings.
 * - anything else → 500 and a fixed sentence, with the real error logged so it
 *   still reaches CloudWatch. An unverified identity, a missing env var, an IAM
 *   denial and a Dynamo throttle all land here, which is where they belong.
 */
const fail = (e: unknown): HttpResult => {
  if (e instanceof ForbiddenError) return json(403, { error: e.message });
  // A signed billing relay may redeliver or arrive out of order. It is a valid
  // request that lost to a later monotonic version, not malformed input; 409
  // tells the relay to record/drop it rather than retry it indefinitely.
  if (e instanceof StaleEntitlementError) return json(409, { error: e.message });
  // `instanceof` plus a name check: the re-export from core keeps a single zod
  // in the tree, but a hoisting accident that produced two copies would fail
  // `instanceof` silently and downgrade every validation error to a 500.
  if (e instanceof ZodError || (e as Error)?.name === "ZodError") {
    return json(400, { error: zodMessage(e as ZodError) });
  }
  // BEFORE the generic InvalidInputError branch, which would otherwise pass the
  // factual token message straight through — the ordering is the enforcement.
  if (e instanceof InvalidTokenError) {
    console.error("invalid token", { name: e.name, error: e.message });
    return json(400, { error: INVALID_LINK });
  }
  if (e instanceof InvalidInputError) return json(400, { error: e.message });
  console.error("unhandled failure", {
    name: (e as Error)?.name,
    error: (e as Error)?.message,
    stack: (e as Error)?.stack,
  });
  return json(500, { error: GENERIC_FAILURE });
};

/**
 * One human sentence for a validation failure.
 *
 * Path-prefixed by default (`listIds is required`) because on the admin plane
 * the operator needs to know WHICH field, and a bare "is required" is useless in
 * a form with twelve of them. The email case is special-cased and unprefixed
 * because it is the one that reaches the public signup box, where "email is not
 * valid" is worse copy than the plain instruction.
 */
function zodMessage(e: ZodError): string {
  const issue = e.issues?.[0];
  if (!issue) return "The request was not valid.";
  if (issue.code === "invalid_format" && (issue as { format?: string }).format === "email") {
    return "Enter a valid email address.";
  }
  const path = issue.path?.join(".") ?? "";
  const reason =
    issue.code === "invalid_type" && (issue as { received?: string }).received === "undefined"
      ? "is required"
      : issue.code === "too_small"
        ? "is too short"
        : issue.code === "too_big"
          ? "is too long"
          : "is not valid";
  return path ? `${path} ${reason}.` : `The request ${reason}.`;
}

/** API Gateway normally lowercases headers, but local adapters need not. */
function header(headers: HttpEvent["headers"], name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) return value ?? "";
  }
  return "";
}

/** Server-side RBAC: derive the caller's grant from JWT claims and check it. */
function requireGrant(event: HttpEvent, capability: Capability, orgId: string): void {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  authorize(grantFromClaims(claims), capability, orgId);
}

const clock = new SystemClock();
let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));
let _customerSyncQueue: SqsCustomerSyncQueue | undefined;
const customerSyncQueue = () => {
  const url = process.env.CUSTOMER_SYNC_QUEUE_URL;
  return url ? (_customerSyncQueue ??= new SqsCustomerSyncQueue(url)) : undefined;
};

async function publishCustomerSync(
  subscription: Subscription,
  type: "subscribed" | "unsubscribed",
): Promise<void> {
  const queue = customerSyncQueue();
  if (!queue) return;
  const [org, subscriber] = await Promise.all([
    stores().organizations.get(subscription.orgId),
    stores().subscribers.get(subscription.orgId, subscription.subscriberId),
  ]);
  if (!org?.customerSync?.enabled || !subscriber?.externalId) return;
  try {
    await queue.enqueue({
      // `updatedAt` is the durable version of this subscription transition.
      // It keeps retries idempotent while allowing a real unsubscribe ->
      // resubscribe (or later repeated transition) to produce a new FIFO
      // message instead of being swallowed by SQS's five-minute dedupe window.
      eventId: `${subscription.orgId}/${subscription.subscriberId}/${subscription.listId}/${subscription.updatedAt}/${type}`,
      type,
      orgId: subscription.orgId,
      subscriberId: subscription.subscriberId,
      externalId: subscriber.externalId,
      email: subscriber.email,
      listId: subscription.listId,
      occurredAt: subscription.updatedAt,
    });
  } catch (e) {
    // The subscription is already durable. A queue outage must not turn a
    // successful confirmation/unsubscribe into a misleading failure page.
    console.error("customer-sync: queue handoff failed", {
      orgId: subscription.orgId,
      subscriberId: subscription.subscriberId,
      listId: subscription.listId,
      type,
      error: (e as Error).message,
    });
  }
}

/**
 * Backfill the current membership state after an external ID is attached.
 * Confirmation can happen before Cognito/account identity sync finishes; if we
 * only publish at the moment of confirmation, the external customer record
 * would never learn about that already-confirmed list. Reusing the durable
 * subscription timestamp keeps these backfills idempotent at the endpoint.
 */
async function publishCurrentCustomerSync(orgId: string, subscriberId: string): Promise<void> {
  try {
    const memberships = await stores().subscriptions.listBySubscriber(orgId, subscriberId);
    await Promise.all(
      memberships
        .filter((subscription) => subscription.status === "confirmed" || subscription.status === "unsubscribed")
        .map((subscription) => publishCustomerSync(subscription, subscription.status === "confirmed" ? "subscribed" : "unsubscribed")),
    );
  } catch (e) {
    // Identity sync/account provisioning has already succeeded. Customer-record
    // delivery remains best-effort and will be retried by the next membership
    // transition rather than turning the identity write into a false failure.
    console.error("customer-sync: membership backfill failed", {
      orgId,
      subscriberId,
      error: (e as Error).message,
    });
  }
}
const customerSyncSecrets = new SecretsManagerClient({});

async function saveCustomerSyncSecret(orgId: string, value: string): Promise<string> {
  const name = `addressium/${orgId}/customer-sync`;
  if (process.env.ADDRESSIUM_LOCAL === "1") return serializeCustomerSyncSigningSecret({ version: 1, current: value });
  try {
    const existing = await customerSyncSecrets.send(new GetSecretValueCommand({ SecretId: name }));
    const next = rotateCustomerSyncSigningSecret(existing.SecretString ?? "", value);
    await customerSyncSecrets.send(
      new PutSecretValueCommand({ SecretId: name, SecretString: serializeCustomerSyncSigningSecret(next) }),
    );
  } catch (e) {
    if ((e as { name?: string }).name !== "ResourceNotFoundException") throw e;
    await customerSyncSecrets.send(
      new CreateSecretCommand({
        Name: name,
        SecretString: serializeCustomerSyncSigningSecret({ version: 1, current: value }),
      }),
    );
  }
  return name;
}

let _confirmSigner: HmacConfirmationSigner | undefined;
async function confirmSigner(): Promise<HmacConfirmationSigner> {
  if (!_confirmSigner) {
    _confirmSigner = new HmacConfirmationSigner(await getSecret(env("CONFIRM_SECRET_ARN")));
  }
  return _confirmSigner;
}

let _exportWriter: S3ExportWriter | undefined;
const exportWriter = () => (_exportWriter ??= new S3ExportWriter(env("EXPORT_BUCKET")));

let _scheduler: EventBridgeScheduler | undefined;
const scheduler = () =>
  (_scheduler ??= new EventBridgeScheduler({
    roleArn: env("SCHEDULER_ROLE_ARN"),
    groupName: env("SCHEDULER_GROUP"),
    queueArn: env("SEND_QUEUE_ARN"),
    launchArn: env("LAUNCH_FN_ARN"),
  }));

/**
 * The drip starter (#245). Lazy, like every other dependency here, and for a
 * sharper reason than tidiness: this file is the single bundle entry for fifteen
 * Lambdas, so an `env("DRIP_STATE_MACHINE_ARN")` at module scope would throw at
 * COLD START for all of them — including `/unsubscribe`, the one route that must
 * never be down. A missing var must degrade drip enrollment, not the public API.
 */
let _importFiles: S3ImportFileStore | undefined;
/** Lazy like every other dependency here — see the drip starter's note below. */
const importFiles = () => (_importFiles ??= new S3ImportFileStore(env("IMPORT_BUCKET")));

/**
 * The live per-address SES suppression check/write (#247). Lazy, and needs no
 * env var: unlike the bulk import reader it takes no reasons/page-size config,
 * and the SDK client resolves credentials and region on its own.
 */
let _suppressionChecker: SesSuppressionListReader | undefined;
const suppressionChecker = () => (_suppressionChecker ??= new SesSuppressionListReader());

/**
 * The live SES verification / sandbox read (#285). Lazy and env-free for the
 * same reason as the suppression checker above — the SDK resolves credentials
 * and region itself, and there is nothing per-deployment to configure. Read-only
 * by construction: the class holds `GetEmailIdentity` and `GetAccount` and no
 * command that creates or changes anything.
 */
let _sesIdentityReader: SesIdentityStatusReader | undefined;
const sesIdentityReader = () => (_sesIdentityReader ??= new SesIdentityStatusReader());

let _dripStarter: SfnDripStarter | undefined;
const dripStarter = () =>
  (_dripStarter ??= new SfnDripStarter({ stateMachineArn: env("DRIP_STATE_MACHINE_ARN") }));

/**
 * Request provenance for a consent record (#220).
 *
 * API Gateway puts the caller's address in `requestContext.http.sourceIp`.
 * Nothing read it before, so every consent record carried a hardcoded
 * `"0.0.0.0"` — an assertion that was simply false. Absent stays absent here:
 * an omitted field is honest, a fabricated one is not.
 */
function provenance(event: HttpEvent): { sourceIp?: string; userAgent?: string } {
  const ip = event.requestContext?.http?.sourceIp;
  const ua = event.requestContext?.http?.userAgent ?? event.headers?.["user-agent"];
  return { ...(ip ? { sourceIp: ip } : {}), ...(ua ? { userAgent: ua } : {}) };
}

/**
 * A confirmation-email sender. Narrow on purpose — it is the one dependency of
 * the signup routes worth faking, and `SesEmailSender` satisfies it structurally.
 */
export interface ConfirmationSender {
  send(message: SentMessage): Promise<unknown>;
}

/**
 * POST /signup — public, double opt-in (§4.2).
 *
 * `injected` exists for tests only, and only for the sender — following
 * `dripEnrollHandler`'s precedent (#265). A send failure here is the difference
 * between a subscriber seeing "check your email" and seeing our SES
 * configuration, and that branch cannot be exercised against real SES.
 */
export async function signupHandler(
  event: HttpEvent,
  injected?: { sender?: ConfirmationSender },
): Promise<HttpResult> {
  try {
    const raw = JSON.parse(event.body ?? "{}") as Record<string, unknown>;

    // Same abuse protections as /signup/batch, which had them while THIS route —
    // the primary, most-embedded signup path — had none (#170). An unprotected
    // signup endpoint is a list-poisoning and confirmation-email-spam vector:
    // every submission sends real mail to an attacker-chosen address, which
    // burns sender reputation on the org's own SES identity.

    // Honeypot: a filled hidden field means bot. Accept silently so scrapers
    // can't distinguish success from rejection — but do nothing.
    if (isHoneypotTripped(raw)) return json(202, { status: "pending" });

    // reCAPTCHA: verify only if this org configured a secret (opt-in).
    const orgId = typeof raw.orgId === "string" ? raw.orgId : "";
    const protectedOrg = orgId ? await stores().organizations.get(orgId) : undefined;
    const secretArn = protectedOrg?.signupProtection?.recaptchaSecretArn;
    if (secretArn) {
      const verifier = new GoogleRecaptchaVerifier(await getSecret(secretArn));
      const ok = await verifier.verify(typeof raw.recaptchaToken === "string" ? raw.recaptchaToken : "");
      if (!ok) return json(400, { error: "captcha verification failed" });
    }

    const res = await signup(stores(), await confirmSigner(), clock, raw, provenance(event));

    // Send the double opt-in confirmation email (transactional, §4.2).
    //
    // Its OWN try/catch (#265). The subscriber and their pending subscription
    // are already written by the line above, so a send failure here used to be
    // caught by the handler's outer catch and served as a 400 — a completed
    // signup presented to the subscriber as their own error, with the SES
    // failure text (our region, their address echoed back) as the message.
    //
    // A 500 rather than the 202 the record would justify, because the 202 says
    // "check your email" and no email is coming. Retry is safe and is the
    // self-healing path: `signup()` is idempotent — `findOrCreateSubscriber`
    // and `pendingSubscription` both find-or-create, so re-submitting the same
    // address re-stamps `requestedAt` and mints a fresh token rather than
    // erroring or duplicating.
    const list = await stores().lists.get(res.subscription.orgId, res.subscription.listId);
    if (list) {
      try {
        const org = await stores().organizations.get(res.subscription.orgId);
        const confirmUrl = `${env("CONFIRM_URL_BASE")}?token=${encodeURIComponent(res.confirmationToken)}`;
        const ses =
          injected?.sender ??
          new SesEmailSender(org?.sesConfigSet, undefined, org?.sesTransactionalConfigSet);
        await ses.send(buildConfirmationEmail(list, res.subscriber.email, confirmUrl));
      } catch (e) {
        console.error("signup: confirmation send failed", {
          orgId: res.subscription.orgId,
          listId: res.subscription.listId,
          error: (e as Error).message,
        });
        return json(500, { error: GENERIC_FAILURE });
      }
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
export async function signupBatchHandler(
  event: HttpEvent,
  injected?: { sender?: ConfirmationSender },
): Promise<HttpResult> {
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

    const res = await signupMany(stores(), await confirmSigner(), clock, raw, provenance(event));
    // Its own try/catch, for the reason /signup's carries in full: the
    // subscriptions are already durable, so a send failure must not be served
    // as the subscriber's 400. Idempotent on retry, same as /signup (#265).
    if (res.lists.length > 0) {
      try {
        const org = await stores().organizations.get(res.subscriber.orgId);
        const confirmUrl = `${env("CONFIRM_URL_BASE")}?token=${encodeURIComponent(res.confirmationToken)}`;
        const ses =
          injected?.sender ??
          new SesEmailSender(org?.sesConfigSet, undefined, org?.sesTransactionalConfigSet);
        await ses.send(buildBatchConfirmationEmail(res.lists, res.subscriber.email, confirmUrl));
      } catch (e) {
        console.error("signup/batch: confirmation send failed", {
          orgId: res.subscriber.orgId,
          lists: res.lists.length,
          error: (e as Error).message,
        });
        return json(500, { error: GENERIC_FAILURE });
      }
    }
    return json(202, { subscriberId: res.subscriber.sub, status: "pending", lists: res.lists.map((l) => l.listId) });
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /confirm?token=... — double opt-in landing; confirms every list in the
 * token (§4.2).
 *
 * `injected` exists for tests only, and only for the drip starter (#245). The
 * enrollment side effect is best-effort — it must never fail the confirmation —
 * and a guard nobody can exercise is a guard nobody knows is there, so the one
 * dependency that reaches Step Functions is injectable. Same reasoning, and the
 * same shape, as `rotateConfirmSecretHandler`'s `SecretsClientLike`.
 */
export async function confirmHandler(
  event: HttpEvent,
  injected?: { starter?: DripStarter },
): Promise<HttpResult> {
  try {
    const token = event.queryStringParameters?.token ?? "";
    const subs = await confirmOptInAny(stores(), await confirmSigner(), clock, token, provenance(event));
    await Promise.all(subs.map((subscription) => publishCustomerSync(subscription, "subscribed")));

    // After the double opt-in is verified, ensure the subscriber has an account
    // in the org's linked pool, so their magic-link tokens can carry the pool
    // `sub` a paywall resolves against. Gated on the org having magic links on
    // — with the feature off addressium never touches Cognito at all.
    //
    // Handed to a dedicated function rather than done here (#23). THIS handler
    // is the internet-facing double-opt-in landing page; giving it Cognito write
    // permission means a compromise of the most-exposed route in the product
    // reaches the operator's user directory. The provisioner holds that grant
    // instead, scoped to the linked pools, and this route can only ask it to run.
    //
    // Best-effort and asynchronous: a provisioning hiccup must not fail — or
    // slow — the confirmation the subscriber just completed. A subscriber left
    // without an externalId is sent to without a token and shows up in
    // SendResult.untokenized.
    const first = subs[0];
    if (first) {
      const org = await stores().organizations.get(first.orgId);
      if (org?.magicLink && org.subscriberPoolId) {
        try {
          await requestSubscriberAccount({
            orgId: first.orgId,
            poolId: org.subscriberPoolId,
            subscriberId: first.subscriberId,
          });
        } catch (e) {
          // swallow — confirmation already succeeded; account sync can be retried
          console.error("confirm: subscriber account request failed", {
            orgId: first.orgId,
            error: (e as Error).message,
          });
        }
      }
    }

    // Enroll into any signup-triggered drip sequence for the lists just
    // confirmed (§4.6, #245). Same best-effort posture, same reason, and it must
    // stay that way: an unguarded throw here would hand `fail(e)` a 400 for a
    // confirmation that is already durable in DynamoDB — the subscriber sees
    // "missing env DRIP_STATE_MACHINE_ARN" on the page that was supposed to say
    // "you're subscribed", and re-clicking cannot fix it because the confirmation
    // already happened.
    await enrollConfirmed(subs, injected);

    return json(200, { status: first?.status ?? "confirmed", confirmed: subs.length });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Best-effort drip enrollment for everything one confirmation confirmed (#245).
 *
 * `stores` and `starter` are injectable — following
 * `rotateConfirmSecretHandler`'s precedent — so the SWALLOW is exercised in tests
 * rather than discovered in production. That try/catch is the only thing standing
 * between a Step Functions hiccup and a 400 on the double-opt-in landing page,
 * and a guard nobody can test is a guard nobody knows is there.
 *
 * Every confirmed subscription, not `subs[0]`: a batch signup mints one token
 * carrying every listId, so one click can confirm three lists and each may
 * trigger a different sequence.
 */
export async function enrollConfirmed(
  subs: Subscription[],
  injected?: { stores?: Stores; starter?: DripStarter },
): Promise<void> {
  if (subs.length === 0) return;
  try {
    await enrollOnConfirmation(injected?.stores ?? stores(), injected?.starter ?? dripStarter(), subs);
  } catch (e) {
    // swallow — the confirmation already succeeded and is already stored; a
    // failed enrollment costs this subscriber a welcome sequence, not their
    // subscription.
    console.error("confirm: drip enrollment failed", {
      orgId: subs[0]?.orgId,
      error: (e as Error).message,
    });
  }
}

/**
 * Ask the provisioner to run. Event invocation, so the caller neither waits for
 * Cognito nor fails with it — the confirmation is already durable by this point,
 * and a subscriber without a pool account is a degraded send, not a lost signup.
 */
async function requestSubscriberAccount(payload: SubscriberAccountRequest): Promise<void> {
  await new LambdaClient({}).send(
    new InvokeCommand({
      FunctionName: env("SUBSCRIBER_ACCOUNT_FN"),
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

export interface SubscriberAccountRequest {
  orgId: string;
  poolId: string;
  subscriberId: string;
}

/**
 * Create (or resolve) the subscriber's account in the org's linked Cognito pool
 * and stamp the returned `sub` as their externalId (#23, #62).
 *
 * A function of its own for exactly one reason: it is the only code in the
 * product that may write to an operator's user directory, and it must therefore
 * be the only role that can. It is NOT reachable from the API — no route maps to
 * it — so the only caller is `confirmHandler`, via `lambda:InvokeFunction` on
 * this function alone.
 *
 * The pool id arrives in the payload rather than the environment because pools
 * are per-org and linked at runtime. It is re-read from the ORG RECORD here and
 * not trusted from the caller: an invoker who could name an arbitrary pool would
 * have the escalation this split exists to remove.
 */
export async function subscriberAccountHandler(event: SubscriberAccountRequest): Promise<void> {
  const org = await stores().organizations.get(event.orgId);
  if (!org?.magicLink || !org.subscriberPoolId) {
    // The toggle went off, or the pool was unlinked, between confirm and here.
    console.warn("subscriber-account: org no longer provisions accounts", { orgId: event.orgId });
    return;
  }
  if (org.subscriberPoolId !== event.poolId) {
    // Not fatal — the org record wins — but worth saying out loud, because it
    // means a request was queued against a pool that is no longer the org's.
    console.warn("subscriber-account: pool changed since the request", {
      orgId: event.orgId,
      requested: event.poolId,
      current: org.subscriberPoolId,
    });
  }
  const updated = await provisionSubscriberAccount(
    stores(),
    new CognitoSubscriberAccounts(),
    event.orgId,
    org.subscriberPoolId,
    event.subscriberId,
  );
  if (updated) await publishCurrentCustomerSync(event.orgId, updated.sub);
}

/**
 * The zone a send is displayed in: org `defaultTimezone` ?? deployment default
 * (§4.21). Factored out of the recurring branch when the one-off branch started
 * stamping `Campaign.schedule`, which carries a zone too — one resolution rule,
 * so a one-off and a series in the same org can never disagree about what
 * "13:00" means.
 */
async function orgTimezone(orgId: string): Promise<string> {
  const orgRec = await stores().organizations.get(orgId);
  return orgRec?.defaultTimezone ?? process.env.DEFAULT_TIMEZONE ?? "UTC";
}

/**
 * POST /campaigns/schedule — send now, at a time, or recurring (§4.6, §4.16).
 *
 * `injected.scheduler` is the test seam, the same shape `dripEnrollHandler` uses
 * for its starter: EventBridge Scheduler has no local emulator, so without it
 * nothing could drive this route end to end — which is how it shipped writing an
 * EventBridge schedule and a lifecycle record but no Campaign record at all
 * (#221). Production passes nothing and gets the real client.
 */
export async function scheduleCampaignHandler(
  event: HttpEvent,
  injected?: { scheduler?: CampaignScheduler },
): Promise<HttpResult> {
  try {
    const body = schemas.scheduleCampaignSchema.parse(JSON.parse(event.body ?? "{}"));
    requireGrant(event, "campaigns:schedule", body.orgId); // admin-only (§4.12)
    // Body resolution (§4.15): raw HTML is hard-sanitized; MJML our SPA compiled
    // is trusted as-is (its Outlook conditional comments must survive); block
    // bodies get their text/ad HTML hard-sanitized too (#94) so blocks mode is no
    // weaker than raw_html — editorial link urls are already scheme-checked by
    // the schema and re-checked at render.
    const template: EmailTemplate =
      "html" in body.template ? { html: sanitizeEmailHtml(body.template.html) }
      : "mjmlHtml" in body.template ? { html: body.template.mjmlHtml }
      : {
          blocks: body.template.blocks.map((b) =>
            b.kind === "text" ? { ...b, html: sanitizeEmailHtml(b.html) }
            : b.kind === "ad" ? { ...b, html: sanitizeEmailHtml(b.html) }
            : b,
          ),
        };
    const descriptor: SendDescriptor = {
      orgId: body.orgId,
      campaignId: body.campaignId,
      listId: body.listId,
      subject: body.subject,
      template,
      // Carried through to the sender (#203). Before this the console offered a
      // segment picker whose value was dropped here, so a "send to my test
      // cohort" campaign mailed the entire list.
      ...(body.segmentId ? { segmentId: body.segmentId } : {}),
    };
    const feed = body.feedId ? await stores().feeds.get(body.orgId, body.feedId) : undefined;
    if (body.feedId && !feed) return json(400, { error: `unknown feed "${body.feedId}"` });
    if (body.feedId && body.when.type !== "recurring") {
      return json(400, { error: "a feed can only be used with a recurring campaign" });
    }
    if (feed && feed.targetListId !== body.listId) {
      return json(400, { error: `feed "${feed.feedId}" targets newsletter "${feed.targetListId}"` });
    }
    // Not string concatenation: `-` is legal inside both ids, so the old
    // `camp-${orgId}-${campaignId}` was ambiguous across tenants (#196).
    const oneOffName = scheduleName("camp", body.orgId, body.campaignId);
    switch (body.when.type) {
      // "now" and "at" both become one-off schedules placed at least 5 minutes
      // out (§4.6), so the send stays cancellable until it fires.
      case "now":
      case "at": {
        const requested = body.when.type === "at" ? new Date(body.when.at) : undefined;
        const at = effectiveOneOffTime(clock.now(), requested);
        // Resolved once for both records below, so the Campaign row and the
        // lifecycle row cannot end up stamped with different zones for the same
        // instant — two lookups could straddle a change to the org default.
        const timezone = await orgTimezone(body.orgId);
        await (injected?.scheduler ?? scheduler()).scheduleOneOff({ name: oneOffName, at, descriptor });
        // The Campaign record, WITHOUT which this send has no counters (#221).
        // The compose screen posts only to this route, so this is the only place
        // a one-off's `CAMPAIGNREC#<id>` can come from; see
        // `recordScheduledCampaign` for why it is not the sender's job. The
        // EventBridge schedule above is already live at this point; what makes
        // the ordering safe is the 5-minute floor `effectiveOneOffTime` puts on
        // every one-off (§4.6), so the row is in place long before the send can
        // fire.
        await recordScheduledCampaign(stores(), {
          orgId: body.orgId,
          campaignId: body.campaignId,
          subject: body.subject,
          listId: body.listId,
          segmentId: body.segmentId,
          sendAt: at.toISOString(),
          timezone,
          type: "one_off",
        });
        // The same instant onto the LIFECYCLE record (#248). The Schedules view
        // lists these rows, not campaigns, and it is the screen an operator
        // reaches for to hit Pause inside the five-minute window — so the time
        // being raced has to be on this record too, not only on the campaign.
        await markScheduleActive(stores(), clock, {
          orgId: body.orgId,
          scheduleId: body.campaignId,
          kind: "one_off",
          sendAt: at.toISOString(),
          timezone,
        });
        return json(202, { status: "scheduled", at: at.toISOString(), scheduleId: body.campaignId });
      }
      case "recurring": {
        // Zone: per-campaign override ?? org defaultTimezone (§4.21).
        // `||`, not `??`: `timezone` is `z.string().optional()` with no
        // `.min(1)`, so `""` is a valid payload — and `??` would pass that empty
        // string through to `ScheduleExpressionTimezone` verbatim instead of
        // falling back, which is what the old `if (!timezone)` did.
        const timezone = body.when.timezone || (await orgTimezone(body.orgId));
        await (injected?.scheduler ?? scheduler()).scheduleRecurring({
          name: scheduleName("series", body.orgId, body.campaignId),
          cron: body.when.cron,
          timezone,
          // Must be a RecurringLaunchPayload, not a bare descriptor: the launch
          // handler's legacy branch hardcodes editionKey "edition", which made
          // every firing compute the SAME campaign id — so the first edition
          // claimed it and every later firing was silently skipped (#162).
          // EventBridge Scheduler substitutes the context attribute below with
          // this firing's scheduled time, and it is stable across retries of
          // that firing, so idempotency still holds.
          payload: {
            descriptor,
            ...(feed ? { feed: { feedId: feed.feedId, url: feed.url, format: feed.format, fieldMap: feed.fieldMap } } : {}),
            editionKey: "<aws.scheduler.scheduled-time>",
          },
        });
        // The recurring PARENT gets a record too, with no `schedule.sendAt` — a
        // recurring series has no single send time, and its cron already lives on
        // the lifecycle record the Schedules view reads. Each launch creates a
        // separate `series_edition` row tied to this parent, so reports can
        // aggregate actual stored counters without guessing from an id prefix.
        //
        // Do NOT stamp `descriptor.seriesId` here. `CampaignSeries` is the
        // separate opt-in registry that owns reusable, series-wide ad fills;
        // this inline recurring campaign has no such row. Stamping its campaign
        // id made the sender require a nonexistent registry record and every
        // ordinary recurring schedule dead-lettered before its first recipient.
        await recordScheduledCampaign(stores(), {
          orgId: body.orgId,
          campaignId: body.campaignId,
          subject: body.subject,
          listId: body.listId,
          segmentId: body.segmentId,
          timezone,
        });
        await markScheduleActive(stores(), clock, {
          orgId: body.orgId,
          scheduleId: body.campaignId,
          kind: "recurring",
          cron: body.when.cron,
          timezone,
        });
        return json(202, { status: "recurring", timezone, scheduleId: body.campaignId });
      }
      default:
        return json(400, { error: "unknown schedule type" });
    }
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /campaigns/lifecycle — start (resume), pause, or archive a scheduled send
 * (§4.6). Never deletes: pause/archive flip the lifecycle record, and the launch
 * handler (recurring) and sender (one-off) gate on it, so a paused series stops
 * its next edition and can be resumed later.
 */
export async function scheduleLifecycleHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const { orgId, scheduleId, action } = JSON.parse(event.body ?? "{}") as {
      orgId: string;
      scheduleId: string;
      action: "start" | "pause" | "archive";
    };
    if (!orgId || !scheduleId) return json(400, { error: "orgId and scheduleId required" });
    if (action !== "start" && action !== "pause" && action !== "archive") {
      return json(400, { error: "action must be start, pause or archive" });
    }
    requireGrant(event, "campaigns:schedule", orgId);
    const state = await transitionSchedule(stores(), clock, { orgId, scheduleId, action });

    // Resuming a one-off that fired while paused re-enqueues it (#179). Without
    // this the parking is pointless: the EventBridge schedule deleted itself
    // when it fired, so nothing else will ever deliver this send.
    const { resumed, ...record } = state as typeof state & { resumed?: SendDescriptor };
    if (resumed) {
      await new SqsSendQueue(env("SEND_QUEUE_URL")).enqueue(resumed);
    }
    return json(200, { ...record, ...(resumed ? { resent: true } : {}) });
  } catch (e) {
    return fail(e);
  }
}

/** GET /orgs/{org}/schedules — lifecycle records for the console's Schedules view. */
export async function schedulesListHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    return json(200, await stores().schedules.list(orgId));
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET/POST /unsubscribe?token=… — RFC 8058 one-click, no login (§4.2).
 *
 * The two methods are NOT the same operation, and conflating them is how an
 * unsubscribe link ends up firing on its own:
 *
 * - **POST** is the machine path. A mailbox provider acting on the
 *   `List-Unsubscribe-Post` header sends it, and it performs the unsubscribe.
 * - **GET** is the human path. The same URL is also the `unsubscribe_url` merge
 *   tag — the visible "Unsubscribe" link in the body of every message — and a
 *   browser click is a GET. The route was POST-only, so that link returned 405
 *   (#234): the header worked and the link everybody actually clicks did not.
 *
 * GET renders a confirm page rather than unsubscribing directly, because mail
 * security scanners and link prefetchers follow GET links. A GET that acted
 * would silently unsubscribe people whose employer runs a URL scanner.
 */
export async function unsubscribeHandler(event: HttpEvent): Promise<HttpResult> {
  const token =
    event.queryStringParameters?.token ??
    new URLSearchParams(event.body ?? "").get("token") ??
    "";
  const method = (event.requestContext?.http?.method ?? "POST").toUpperCase();

  try {
    const { orgId, sub, listId } = (await confirmSigner()).verify(token);
    if (!listId) throw new Error("token has no list");
    if (method === "GET") return unsubscribePage(token);
    const updated = await unsubscribeFromList(stores(), clock, { orgId, subscriberId: sub, listId });
    await publishCustomerSync(updated, "unsubscribed");
    return method === "POST" && !event.queryStringParameters?.token
      ? json(200, { status: "unsubscribed" })
      : unsubscribeDonePage();
  } catch (e) {
    // A retired signing key and an expired token are OUR doing, not the
    // recipient's, and they are not attacks (#234). Saying "invalid link" to
    // someone exercising a legal right, because we rotated a secret, is the
    // outcome the keyring exists to avoid — so these get their own page and,
    // for the machine path, their own status code.
    if (e instanceof RetiredKeyError || e instanceof TokenExpiredError) {
      const why =
        e instanceof RetiredKeyError
          ? "This unsubscribe link was signed with a key this system no longer holds."
          : "This unsubscribe link has expired.";
      return method === "GET"
        ? htmlPage(410, unsubscribeExpiredHtml(why))
        : json(410, { status: "link_expired", error: why });
    }
    return fail(e);
  }
}

const htmlPage = (statusCode: number, body: string): HttpResult => ({
  statusCode,
  headers: {
    "content-type": "text/html; charset=utf-8",
    // Self-contained page, no scripts, no external anything — it is served from
    // the API origin and must not become a place an injected script can run.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // The token is in the URL on the GET. Nothing should cache this.
    "cache-control": "no-store",
  },
  body,
});

const PAGE_STYLE =
  "font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;color:#111";

/** Escape for interpolation into HTML text/attributes. */
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The confirm page. One button, which POSTs the token back.
 *
 * Deliberately a plain form with no JavaScript: this page has to work in the
 * in-app browsers and stripped-down webviews people open mail in, and an
 * unsubscribe that needs JS to run is an unsubscribe that sometimes doesn't.
 */
function unsubscribePage(token: string): HttpResult {
  return htmlPage(
    200,
    `<div style="${PAGE_STYLE}"><h1>Unsubscribe</h1>` +
      `<p>Confirm that you want to stop receiving this newsletter.</p>` +
      `<form method="POST" action=""><input type="hidden" name="token" value="${esc(token)}">` +
      `<button type="submit" style="font:inherit;padding:.6rem 1.2rem;cursor:pointer">Unsubscribe me</button>` +
      `</form></div>`,
  );
}

function unsubscribeDonePage(): HttpResult {
  return htmlPage(
    200,
    `<div style="${PAGE_STYLE}"><h1>Unsubscribed</h1>` +
      `<p>You will not receive this newsletter again. You can close this page.</p></div>`,
  );
}

/**
 * The graceful failure (#234).
 *
 * There is deliberately no "enter your email address" box here. This page is
 * unauthenticated, so a form like that is a mass-unsubscribe tool: anyone could
 * remove any address they can guess. Proving ownership of an address is exactly
 * what the preference centre in #74 is for, and until that exists the honest
 * advice is the one below rather than a convenient hole.
 */
function unsubscribeExpiredHtml(why: string): string {
  return (
    `<div style="${PAGE_STYLE}"><h1>This link no longer works</h1>` +
    `<p>${esc(why)} Nothing has been changed.</p>` +
    `<p>Open a <strong>recent</strong> message from this sender and use the unsubscribe link in it — ` +
    `that one is current. If you have no recent message, replying to any message from the sender and ` +
    `asking to be unsubscribed also works.</p></div>`
  );
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

/**
 * GET /orgs/{org} — lightweight org metadata (name, environment, sending
 * domains) for the console header and Settings.
 *
 * `primaryDomain` is `domains[0]`, the domain provisioning verified as this
 * org's SES identity (`provisioning.ts`: `[...new Set([primaryDomain,
 * siteDomain])]`). It is the one shown under the org name in the console's
 * identity block, so an operator switching between organizations can tell which
 * one they are sending as. Safe here in a way it is not on `GET /orgs`: this
 * route is already scoped to a single org by `requireGrant(…, orgId)`, so the
 * caller is being told a domain they are already entitled to send from, not
 * handed every tenant's domains at once. Absent on an org provisioned with no
 * domain — the console renders the org id instead, never a guess.
 */
export async function orgMetaHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    const org = await stores().organizations.get(orgId);
    if (!org) return json(404, { error: "not found" });
    return json(200, {
      orgId: org.orgId,
      name: org.name,
      environment: org.environment ?? "prod",
      setupComplete: org.setupComplete,
      ...(org.domains?.[0] ? { primaryDomain: org.domains[0] } : {}),
      // The whole list, on the same reasoning that already admits
      // `primaryDomain` above: this route is scoped to one org by
      // `requireGrant(…, orgId)`, and every name here appears in the From
      // header of every message the org sends — the caller is not being told
      // anything a recipient of their mail does not already see. Settings →
      // Domains needs the list, not just the first: provisioning creates an
      // identity per entry (`[...new Set([primaryDomain, siteDomain])]`), and a
      // console that shows one of two makes the second look unprovisioned.
      domains: org.domains ?? [],
      // Whether this org mints magic-link tokens at all. `magicLink` is present
      // if and only if the feature is on (entities.ts), and the flag — never the
      // key ARN or kid — is what Settings needs to say "on for this org" rather
      // than describing a feature the org does not use.
      magicLinkEnabled: org.magicLink !== undefined,
      hourlyEnabled: org.hourlyEnabled === true,
      segmentEngine: process.env.SEGMENT_ENGINE === "opensearch" ? "opensearch" : "gsi",
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/search?q= — bounded, org-scoped shell search. This deliberately
 * searches named operator resources only; subscriber email search remains on the
 * Subscribers screen behind `subscribers:manage` so the global shell does not
 * widen access to personal data.
 */
export async function searchHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    const q = (event.queryStringParameters?.q ?? "").trim().toLowerCase();
    if (q.length < 2) return json(200, { results: [] });
    const [lists, campaigns, series, templates, segments] = await Promise.all([
      stores().lists.list(orgId),
      stores().campaigns.list(orgId),
      stores().series.list(orgId),
      stores().templates.list(orgId),
      stores().segments.list(orgId),
    ]);
    const results = [
      ...lists.filter((x) => `${x.listId} ${x.name}`.toLowerCase().includes(q)).map((x) => ({ kind: "newsletters", id: x.listId, label: x.name })),
      ...campaigns.filter((x) => `${x.campaignId} ${x.subject}`.toLowerCase().includes(q)).map((x) => ({ kind: "campaigns", id: x.campaignId, label: x.subject })),
      ...series.filter((x) => `${x.seriesId} ${x.name}`.toLowerCase().includes(q)).map((x) => ({ kind: "drips", id: x.seriesId, label: x.name })),
      ...templates.filter((x) => `${x.templateId} ${x.name}`.toLowerCase().includes(q)).map((x) => ({ kind: "templates", id: x.templateId, label: x.name })),
      ...segments.filter((x) => `${x.segmentId} ${x.name}`.toLowerCase().includes(q)).map((x) => ({ kind: "segments", id: x.segmentId, label: x.name })),
    ].slice(0, 12);
    return json(200, { results });
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/identity — the org's identity configuration, read-only.
 *
 * Its own route rather than more fields on `GET /orgs/{org}`, because the two
 * answer different questions under different capabilities. `orgMetaHandler` is
 * gated on `reports:view` and its sibling `orgsListHandler` writes down exactly
 * why that gate is safe: it returns "no SES identity, no domains, no
 * configuration — a name, an id, and whether setup is finished". A KMS key ARN
 * and a linked Cognito pool id are configuration, and every analyst in the org
 * holds `reports:view`. Folding them into the header payload would hand the
 * infrastructure layout to the one role that exists to read numbers. So this is
 * `identity:manage`, the capability that provisioned these values in the first
 * place (`POST /orgs`).
 *
 * Read-only on purpose: there is no org-update route. Everything here is written
 * once at provisioning time, and the console says so rather than rendering
 * inputs that cannot be saved.
 *
 * `magicLink` absent is the documented FEATURE-OFF state (see `Organization` in
 * `@addressium/core`), not an error and not a half-provisioned org: no linked
 * pool, no signing key, no JWKS, no token. It is reported as `enabled: false`
 * with no key block, so the console can say "off" instead of showing empty
 * fields that read as a broken silo.
 */
export async function orgIdentityHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "identity:manage", orgId);
    const org = await stores().organizations.get(orgId);
    if (!org) return json(404, { error: "not found" });
    // The JWKS path is built from the org id, never stored: it is one shared
    // route serving every org (`/orgs/{org}/.well-known/jwks.json`), and the
    // console resolves it against the API base it is already calling. Returning
    // a fully-qualified URL from here would bake a hostname into the payload.
    return json(200, {
      orgId: org.orgId,
      subscriberPoolId: org.subscriberPoolId,
      magicLink: org.magicLink
        ? {
            enabled: true,
            kmsKeyArn: org.magicLink.kmsKeyArn,
            kid: org.magicLink.kid,
            issuer: org.magicLink.issuer,
            audience: org.magicLink.audience,
            keyCount: org.magicLink.keys?.length ?? 1,
            rotatedAt: org.magicLink.rotatedAt,
            jwksPath: `/orgs/${encodeURIComponent(org.orgId)}/.well-known/jwks.json`,
          }
        : { enabled: false },
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/sending-identity — can this org actually send? (#285)
 *
 * The only route in the console that asks SES rather than our own table. Every
 * other identity readout answers "a domain is on the org record"; this one
 * answers the two questions that decide whether a message is accepted: has the
 * DOMAIN identity verified, and does the ACCOUNT have production access — i.e.
 * has it left the SES sandbox, where it may only mail addresses it has itself
 * verified.
 *
 * That second question is why this exists. A subscriber typed a valid address,
 * SES refused it because the account was still in the sandbox, and the refusal
 * surfaced on the public signup page; from the console there was no way to see
 * the cause. The readout makes it visible in one place.
 *
 * `identity:manage`, matching `orgIdentityHandler` and for the same reason: this
 * is configuration, not a metric. Quota and enforcement status describe the
 * whole deployment's SES account, not this org's numbers, and `reports:view` —
 * which every analyst holds — is the wrong audience for it.
 *
 * A live read on every request, deliberately uncached. The single fact this
 * route exists to deliver is one that CHANGES — a domain verifies, an account
 * leaves the sandbox — and a cached "still pending" is exactly the answer that
 * sends an operator to debug DNS that is already correct.
 *
 * **Not here: DMARC.** `GetEmailIdentity` reports DKIM and the custom MAIL FROM
 * (the SPF-alignment leg) and nothing else; `_dmarc` is a TXT record on the
 * operator's own zone that SES never reads back. Answering for it would mean
 * resolving DNS from this Lambda — a different capability with a different
 * failure surface — and it is deliberately not built. A console column for
 * DMARC would have nothing behind it.
 *
 * `injected` is for tests only, following `importSuppressionHandler`: the
 * degraded branches this route exists to render correctly — a missing SES grant,
 * a throttle — cannot be exercised against real SES.
 */
export async function sendingIdentityHandler(
  event: HttpEvent,
  injected?: { reader?: SesIdentityReader },
): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "identity:manage", orgId);
    const org = await stores().organizations.get(orgId);
    if (!org) return json(404, { error: "not found" });
    return json(
      200,
      await readSendingIdentity(
        injected?.reader ?? sesIdentityReader(),
        orgId,
        org.domains ?? [],
      ),
    );
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs — the organizations this caller may act on, for the console's org
 * switcher (#6 design reference).
 *
 * Scoped by the caller's own grant rather than by a separate capability. The
 * console cannot offer a switcher without knowing what to switch between, and
 * the alternative — gating on `identity:manage` like POST /orgs — would mean an
 * admin scoped to one organization could not populate a list containing only
 * that organization. `custom:orgs` already answers "which orgs is this person
 * for", so it answers this too: "*" sees every org, a scoped grant sees its own,
 * and an empty claim sees none (grantFromClaims denies by default).
 *
 * `reports:view` is the capability because this returns only what the console
 * header already shows for a single org. No SES identity, no domains, no
 * configuration — a name, an id, and whether setup is finished.
 */
export async function orgsListHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
    const grant = grantFromClaims(claims);
    const all = await stores().organizations.list();
    // Filter to the grant BEFORE returning, not in the console: a client-side
    // filter still ships every org name over the wire.
    const visible =
      grant.orgs === "*" ? all : all.filter((o) => (grant.orgs as string[]).includes(o.orgId));
    return json(200, {
      orgs: visible
        .map((o) => ({
          orgId: o.orgId,
          name: o.name,
          environment: o.environment ?? "prod",
          setupComplete: o.setupComplete ?? false,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /version — what is actually deployed.
 *
 * Public and unauthenticated by design: it reports only the release and schema
 * version, never configuration or secrets. An operator needs to answer "did my
 * upgrade land?" without reading CloudFormation, and the upgrade rehearsal
 * (#213) asserts on it before and after a deploy.
 *
 * `deployed` is the marker last written to the table; `running` is the version
 * of the code answering this request. They differ mid-deploy, and a persistent
 * mismatch means the marker write failed — which is worth seeing.
 */
export async function versionHandler(): Promise<HttpResult> {
  try {
    const deployed = await stores().version.get();
    return json(200, {
      running: APP_VERSION,
      expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
      deployed: deployed ?? null,
      // Surfaces a half-applied upgrade rather than hiding it behind a 200.
      inSync: deployed?.version === APP_VERSION,
    });
  } catch (e) {
    return fail(e);
  }
}

/** GET /orgs/{org}/setup — onboarding checklist state for the setup wizard (§9). */
export async function setupStateHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    return json(200, await evaluateSetup(stores(), orgId));
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

/**
 * GET /orgs/{org}/campaigns — recent campaigns for the console's report picker
 * (#103). Returns a lightweight projection (no full template bodies), newest by
 * campaignId first, so operators don't have to remember raw ids.
 */
export async function campaignsListHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    const campaigns = await stores().campaigns.list(orgId);
    const rows = campaigns
      .map((c) => ({
        campaignId: c.campaignId,
        subject: c.subject,
        status: c.status,
        type: c.type,
        listId: c.audience.listId,
        segmentId: c.audience.segmentId,
        sent: c.counters.sent,
        sendAt: c.schedule?.sendAt,
      }))
      .sort((a, b) => b.campaignId.localeCompare(a.campaignId));
    return json(200, rows);
  } catch (e) {
    return fail(e);
  }
}

/** GET /orgs/{org}/templates — list. GET …/templates/{id} — one. POST /templates — save. */
export async function templatesHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "POST") {
      const input = schemas.saveTemplateSchema.parse(JSON.parse(event.body ?? "{}"));
      requireGrant(event, "campaigns:manage", input.orgId);
      // Raw-HTML templates are hard-sanitized at save; MJML source is stored as-is.
      const toSave = input.mode === "raw_html"
        ? { ...input, source: sanitizeEmailHtml(input.source) }
        : input;
      return json(200, await saveTemplate(stores(), toSave));
    }
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    const templateId = event.pathParameters?.id;
    if (templateId) {
      const t = await stores().templates.get(orgId, templateId);
      return t ? json(200, t) : json(404, { error: "not found" });
    }
    return json(200, await stores().templates.list(orgId));
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/merge-tags — the registry. POST /merge-tags — register one.
 * POST /merge-tags/delete — remove an org-defined one.
 *
 * The GET returns reserved tags merged with the org's own, reserved first and
 * flagged, so the console renders precedence that was decided here rather than
 * re-derived in a component. `saveMergeTag` refuses a reserved name with an
 * `InvalidInputError`, which `fail()` answers as a 400 carrying that sentence —
 * the operator needs to read WHICH name and why (#265).
 */
export async function mergeTagsHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "POST") {
      const input = schemas.saveMergeTagSchema.parse(JSON.parse(event.body ?? "{}"));
      requireGrant(event, "campaigns:manage", input.orgId);
      return json(200, await saveMergeTag(stores(), input));
    }
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    return json(200, await listMergeTags(stores(), orgId));
  } catch (e) {
    return fail(e);
  }
}

/** POST /merge-tags/delete — remove one org-defined merge tag. */
export async function mergeTagDeleteHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const input = schemas.deleteMergeTagSchema.parse(JSON.parse(event.body ?? "{}"));
    requireGrant(event, "campaigns:manage", input.orgId);
    await deleteMergeTag(stores(), input.orgId, input.name);
    return json(200, { deleted: input.name });
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/api-keys — the org's keys, revoked ones included and flagged.
 * POST /api-keys — issue one. The ONLY response in the product that carries a
 * plaintext key, and it carries it once.
 *
 * Both halves are `apikeys:manage`, INCLUDING the read. Every other registry
 * here gates its GET on `reports:view` so an analyst can see what exists; a
 * credential list is different in kind. It names each integration, what it may
 * do and when it last did it, which is a map of the org's machine access — and
 * `apikeys:manage` is the capability that already means "this person is trusted
 * with the org's credentials". Nothing about a key is a report.
 *
 * `createdBy` is the caller's admin-pool `sub`, taken from the verified JWT
 * claims rather than from the body: a field saying who issued a credential is
 * worth nothing if the issuer can write it.
 */
export async function apiKeysHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "POST") {
      const input = schemas.issueApiKeySchema.parse(JSON.parse(event.body ?? "{}"));
      requireGrant(event, "apikeys:manage", input.orgId);
      const createdBy = event.requestContext?.authorizer?.jwt?.claims?.["sub"];
      return json(200, await issueApiKey(stores(), clock, input, createdBy));
    }
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "apikeys:manage", orgId);
    return json(200, await listApiKeys(stores(), orgId));
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /api-keys/revoke — cut off one key.
 *
 * Revocation keeps the row and stamps `revokedAt` (see `api-keys.ts`), so this
 * is a POST rather than a DELETE: nothing is removed. Revoking an
 * already-revoked key is an `InvalidInputError` naming the date, because an
 * operator reaching for this during an incident needs to know whether they are
 * the one who cut it off.
 */
export async function apiKeyRevokeHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const input = schemas.revokeApiKeySchema.parse(JSON.parse(event.body ?? "{}"));
    requireGrant(event, "apikeys:manage", input.orgId);
    return json(200, await revokeApiKey(stores(), clock, input.orgId, input.keyId));
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /api-keys/verify — check a key the operator holds, and record the use.
 *
 * ADMIN-GATED ON PURPOSE. This is the one route that turns a plaintext key into
 * a yes/no, which on the public surface would be an oracle anyone could grind
 * candidate keys against. Behind the JWT authorizer and `apikeys:manage`, every
 * caller already has full console access to the org, so there is nothing here to
 * learn that the list does not already show — and it answers the question an
 * operator actually has: *is the key in our CI the live one, or the one we
 * revoked?*
 *
 * It is also what makes "Last used" a fact. `authenticateApiKey` is the only
 * writer of `lastUsedAt` in the product, this is its only HTTP entry point, and
 * a key that has never been through here reads "Never" truthfully.
 *
 * The org is passed to the domain rather than compared after the fact: the stamp
 * is written inside `authenticateApiKey`, so a handler-side check would run
 * after another tenant's credential had already been touched. A key belonging to
 * a different org is refused exactly like an unknown one — same sentence, no
 * stamp.
 */
export async function apiKeyVerifyHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const body = JSON.parse(event.body ?? "{}") as { orgId?: unknown; key?: unknown };
    const orgId = schemas.idSchema.parse(body.orgId);
    requireGrant(event, "apikeys:manage", orgId);
    const key = typeof body.key === "string" ? body.key : "";
    return json(200, await authenticateApiKey(stores(), clock, key, { orgId }));
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/series — list. GET …/series/{id} — one. POST /series — save.
 *
 * Reads are gated on `reports:view`, while writes require `campaigns:manage`.
 * A series IS a campaign construct — it is the parent of every
 * `series_edition` — and writing one sets the template and the ad HTML that
 * every future edition will carry, which is the same authority as editing a
 * campaign. There is deliberately no delete: editions and series-bound ad
 * fills reference a series by id, so removing the parent would orphan them
 * (same reasoning as send schedules, which are never deleted either, §4.6).
 */
export async function seriesHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "POST") {
      const input = schemas.saveCampaignSeriesSchema.parse(JSON.parse(event.body ?? "{}"));
      requireGrant(event, "campaigns:manage", input.orgId);
      return json(200, await saveCampaignSeries(stores(), input));
    }
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    const seriesId = event.pathParameters?.id;
    if (seriesId) {
      const s = await getCampaignSeries(stores(), orgId, seriesId);
      return s ? json(200, s) : json(404, { error: "not found" });
    }
    return json(200, await listCampaignSeries(stores(), orgId));
  } catch (e) {
    return fail(e);
  }
}

/** GET /orgs/{org}/feeds — list. POST /feeds — create/edit one feed. */
export async function feedsHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "POST") {
      const input = schemas.saveFeedSchema.parse(JSON.parse(event.body ?? "{}"));
      requireGrant(event, "campaigns:manage", input.orgId);
      const list = await stores().lists.get(input.orgId, input.targetListId);
      if (!list) return json(400, { error: `newsletter "${input.targetListId}" does not exist` });
      const feed = {
        orgId: input.orgId,
        feedId: input.feedId,
        url: input.url,
        format: input.format,
        targetListId: input.targetListId,
        fieldMap: input.fieldMap,
        pullIntervalMins: input.pullIntervalMins,
      };
      await stores().feeds.put(feed);
      await audit(event, input.orgId, "feed.update", input.feedId);
      return json(200, feed);
    }
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "campaigns:manage", orgId);
    return json(200, await stores().feeds.list(orgId));
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
      // Refuse a predicate THIS deployment's engine cannot resolve (#246).
      //
      // The schema accepts engagement recency and base-list-free predicates, and
      // the console's builder offers them, but the v1 GSI engine throws on both.
      // Without this the operator finds out at SEND time — from a campaign that
      // has already claimed itself — for a segment the product let them save.
      // The OpenSearch mirror lifts both limits, so the answer depends on which
      // engine is actually deployed; `SEGMENT_ENGINE` says which.
      if (process.env.SEGMENT_ENGINE !== "opensearch") {
        const limitation = gsiEngineLimitation(input.predicate as SegmentPredicate);
        if (limitation) {
          return json(400, {
            error: limitation,
            // Named, because the fix is an operator decision rather than a
            // rewrite of the segment: this deployment can support the predicate
            // as written, with a flag it is not currently running.
            hint: "deploy with -c enableOpenSearchMirror=true to use this predicate, or add a `list in <listId>` condition",
          });
        }
      }
      return json(200, await saveSegment(stores(), input));
    }
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    return json(200, await stores().segments.list(orgId));
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/segments/{segment}/members — the explicit cohort (#203).
 * POST /segments/members — add or remove one address.
 *
 * Reading the cohort is `segments:manage`, not `reports:view`: the response is a
 * list of subscriber email addresses, so it is a subscriber read wearing a
 * segment's name. An analyst who can see segment DEFINITIONS should not get a
 * roster of addresses out of the same screen.
 */
export async function segmentMembersHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "POST") {
      const input = schemas.segmentMemberSchema.parse(JSON.parse(event.body ?? "{}"));
      requireGrant(event, "segments:manage", input.orgId);
      const result = await updateSegmentMembership(stores(), input);
      // Audited (#191): changing who a test send reaches is a change to who gets
      // mailed, and the whole point of the cohort is that it is hand-edited.
      await audit(event, input.orgId, `segment.member.${input.action}`, `${input.segmentId}:${input.email}`);
      return json(200, result.members);
    }
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "segments:manage", orgId);
    return json(200, await listSegmentMembers(stores(), orgId, event.pathParameters?.segment ?? ""));
  } catch (e) {
    return fail(e);
  }
}

/** GET /orgs/{org}/drip-sequences — list. POST /drip-sequences — create/edit (#104). */
export async function dripSequencesHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "POST") {
      const input = schemas.saveDripSequenceSchema.parse(JSON.parse(event.body ?? "{}"));
      requireGrant(event, "campaigns:manage", input.orgId);
      return json(200, await saveDripSequence(stores(), input));
    }
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    return json(200, await stores().dripSequences.list(orgId));
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /drip-sequences/enroll — hand-enroll one subscriber (admin, §4.6, #245).
 *
 * The operator half of enrollment, for `trigger.kind === "manual"` sequences.
 * `campaigns:manage` because enrolling somebody starts a sequence of real sends
 * to them: it is the same authority as sending a campaign, and strictly more than
 * `campaigns:schedule` (which moves send times for sends already authored).
 * There is no drip-specific capability in the vocabulary and inventing one here
 * would mean a permission no Cedar policy grants to any role.
 *
 * NOT best-effort, unlike the confirmation path: an operator who clicks "Enroll"
 * is owed an answer, so an unknown sequence or a signup-triggered one is a 400
 * rather than a silent log line.
 *
 * `injected` is for tests, exactly as on `confirmHandler`: this route starts real
 * sends to a subscriber on operator command with no double opt-in in front of it,
 * so its authorization check and its 400s are worth driving through the handler
 * itself rather than through the domain function underneath.
 */
export async function dripEnrollHandler(
  event: HttpEvent,
  injected?: { starter?: DripStarter },
): Promise<HttpResult> {
  try {
    const input = schemas.enrollDripSequenceSchema.parse(JSON.parse(event.body ?? "{}"));
    requireGrant(event, "campaigns:manage", input.orgId);
    const enrollment = await enrollManually(stores(), injected?.starter ?? dripStarter(), {
      orgId: input.orgId,
      sequenceId: input.sequenceId,
      subscriberId: input.subscriberId,
      // Absent, each click is its own enrollment — see enrollDripSequenceSchema.
      enrollmentId: input.enrollmentId ?? `manual.${clock.now().toISOString()}`,
    });
    await audit(event, input.orgId, "drip.enroll", `${input.sequenceId}/${input.subscriberId}`);
    return json(200, enrollment);
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /subscribers/suppress — manual suppression, one address (#102, #247).
 *
 * `subscribers:manage` — matching "Manually unsubscribe someone" / "Manage
 * individual subscribers" in the role matrix (Developer Admin, Editor,
 * Support), not the `suppression:manage` this route used before #247. That was
 * the more restrictive tier this repo defaults to for suppression writes, but a
 * front-line operator handling ONE subscriber's reported bounce or complaint
 * needs to be able to act on it without a dev-admin escalation, and the blast
 * radius is the same either way: `recordBounce`/`recordComplaint` already write
 * identically-scoped GLOBAL entries with NO role gate at all, triggered purely
 * by an SES notification. A human recording the same fact behind an
 * authenticated, audited console action is not riskier than that.
 *
 * `manualSuppress` derives the entry's SCOPE from `source` — bounce/complaint
 * land GLOBAL, matching the automatic path; a bare "manual" suppression stays
 * ORG-scoped, as this route always behaved before `source` existed. Only a
 * global entry has a live SES counterpart, so the mirror write below fires
 * exactly when SES's own `SuppressionListReason` would have accepted it.
 */
export async function subscriberSuppressHandler(
  event: HttpEvent,
  injected?: { checker?: SuppressionChecker },
): Promise<HttpResult> {
  try {
    const input = schemas.manualSuppressSchema.parse(JSON.parse(event.body ?? "{}"));
    requireGrant(event, "subscribers:manage", input.orgId);
    const detail = await manualSuppress(stores(), clock, input);
    if (detail.scope === "global") {
      // Mirrors the write to the REAL SES account list, so `aws sesv2
      // get-suppressed-destination` reflects it immediately rather than only
      // our own copy. Best-effort: the local entry is what our own send path
      // actually gates on (`mayMail`), so a throttled or unreachable SES call
      // must not undo — or even fail — a suppression that already succeeded
      // where it matters. Swallowed and logged, same posture as every other
      // best-effort mirror call in this file.
      try {
        await (injected?.checker ?? suppressionChecker()).put(
          input.email,
          detail.source.toUpperCase() as "BOUNCE" | "COMPLAINT",
        );
      } catch (e) {
        console.error("subscriber-suppress: SES mirror write failed", {
          orgId: input.orgId,
          error: (e as Error).message,
        });
      }
    }
    await audit(event, input.orgId, "suppression.suppress", `${input.email} (${detail.source})`);
    return json(200, detail);
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/suppression/check?email=… — one address, both sources of
 * truth (#247). The console equivalent of `aws sesv2 get-suppressed-destination`,
 * plus what our own send path actually consults.
 *
 * `subscribers:manage`: this is what a subscriber-detail view calls on load, so
 * it needs the same access as viewing the subscriber itself — Developer Admin,
 * Editor, Support. It is read-only, so there is no blast-radius argument for
 * gating it any tighter than that.
 */
export async function suppressionCheckHandler(
  event: HttpEvent,
  injected?: { checker?: SuppressionChecker },
): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const email = event.queryStringParameters?.email;
    if (!email) return json(400, { error: "email required" });
    return json(200, await checkSuppression(stores(), injected?.checker ?? suppressionChecker(), orgId, email));
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/subscribers — subscriber lookup/list for the admin console
 * (#102). Optional `?q=` filters by email substring. Returns a projection (no
 * raw attributes bag) so the table stays light. Paginated at the adapter layer.
 */
export async function subscribersListHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    // One PAGE (#182). This used to load every subscriber in the org and filter
    // by substring in Node: for a 500k-subscriber org, hundreds of megabytes
    // across hundreds of sequential queries, triggered by typing in a search
    // box. The prefix search is served as a key condition by the email index, so
    // the read is proportional to the matches.
    const q = (event.queryStringParameters?.q ?? "").trim().toLowerCase();
    const limit = Number(event.queryStringParameters?.limit ?? 50);
    const page = await stores().subscribers.page(orgId, {
      limit: Number.isFinite(limit) ? limit : 50,
      ...(q ? { emailPrefix: q } : {}),
      ...(event.queryStringParameters?.cursor ? { cursor: event.queryStringParameters.cursor } : {}),
    });
    const rows = page.items.map((s) => ({
      sub: s.sub,
      email: s.email,
      status: s.status,
      entitlement: s.entitlement,
      lastEngagedAt: s.lastEngagedAt,
    }));
    // An OBJECT, not a bare array. The old shape had no room for a cursor, and a
    // paginated endpoint whose response cannot say "there is more" is one that
    // silently truncates.
    return json(200, { rows, ...(page.cursor ? { cursor: page.cursor } : {}) });
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/subscribers/{sub} — the full record (#205).
 *
 * The row in the list view carries five fields; this carries the attributes that
 * drive every personalised send, the per-list subscription status, and the
 * explicit segments naming this person. Without it, test setup and support both
 * needed direct DynamoDB access.
 */
export async function subscriberDetailHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    return json(200, await subscriberDetail(stores(), orgId, event.pathParameters?.sub ?? ""));
  } catch (e) {
    return fail(e);
  }
}

/** GET /orgs/{org}/subscribers/{sub}/timeline — recent engagement events. */
export async function subscriberTimelineHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    return json(200, await subscriberTimeline(stores(), orgId, event.pathParameters?.sub ?? ""));
  } catch (e) {
    return fail(e);
  }
}

/** POST /subscribers/attributes — replace the merge-tag values (#205). */
export async function subscriberAttributesHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const input = schemas.setSubscriberAttributesSchema.parse(JSON.parse(event.body ?? "{}"));
    requireGrant(event, "subscribers:manage", input.orgId);
    const detail = await setSubscriberAttributes(stores(), input);
    // Audited (#191): attributes are what a recipient sees in their own copy of
    // the email, so changing them changes what was said to whom.
    await audit(event, input.orgId, "subscriber.attributes.set", input.sub);
    return json(200, detail);
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /subscribers/subscription — set one list's opt-in status (#205).
 *
 * Manually setting `confirmed` bypasses double opt-in, so it demands an explicit
 * acknowledgement (checked again in the domain — a flag only the client enforces
 * is not a safeguard) and is audited under its own action name, so "who
 * hand-confirmed this address?" is answerable from the WORM log rather than
 * inferred from a generic subscription-changed entry.
 */
export async function subscriptionStatusHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const input = schemas.setSubscriptionStatusSchema.parse(JSON.parse(event.body ?? "{}"));
    requireGrant(event, "subscribers:manage", input.orgId);
    const detail = await setSubscriptionStatus(stores(), clock, {
      ...input,
      // From the verified JWT, never the body — the consent record names who did
      // this, and a self-reported actor is not evidence of anything.
      actor: actor(event),
    });
    await audit(
      event,
      input.orgId,
      input.status === "confirmed" ? "subscription.manual_confirm" : `subscription.${input.status}`,
      `${input.sub}:${input.listId}`,
    );
    if (input.status === "confirmed" || input.status === "unsubscribed") {
      const updated = await stores().subscriptions.get(input.orgId, input.sub, input.listId);
      if (updated) await publishCustomerSync(updated, input.status === "confirmed" ? "subscribed" : "unsubscribed");
    }
    return json(200, detail);
  } catch (e) {
    return fail(e);
  }
}

/** GET /orgs/{org}/suppressions — org-scoped suppression list for review (#102). */
export async function suppressionsListHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "suppression:manage", orgId);
    return json(200, await stores().suppression.list(orgId));
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /subscribers/unsuppress — lift an org suppression + reactivate (#102,
 * #247).
 *
 * `subscribers:manage`, symmetric with the widened suppress route above: an
 * operator who can suppress someone should be able to undo their own mistake
 * without dev-admin escalation. Safe at this access level for the same reason
 * it was safe before #247 widened the write side — `liftSuppression` only ever
 * removes an ORG-scoped entry (see its own comment: global bounce/complaint
 * entries are deliberately not touched here), so Editor/Support can never use
 * this to erase the account-wide signal a real bounce or complaint left behind.
 */
export async function subscriberUnsuppressHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const { orgId, email } = JSON.parse(event.body ?? "{}") as { orgId?: string; email?: string };
    if (!orgId || !email) return json(400, { error: "orgId and email required" });
    requireGrant(event, "subscribers:manage", orgId);
    const detail = await liftSuppression(stores(), { orgId, email });
    await audit(event, orgId, "suppression.unsuppress", email);
    return json(200, detail);
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /orgs/{org}/import — CSV/Pinpoint subscriber migration (#100). Accepts a
 * CSV body (header + rows); `dryRun` reports counts without writing. Imported
 * subscribers default to `pending` (not double-opt-in confirmed) unless the
 * caller sets status; suppressed addresses are skipped by the domain importer.
 */
/**
 * Audit sink (#191). The WORM bucket has been provisioned, alarmed and
 * correctly moded since day one, and nothing has ever written an object to it —
 * `recordAudit` had zero non-test callers, so every "sensitive actions are
 * audited" claim in the docs rested on a function nobody called.
 */
let _audit: S3AuditLog | undefined;
const auditLog = () => (_audit ??= new S3AuditLog(env("AUDIT_BUCKET")));

/** Who is acting, from the verified JWT — never from the request body. */
function actor(event: HttpEvent): string {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  return claims["sub"] ?? claims["cognito:username"] ?? "unknown";
}

/**
 * Record a privileged action. Deliberately best-effort: an audit write that
 * fails must not roll back an action the operator already completed, and
 * throwing here would turn a logging outage into an outage of the product. The
 * failure is logged loudly instead — a silent audit gap is the thing worth
 * being noisy about.
 */
async function audit(
  event: HttpEvent,
  orgId: string | null,
  action: string,
  target?: string,
): Promise<void> {
  try {
    await recordAudit(auditLog(), clock, {
      orgId,
      memberSub: actor(event),
      action,
      ...(target ? { target } : {}),
    });
  } catch (e) {
    console.error("audit: append failed", { action, orgId, target, error: (e as Error).message });
  }
}

/**
 * GET /orgs/{org}/audit — read the WORM log (#191).
 *
 * Gated on `team:manage`, the developer-admin-only capability. "Who exported
 * subscriber data on the 14th?" is the same administrative surface as "who can
 * reach this system", and the log names members and their actions — an analyst
 * with `reports:view` has no business reading it.
 *
 * `org=GLOBAL` reads the cross-org scope (org creation, pool linking). It is a
 * separate scope rather than "every org": an entry belongs to exactly one, and
 * merging them would let an operator scoped to one org read deployment-wide
 * actions. The `team:manage` check still runs against the caller's own orgs, so
 * reaching GLOBAL requires the wildcard-free admin grant.
 */
export async function auditReadHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const scope = event.pathParameters?.org ?? "";
    requireGrant(event, "team:manage", scope);
    const q = event.queryStringParameters ?? {};
    const entries = await auditLog().read(scope === "GLOBAL" ? null : scope, {
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    });
    // Deliberately NOT audited. Reading the log is not a privileged mutation,
    // and an entry per view would bury the actions the log exists to record
    // under the noise of people looking at it.
    return json(200, entries);
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/health — one derived OK/degraded value (#229, compendium #29).
 *
 * Composed SERVER-side. Putting `cloudwatch:DescribeAlarms` in the browser
 * would hand a marketing console a read view of the whole account's alarm
 * state, which is the opposite of the split #29 draws — and the console is
 * shown a verdict, never raw alarm names.
 */
export async function healthHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "reports:view", orgId);
    const report = await new CloudWatchHealth(env("ALARM_PREFIX")).check();
    return json(200, { ...report, checkedAt: clock.now().toISOString() });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Admin team management (#226) — GET/POST /team.
 *
 * Gated on `team:manage`, which only `developer_admin` holds. Scoped to the
 * caller's own org for the authorization check, but the underlying pool is
 * deployment-wide: an admin manages the deployment's members, not one org's.
 */
function directory(): CognitoAdminDirectory {
  return new CognitoAdminDirectory(env("ADMIN_POOL_ID"));
}

export async function teamHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "GET") {
      const orgId = event.pathParameters?.org ?? event.queryStringParameters?.orgId ?? "";
      requireGrant(event, "team:manage", orgId);
      const members = await listTeam(directory());
      return json(200, members.map((m) => ({ ...m, capabilities: capabilitiesOf(m.role) })));
    }

    const body = JSON.parse(event.body ?? "{}") as {
      orgId?: string;
      action?: "invite" | "access" | "enable" | "disable";
      email?: string;
      username?: string;
      role?: string;
      orgs?: string[];
    };
    if (!body.orgId) return json(400, { error: "orgId required" });
    requireGrant(event, "team:manage", body.orgId);

    switch (body.action) {
      case "invite": {
        const m = await inviteMember(directory(), {
          email: body.email ?? "",
          role: body.role ?? "",
          orgs: body.orgs ?? [],
        });
        await audit(event, body.orgId, "team.invite", `${m.email} as ${m.role}`);
        return json(200, m);
      }
      case "access": {
        if (!body.username) return json(400, { error: "username required" });
        const m = await setMemberAccess(directory(), body.username, {
          role: body.role ?? "",
          orgs: body.orgs ?? [],
        });
        await audit(event, body.orgId, "team.access", `${m.email} → ${m.role} [${m.orgs.join(",")}]`);
        return json(200, m);
      }
      case "enable":
      case "disable":
        if (!body.username) return json(400, { error: "username required" });
        await setMemberEnabled(directory(), body.username, body.action === "enable");
        await audit(event, body.orgId, `team.${body.action}`, body.username);
        return json(200, { ok: true });
      default:
        return json(400, { error: "unknown action" });
    }
  } catch (e) {
    // TeamError carries the operator-facing reason — "this is the last enabled
    // developer admin" needs to reach the console, not become a generic 400.
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/export?format=csv|jsonl — bulk portability (#224).
 *
 * Distinct from `POST /privacy` (one subject, GDPR DSAR). This is the whole
 * org, and it is deliberately the shape the mapper (#216) can re-import, so
 * "you can leave" is a round trip rather than a download.
 */
export async function exportHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    // Taking the entire subscriber base out of the system is a privileged act,
    // so it sits behind the destructive-tier capability rather than read-only.
    requireGrant(event, "subscribers:delete", orgId);
    const format = event.queryStringParameters?.format === "jsonl" ? "jsonl" : "csv";
    const listId = event.queryStringParameters?.listId;
    const includeUnsubscribed = event.queryStringParameters?.includeUnsubscribed === "true";
    const opts = { orgId, ...(listId ? { listId } : {}), ...(includeUnsubscribed ? { includeUnsubscribed } : {}) };

    // Streamed to S3, never returned inline (#224, #182). API Gateway caps a
    // response at 6MB, so returning the file made the export fail for precisely
    // the org large enough to want one — and it had to be whole in Lambda memory
    // to be returned at all. The response is a pointer now.
    const chunks =
      format === "jsonl" ? exportJsonlChunks(stores(), opts) : exportCsvChunks(stores(), opts);
    const upload = await exportWriter().write(orgId, format, chunks, clock.now());

    // Taking an entire subscriber base out of the system is the single most
    // sensitive read this product offers. Audited AFTER the write so the entry
    // names the object that actually exists.
    await audit(
      event,
      orgId,
      "subscribers.export",
      `${format}${listId ? ` list=${listId}` : ""} key=${upload.key} bytes=${upload.bytes}`,
    );
    return json(200, {
      format,
      bytes: upload.bytes,
      // A bearer credential for the whole file. Short-lived by design, and the
      // object behind it is expired by the bucket regardless.
      url: upload.url,
      expiresAt: upload.expiresAt,
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /orgs/{org}/import/preview — headers, sample rows and a suggested
 * mapping (#216). Writes NOTHING: the console renders this so the operator can
 * see what the file actually contains before committing to it.
 */
/**
 * The uploaded file, as bytes when it needs to be and text when it does not
 * (#239).
 *
 * A Pinpoint export job writes GZIPPED JSON Lines, and gzip is not text — it
 * cannot survive a JSON string body. So callers may send `fileBase64` instead of
 * `csv`, and the domain sniffs gzip by magic bytes from there. `csv` stays for
 * the paste-a-spreadsheet path, which is most of them.
 */
/**
 * Where the inline import stops and the job takes over (#242).
 *
 * Well under API Gateway's 10 MB so the refusal is OURS, with a message naming
 * the async route — a 10MB-shaped failure from the gateway is an opaque 413 that
 * tells the operator nothing about what to do instead.
 */
const INLINE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

function uploadedFile(body: { csv?: string; fileBase64?: string }): Uint8Array | string | undefined {
  if (typeof body.fileBase64 === "string" && body.fileBase64.length > 0) {
    return new Uint8Array(Buffer.from(body.fileBase64, "base64"));
  }
  if (typeof body.csv === "string" && body.csv.trim() !== "") return body.csv;
  return undefined;
}

export async function importPreviewHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const body = JSON.parse(event.body ?? "{}") as {
      csv?: string;
      fileBase64?: string;
      consentBasis?: "explicit" | "implicit";
    };
    const file = uploadedFile(body);
    if (file === undefined) return json(400, { error: "csv or fileBase64 required" });

    const preview = previewCsv(file);
    // A file we cannot read is a 400 naming both shapes, not an empty preview
    // the operator has to interpret — and never a 200 (#209, #239).
    if (preview.headers.length === 0) {
      return json(400, {
        error: "could not read the file: expected a CSV with a header row, or JSON Lines of endpoint objects (gzip supported via fileBase64)",
      });
    }

    // Bind suggestions to what this org already has, so a column maps to an
    // existing list or attribute rather than proposing a duplicate.
    const lists = await stores().lists.list(orgId);
    const plan = suggestMapping(preview, {
      knownLists: lists.map((l) => ({ listId: l.listId, name: l.name })),
      ...(body.consentBasis ? { consentBasis: body.consentBasis } : {}),
    });
    // Offer any mapping already saved against this header set (#216). A
    // 73-column export remapped by hand every month is how one column ends up
    // wrong; matching is order-insensitive so a reshuffled re-export still hits.
    const saved = await stores().importMappings.findByFingerprint(orgId, preview.fingerprint);
    return json(200, {
      headers: preview.headers,
      sample: preview.sample,
      rowCount: preview.rowCount,
      fingerprint: preview.fingerprint,
      suggested: plan,
      saved,
      problems: validateMapping(plan, preview.headers),
    });
  } catch (e) {
    return fail(e);
  }
}

/** GET/POST /orgs/{org}/import/mappings — saved column mappings (#216). */
export async function importMappingsHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "GET") return json(200, await stores().importMappings.list(orgId));

    const body = JSON.parse(event.body ?? "{}") as {
      mappingId?: string;
      name?: string;
      fingerprint?: string;
      plan?: unknown;
      remove?: boolean;
    };
    if (body.remove) {
      if (!body.mappingId) return json(400, { error: "mappingId required" });
      await stores().importMappings.remove(orgId, body.mappingId);
      return json(200, { ok: true });
    }
    if (!body.name?.trim() || !body.fingerprint || !body.plan) {
      return json(400, { error: "name, fingerprint and plan required" });
    }
    const mapping = {
      orgId,
      mappingId: body.mappingId ?? `map_${clock.now().getTime()}`,
      name: body.name.trim(),
      fingerprint: body.fingerprint,
      plan: body.plan,
      updatedAt: clock.now().toISOString(),
    };
    await stores().importMappings.put(mapping);
    await audit(event, orgId, "import.mapping.save", mapping.name);
    return json(200, mapping);
  } catch (e) {
    return fail(e);
  }
}

/** POST /orgs/{org}/import/mapped — run an import through an operator-confirmed mapping (#216). */
export async function importMappedHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const body = JSON.parse(event.body ?? "{}") as {
      csv?: string;
      fileBase64?: string;
      plan?: MappingPlan;
      status?: "confirmed" | "pending";
      batchId?: string;
      sourceFile?: string;
      newListDefaults?: NewListDefaults;
      dryRun?: boolean;
    };
    const file = uploadedFile(body);
    if (file === undefined || !body.plan?.columns) {
      return json(400, { error: "csv (or fileBase64) and plan required" });
    }
    // The inline path is for pastes and small files ONLY (#242). Above this it
    // is racing API Gateway's 10 MB payload limit and a 29-second integration
    // timeout, and losing that race leaves a half-imported list with no
    // resumption point — so refuse it here, naming the route that can, rather
    // than accepting work that will be cut off mid-write.
    const size = typeof file === "string" ? Buffer.byteLength(file, "utf8") : file.byteLength;
    if (size > INLINE_IMPORT_MAX_BYTES) {
      return json(413, {
        error: `file is ${Math.round(size / 1024)}KB; the inline import is capped at ${INLINE_IMPORT_MAX_BYTES / 1024}KB`,
        hint: "use POST /orgs/{org}/import/upload-url then POST /orgs/{org}/import/async",
      });
    }
    // Asking for `confirmed` against anything but an explicit basis is refused
    // here rather than quietly downgraded (#223). `statusFor` would fail closed
    // either way, but an operator who asked to import a confirmed list and got a
    // 200 would believe it was mailable. The refusal is the whole point: the
    // file does not carry the evidence the request assumes.
    if (body.status === "confirmed") {
      const weak = columnsBlockingConfirmed(body.plan);
      if (weak.length > 0) {
        return json(400, {
          error:
            `cannot import as confirmed: ${weak.length} audience column(s) declare an implicit ` +
            `or absent consent basis, which proves an existing relationship rather than opt-in — ` +
            `import as pending, or re-declare the basis as explicit if the file carries the evidence`,
          columns: weak,
        });
      }
    }
    // A batch id is always stamped, so a bad file's rows stay findable even when
    // the caller did not think to supply one (#223).
    const batchId = body.batchId ?? `imp_${clock.now().toISOString()}`;
    const report = await importWithMapping(stores(), clock, {
      orgId,
      csv: file,
      plan: body.plan,
      ...(body.status ? { status: body.status } : {}),
      batchId,
      ...(body.sourceFile ? { sourceFile: body.sourceFile } : {}),
      ...(body.newListDefaults ? { newListDefaults: body.newListDefaults } : {}),
      ...(body.dryRun ? { dryRun: true } : {}),
    });
    // A plan that could not be applied is a 400, not a 200 with errors in the
    // body — the original importer's silent `200 {created:0}` is exactly the
    // failure #209 is about.
    if (report.errors.length > 0 && report.created === 0 && report.updated === 0) {
      return json(400, { error: report.errors[0], report });
    }
    // A dry run writes nothing, so there is nothing to account for.
    if (!body.dryRun) {
      await audit(event, orgId, "import.run", batchId);
    }
    // The batch id comes back so the console can link straight to the run it
    // just started — the caller usually did not supply one.
    return json(200, { ...report, batchId });
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET /orgs/{org}/import/batches — import history (#223).
 *
 * With `?batchId=` it returns that batch's memberships instead of the list. One
 * route rather than two because the pair is always read together: an operator
 * picks a run from the history, then asks what it wrote.
 */
export async function importBatchesHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const batchId = event.queryStringParameters?.batchId;
    if (!batchId) return json(200, await stores().importBatches.list(orgId));

    const batch = await stores().importBatches.get(orgId, batchId);
    if (!batch) return json(404, { error: "no such import batch" });
    return json(200, { batch, rows: await stores().importBatches.listRows(orgId, batchId) });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /orgs/{org}/import/suppression — import the SES account suppression list
 * (§4.7, §4.13, #240).
 *
 * The half of a migration nothing else can reconstruct: a subscriber export can
 * be taken again at any time, but "this address hard-bounced two years ago" lives
 * only in the account suppression list. Skip it and the first campaign mails
 * every one of those addresses, which is the reputation event the migration was
 * supposed to avoid.
 *
 * `suppression:manage` — the org-wide LIST view (`suppressionsListHandler`) and
 * this BULK import both stay dev-admin-only. `manualSuppress`/`liftSuppression`
 * moved to `subscribers:manage` in #247, because those are single-address,
 * front-line actions (Editor/Support handling one subscriber's report); this
 * route is neither — it writes GLOBAL entries in bulk, sourced from an entire
 * account's history, affecting every org in the deployment, with no bulk way
 * back. `suppression:manage` is developer_admin-only, which is the right blast
 * radius for that.
 *
 * The reader is injectable for tests only. It reads the DEPLOYMENT's SES account
 * rather than anything caller-supplied: an operator-named account would make this
 * route an SSRF-shaped credential-confusion primitive — "import from the account
 * I name" against our own credentials.
 */
/**
 * POST /orgs/{org}/import/upload-url — a presigned PUT for an import file (#242).
 *
 * The console uploads straight to S3. Routing the bytes through here would
 * reintroduce API Gateway's 10 MB payload ceiling, which — with #239's
 * `fileBase64` inflating a gzipped export by a third — an ordinary migration
 * list clears without trying.
 *
 * The key is DERIVED from the batch id, never accepted from the caller: a
 * caller-supplied key is a write primitive into our bucket, and a caller-supplied
 * key on the *read* side would let one org name another's object.
 */
export async function importUploadUrlHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const batchId = `imp_${clock.now().toISOString()}_${randomUUID().slice(0, 8)}`;
    const key = importObjectKey(orgId, batchId);
    const { url } = await importFiles().presignUpload(key);
    // The batch id comes back with the URL so the console can start the job and
    // poll for it without a second round trip to learn its own identity.
    return json(200, { batchId, key, url });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /orgs/{org}/import/upload-preview — preview a file already uploaded to
 * the import bucket (#252).
 *
 * Large files cannot be sent through API Gateway just to discover their columns.
 * The browser uploads once to the scoped presigned key, then this route reads
 * that same object server-side and returns the exact preview shape used by the
 * inline mapper. The object is not imported or claimed as a batch until the
 * operator confirms the mapping through /import/async.
 */
export async function importUploadPreviewHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const body = JSON.parse(event.body ?? "{}") as {
      batchId?: string;
      consentBasis?: "explicit" | "implicit";
    };
    const batchIdCheck = schemas.batchIdSchema.safeParse(body.batchId);
    if (!batchIdCheck.success) return json(400, { error: "valid batchId required" });

    const bytes = await importFiles().read(importObjectKey(orgId, batchIdCheck.data));
    const preview = previewCsv(bytes);
    if (preview.headers.length === 0) {
      return json(400, {
        error: "could not read the file: expected a CSV with a header row, or JSON Lines of endpoint objects (gzip supported)",
      });
    }
    const lists = await stores().lists.list(orgId);
    const plan = suggestMapping(preview, {
      knownLists: lists.map((l) => ({ listId: l.listId, name: l.name })),
      ...(body.consentBasis ? { consentBasis: body.consentBasis } : {}),
    });
    const saved = await stores().importMappings.findByFingerprint(orgId, preview.fingerprint);
    return json(200, {
      headers: preview.headers,
      sample: preview.sample,
      rowCount: preview.rowCount,
      fingerprint: preview.fingerprint,
      suggested: plan,
      saved,
      problems: validateMapping(plan, preview.headers),
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /orgs/{org}/import/async — run an uploaded file as a job (#242).
 *
 * Returns 202 with the batch id; the run itself outlives this request. Status is
 * `GET /orgs/{org}/import/batches?batchId=` — the batch record is marked
 * `running` HERE, before the invoke, so an operator holding a 202 always has
 * something to ask about even if the job Lambda never starts.
 */
export async function importAsyncHandler(
  event: HttpEvent,
  injected?: { invoke?: (payload: unknown) => Promise<void> },
): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const body = JSON.parse(event.body ?? "{}") as {
      batchId?: string;
      plan?: MappingPlan;
      status?: "confirmed" | "pending";
      sourceFile?: string;
      newListDefaults?: NewListDefaults;
    };
    if (!body.batchId || !body.plan?.columns) {
      return json(400, { error: "batchId and plan required" });
    }
    // The batch id becomes an S3 object key AND a DynamoDB sort key, so it is
    // validated rather than trusted — see `batchIdSchema` for what unvalidated
    // costs. Parsed here rather than in the domain because this is the boundary
    // the value crosses from a caller.
    const batchIdCheck = schemas.batchIdSchema.safeParse(body.batchId);
    if (!batchIdCheck.success) {
      return json(400, { error: `batchId: ${batchIdCheck.error.issues[0]?.message ?? "invalid"}` });
    }
    // The same refusal the inline route makes (#223). Checked BEFORE the job is
    // queued: a consent problem discovered inside an async run is one the
    // operator finds out about minutes later, from a batch record, having
    // already believed the import was accepted.
    if (body.status === "confirmed") {
      const weak = columnsBlockingConfirmed(body.plan);
      if (weak.length > 0) {
        return json(400, {
          error:
            `cannot import as confirmed: ${weak.length} audience column(s) declare an implicit ` +
            `or absent consent basis, which proves an existing relationship rather than opt-in`,
          columns: weak,
        });
      }
    }
    const sourceKey = importObjectKey(orgId, body.batchId);
    await startImportJob(stores(), clock, {
      orgId,
      batchId: body.batchId,
      sourceKey,
      ...(body.sourceFile ? { sourceFile: body.sourceFile } : {}),
    });
    const payload = {
      orgId,
      batchId: body.batchId,
      sourceKey,
      plan: body.plan,
      ...(body.status ? { status: body.status } : {}),
      ...(body.sourceFile ? { sourceFile: body.sourceFile } : {}),
      ...(body.newListDefaults ? { newListDefaults: body.newListDefaults } : {}),
    };
    await (injected?.invoke ?? invokeImporter)(payload);
    await audit(event, orgId, "import.run", body.batchId);
    return json(202, { batchId: body.batchId, status: "running" });
  } catch (e) {
    return fail(e);
  }
}

/** Event invocation: the job takes minutes, and this request must not wait. */
async function invokeImporter(payload: unknown): Promise<void> {
  await new LambdaClient({}).send(
    new InvokeCommand({
      FunctionName: env("IMPORTER_FN"),
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

export async function importSuppressionHandler(
  event: HttpEvent,
  injected?: { reader?: SuppressionListReader },
): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "suppression:manage", orgId);
    const body = JSON.parse(event.body ?? "{}") as { dryRun?: boolean };
    const dryRun = body.dryRun === true;
    const report = await importSuppressionList(
      stores(),
      clock,
      injected?.reader ?? new SesSuppressionListReader(),
      { orgId, ...(dryRun ? { dryRun: true } : {}) },
    );
    // Audited even though it writes no subscriber data: these entries are GLOBAL
    // and there is no bulk un-suppress, so "who ran this, against which org" is a
    // question that will be asked. A dry run wrote nothing, so it is not an event.
    if (!dryRun) await audit(event, orgId, "suppression.import", String(report.written));
    return json(200, { ...report, dryRun });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /orgs/{org}/import/segment — import a dynamic segment definition from AWS Pinpoint.
 */
export async function importSegmentHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "segments:manage", orgId);
    const { segmentId, pinpointSegment } = JSON.parse(event.body ?? "{}") as {
      segmentId?: string;
      pinpointSegment?: PinpointSegmentResponse;
    };
    if (!segmentId || !pinpointSegment) {
      return json(400, { error: "segmentId and pinpointSegment are required" });
    }
    const segment = await importPinpointSegment(stores(), orgId, segmentId, pinpointSegment);
    await audit(event, orgId, "segment.import", segment.name);
    return json(200, segment);
  } catch (e) {
    return fail(e);
  }
}

export async function importHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const body = JSON.parse(event.body ?? "{}") as {
      listId?: string;
      csv?: string;
      status?: "confirmed" | "pending";
      dryRun?: boolean;
    };
    if (!body.listId || typeof body.csv !== "string") {
      return json(400, { error: "listId and csv required" });
    }
    const report = await importCsvSubscribers(stores(), clock, {
      orgId,
      listId: body.listId,
      csv: body.csv,
      status: body.status,
      dryRun: body.dryRun,
    });
    // A file this parser cannot read is a 400, not a 200 with zeros (#209). It
    // looks for a lowercase `email` header; a real Pinpoint export has `Address`
    // and 72 other dotted columns, so every row errored and the response still
    // said `200 {created:0}` — which reads as "your list had nothing in it"
    // rather than "this endpoint cannot read your file". The mapper (#216) is
    // what handles arbitrary headers, so the error names it.
    if (report.errors.length > 0 && report.created === 0 && report.updated === 0) {
      return json(400, {
        error:
          `no row in this file had a usable 'email' column — this endpoint reads a plain ` +
          `email/attribute CSV. Use the import mapper (POST /orgs/{org}/import/preview) to map ` +
          `columns from an export whose headers differ.`,
        report,
      });
    }
    // A dry run writes nothing, so there is nothing to account for.
    if (!body.dryRun) {
      await audit(event, orgId, "import.run", body.listId);
    }
    return json(200, report);
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /privacy — GDPR/CCPA data-subject request (#101). `export` returns the
 * person's record (requires subscribers:manage); `erase` anonymizes + suppresses
 * (requires the stronger subscribers:delete). Sensitive; admin-invoked only.
 */
export async function privacyHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const { action, orgId, email } = JSON.parse(event.body ?? "{}") as {
      action?: "export" | "erase";
      orgId?: string;
      email?: string;
    };
    if (!orgId || !email) return json(400, { error: "orgId and email required" });
    if (action === "export") {
      requireGrant(event, "subscribers:manage", orgId);
      const data = await exportSubscriber(stores(), orgId, email);
      // A DSAR is a lawful request, and answering it is itself a privileged
      // read of one person's whole record.
      await audit(event, orgId, "privacy.export", email);
      return json(200, { found: data !== undefined, data });
    }
    if (action === "erase") {
      requireGrant(event, "subscribers:delete", orgId);
      const report = await eraseSubscriber(stores(), clock, orgId, email, {
        // The lake only exists when the analytics tier is on, so only then is
        // there a retention window to quote. Claiming one either way would be a
        // number the operator could not check.
        analyticsEnabled: process.env.ANALYTICS_ENABLED === "true",
        // Read from the same env the bucket's lifecycle rule is built from, so
        // the date the subject is told matches the rule that enforces it.
        ...(process.env.ANALYTICS_EVENT_RETENTION_DAYS
          ? { lakeRetentionDays: Number(process.env.ANALYTICS_EVENT_RETENTION_DAYS) }
          : {}),
      });
      // Erasure is irreversible. If nothing records that it happened, nobody
      // can later demonstrate the request was honoured — or notice one that
      // was not requested. The counts go in the entry too: "erased: true" is
      // what made #164 invisible, since it said the same thing whether one item
      // was anonymized or every trace was removed.
      await audit(
        event,
        orgId,
        "privacy.erase",
        `${email} events=${report.eventsDeleted} subs=${report.subscriptionsRedacted}`,
      );
      // `erased` is kept for the existing client; the report is the useful half.
      return json(200, { erased: report.found, report });
    }
    return json(400, { error: "action must be export or erase" });
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
      const updated = await unsubscribeFromList(stores(), clock, { orgId, subscriberId, listId });
      await publishCustomerSync(updated, "unsubscribed");
      return json(200, { status: "unsubscribed", scope: "list" });
    }
    if (!email) return json(400, { error: "email required for unsubscribe-all" });
    const result = await unsubscribeAllWithChanges(stores(), clock, { orgId, subscriberId, email });
    await Promise.all(result.changed.map((subscription) => publishCustomerSync(subscription, "unsubscribed")));
    return json(200, { status: "unsubscribed", scope: "all", lists: result.count });
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

/** POST /orgs/settings — configure general tenant settings. */
export async function settingsHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const parsed = schemas.saveSettingsSchema.parse(JSON.parse(event.body ?? "{}"));
    requireGrant(event, "identity:manage", parsed.orgId);
    const org = await stores().organizations.get(parsed.orgId);
    if (!org) return json(404, { error: "organization not found" });
    const updated = { ...org, hourlyEnabled: parsed.hourlyEnabled };
    await stores().organizations.put(updated);
    await audit(event, parsed.orgId, "settings.update", `hourlyEnabled=${parsed.hourlyEnabled}`);
    return json(200, { hourlyEnabled: updated.hourlyEnabled });
  } catch (e) {
    return fail(e);
  }
}

/** GET/POST /orgs/customer-sync — configure the external customer record sink. */
export async function customerSyncHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    const orgId = event.pathParameters?.org ?? event.queryStringParameters?.orgId ?? "";
    if (method === "GET") {
      if (!orgId) return json(400, { error: "orgId required" });
      requireGrant(event, "identity:manage", orgId);
      const config = (await stores().organizations.get(orgId))?.customerSync;
      return json(200, config ? { endpoint: config.endpoint, tableName: config.tableName, enabled: config.enabled, configured: true } : { configured: false });
    }
    const parsed = schemas.saveCustomerSyncSchema.safeParse(JSON.parse(event.body ?? "{}"));
    if (!parsed.success) return json(400, { error: parsed.error.issues[0]?.message ?? "invalid" });
    requireGrant(event, "identity:manage", parsed.data.orgId);
    const org = await stores().organizations.get(parsed.data.orgId);
    if (!org) return json(404, { error: "organization not found" });
    if (!parsed.data.secret && !org.customerSync?.secretRef) return json(400, { error: "secret required for first configuration" });
    const secretRef = parsed.data.secret
      ? await saveCustomerSyncSecret(parsed.data.orgId, parsed.data.secret)
      : org.customerSync!.secretRef;
    await stores().organizations.put({
      ...org,
      customerSync: { endpoint: parsed.data.endpoint, tableName: parsed.data.tableName, secretRef, enabled: parsed.data.enabled },
    });
    await audit(event, parsed.data.orgId, "customer_sync.update", parsed.data.endpoint);
    return json(200, { endpoint: parsed.data.endpoint, tableName: parsed.data.tableName, enabled: parsed.data.enabled, configured: true });
  } catch (e) {
    return fail(e);
  }
}

/** GET/POST /orgs/reengagement — configure the engagement-based sunset sweep. */
export async function reengagementHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    const orgId = event.pathParameters?.org ?? event.queryStringParameters?.orgId ?? "";
    if (method === "GET") {
      if (!orgId) return json(400, { error: "orgId required" });
      requireGrant(event, "campaigns:manage", orgId);
      const org = await stores().organizations.get(orgId);
      if (!org) return json(404, { error: "organization not found" });
      return json(200, {
        configured: !!org.reengagement,
        policy: resolveReengagementPolicy(org.reengagement),
      });
    }
    const parsed = schemas.saveReengagementSchema.safeParse(JSON.parse(event.body ?? "{}"));
    if (!parsed.success) return json(400, { error: parsed.error.issues[0]?.message ?? "invalid" });
    requireGrant(event, "campaigns:manage", parsed.data.orgId);
    const org = await stores().organizations.get(parsed.data.orgId);
    if (!org) return json(404, { error: "organization not found" });
    if (parsed.data.enabled) {
      const list = await stores().lists.get(parsed.data.orgId, parsed.data.listId!);
      if (!list) return json(400, { error: `unknown list "${parsed.data.listId}"` });
    }
    const policy = {
      enabled: parsed.data.enabled,
      coldAfterDays: parsed.data.coldAfterDays,
      steps: parsed.data.steps,
      stepIntervalDays: parsed.data.stepIntervalDays,
      suppressScope: parsed.data.suppressScope,
      ...(parsed.data.listId ? { listId: parsed.data.listId } : {}),
    };
    await stores().organizations.put({ ...org, reengagement: policy });
    await audit(event, parsed.data.orgId, "reengagement.update", parsed.data.listId);
    return json(200, { configured: true, policy });
  } catch (e) {
    return fail(e);
  }
}

/**
 * GET/POST /orgs/alerts — deliverability thresholds (#217, §4.18).
 *
 * These drive the auto-halt. Before this route existed, `stores.alerts.put` had
 * exactly one caller in the repo and it was a unit test, so on every real
 * install `checkDeliverability` short-circuited on a missing record and the
 * campaign ran to completion regardless of complaint rate.
 */
export async function alertConfigHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const method = event.requestContext?.http?.method ?? (event.body ? "POST" : "GET");
    if (method === "GET") {
      const orgId = event.pathParameters?.org ?? event.queryStringParameters?.orgId ?? "";
      if (!orgId) return json(400, { error: "orgId required" });
      requireGrant(event, "alerts:manage", orgId);
      const config = await stores().alerts.get(orgId);
      // A missing record is reported as such rather than as an empty config, so
      // the console can say "unprotected" instead of showing zeroed thresholds
      // that look deliberate.
      return json(200, config ?? null);
    }
    const parsed = schemas.saveAlertConfigSchema.safeParse(JSON.parse(event.body ?? "{}"));
    if (!parsed.success) return json(400, { error: parsed.error.issues[0]?.message ?? "invalid" });
    requireGrant(event, "alerts:manage", parsed.data.orgId);
    const config: AlertConfig = {
      orgId: parsed.data.orgId,
      ...(parsed.data.snsTopicArn ? { snsTopicArn: parsed.data.snsTopicArn } : {}),
      rules: parsed.data.rules,
      notifyTargets: parsed.data.notifyTargets,
    };
    await stores().alerts.put(config);
    await audit(event, parsed.data.orgId, "alerts.update");
    return json(200, config);
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
 * GET /orgs/{org}/directory — the public newsletter directory (#124).
 *
 * Unauthenticated, and named `directory` rather than `lists/public` so it can
 * never become ambiguous with `/orgs/{org}/lists/{list}` for a list whose id
 * happens to be "public".
 */
export async function publicDirectoryHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    if (!orgId) return json(400, { error: "org required" });
    return json(200, await publicListDirectory(stores(), orgId));
  } catch (e) {
    return fail(e);
  }
}

/** POST /webhooks/entitlement — signed webhook from the billing SoR (§4.3). */
export async function entitlementSyncHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const raw = event.body ?? "";
    const sig = header(event.headers, "x-addressium-signature");
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
    const sig = header(event.headers, "x-addressium-signature");
    const secret = await getSecret(env("WEBHOOK_SECRET_ARN"));
    if (!verifyWebhookSignature(secret, raw, sig)) {
      return json(401, { error: "bad signature" });
    }
    const payload = JSON.parse(raw) as unknown;
    const result = await applyIdentitySync(stores(), clock, payload);
    const orgId = (payload as { orgId?: string }).orgId;
    if (orgId && result.subscriberId && result.action !== "deleted") {
      await publishCurrentCustomerSync(orgId, result.subscriberId);
    }
    return json(200, result);
  } catch (e) {
    return fail(e);
  }
}

// ---- routers (#213) -------------------------------------------------------
//
// Twenty-seven single-route Lambdas all bundled THIS file and differed only in
// which exported handler they invoked — 27 copies of one bundle, each with its
// own cold start, log group and IAM role, for a data model that never changes.
// These routers collapse them while keeping every route registered in API
// Gateway individually, which matters: the JWT authorizer is attached per route,
// so a catch-all would have erased the public/authenticated boundary.
//
// Two routers rather than one, deliberately. They bundle the same code, but the
// dispatch tables are disjoint, so a routing mistake in the public function
// cannot reach an admin handler — and their IAM roles can differ. The
// `requireGrant` calls inside each admin handler remain the second layer.

type RouteHandler = (event: HttpEvent) => Promise<HttpResult>;

/** Behind the Cognito JWT authorizer. Every handler also calls requireGrant. */
/**
 * POST /preferences/request — email a management link (#74).
 *
 * Answers **202 with the same body whether or not the address is on file**.
 * This route is unauthenticated by necessity — the whole point is that the
 * person has no session — so any response that differs on existence turns it
 * into an address-enumeration oracle against the subscriber base. "We have sent
 * a link if that address is subscribed" is the only safe wording, and it happens
 * to be the true one.
 */
export async function preferenceRequestHandler(event: HttpEvent): Promise<HttpResult> {
  const accepted = { status: "sent", message: "If that address is subscribed, a link is on its way." };
  try {
    const { orgId, email } = JSON.parse(event.body ?? "{}") as { orgId?: string; email?: string };
    if (!orgId || !email) return json(400, { error: "orgId and email required" });
    const s = stores();
    const minted = await requestPreferenceLink(s, await confirmSigner(), clock, { orgId, email });
    if (minted) {
      const org = await s.organizations.get(orgId);
      const lists = await s.lists.list(orgId);
      const url = `${env("PREFERENCES_URL_BASE")}?token=${encodeURIComponent(minted.token)}`;
      const ses = new SesEmailSender(org?.sesConfigSet, undefined, org?.sesTransactionalConfigSet);
      await ses.send(buildPreferenceLinkEmail(lists[0], email, url, org?.name ?? orgId));
    }
    return json(202, accepted);
  } catch (e) {
    // Even a failure answers 202: a 500 on a known address and a 202 on an
    // unknown one is the same oracle by another route. Logged, not returned.
    console.error("preferences: request failed", { error: (e as Error).message });
    return json(202, accepted);
  }
}

/** GET /preferences?token=… — what this subscriber is on, and POST to change it (#74). */
export async function preferencesHandler(event: HttpEvent): Promise<HttpResult> {
  const method = (event.requestContext?.http?.method ?? "GET").toUpperCase();
  try {
    const body = method === "POST" ? (JSON.parse(event.body ?? "{}") as Record<string, unknown>) : {};
    const token = event.queryStringParameters?.token ?? (body.token as string) ?? "";
    // `verifyScoped`, not `verify` (#74). Without the scope check, the RFC 8058
    // unsubscribe token — present in every message ever sent, with a five-year
    // TTL — would open a management session over every list its holder is on.
    const claims = (await confirmSigner()).verifyScoped(token, "manage");
    const s = stores();
    if (method === "GET") return json(200, await preferenceCentre(s, claims.orgId, claims.sub));

    const changes = body.changes as { listId: string; subscribed: boolean }[] | undefined;
    if (!Array.isArray(changes)) return json(400, { error: "changes required" });
    const result = await applyPreferences(s, clock, claims.orgId, claims.sub, changes);
    // The preference centre is another public subscribe/unsubscribe surface.
    // `applyPreferences` reports only real transitions, so unchanged checkboxes
    // do not create duplicate external-customer events.
    await Promise.all([
      ...result.unsubscribed.map(async (listId) => {
        const subscription = await s.subscriptions.get(claims.orgId, claims.sub, listId);
        if (subscription) await publishCustomerSync(subscription, "unsubscribed");
      }),
      ...result.resubscribed.map(async (listId) => {
        const subscription = await s.subscriptions.get(claims.orgId, claims.sub, listId);
        if (subscription) await publishCustomerSync(subscription, "subscribed");
      }),
    ]);
    return json(200, { ...result, view: await preferenceCentre(s, claims.orgId, claims.sub) });
  } catch (e) {
    if (e instanceof RetiredKeyError || e instanceof TokenExpiredError) {
      return json(410, { status: "link_expired", error: "This management link is no longer valid." });
    }
    return fail(e);
  }
}

const ADMIN_ROUTES: Record<string, RouteHandler> = {
  "GET /orgs": orgsListHandler,
  "GET /orgs/{org}": orgMetaHandler,
  "GET /orgs/{org}/search": searchHandler,
  "GET /orgs/{org}/identity": orgIdentityHandler,
  "GET /orgs/{org}/sending-identity": sendingIdentityHandler,
  "GET /orgs/{org}/setup": setupStateHandler,
  "GET /orgs/{org}/lists": listsHandler,
  "POST /lists": listsHandler,
  "POST /lists/visibility": listVisibilityHandler,
  "POST /lists/presentation": listPresentationHandler,
  "GET /orgs/{org}/campaigns": campaignsListHandler,
  "GET /orgs/{org}/campaigns/{id}": campaignsHandler,
  "POST /campaigns": campaignsHandler,
  "GET /orgs/{org}/schedules": schedulesListHandler,
  // Registered in CDK via `api.addRoutes` rather than the `adminRoute` helper,
  // so neither half of the old parity guard saw it and the manifest simply did
  // not have it (#238). Found by `npm run dev`, where scheduling a send answered
  // "no route" — the deployed stack was fine, the manifest was not.
  "POST /campaigns/schedule": scheduleCampaignHandler,
  "POST /campaigns/lifecycle": scheduleLifecycleHandler,
  "GET /orgs/{org}/templates": templatesHandler,
  "GET /orgs/{org}/templates/{id}": templatesHandler,
  "POST /templates": templatesHandler,
  "GET /orgs/{org}/merge-tags": mergeTagsHandler,
  "POST /merge-tags": mergeTagsHandler,
  "POST /merge-tags/delete": mergeTagDeleteHandler,
  "GET /orgs/{org}/api-keys": apiKeysHandler,
  "POST /api-keys": apiKeysHandler,
  "POST /api-keys/revoke": apiKeyRevokeHandler,
  "POST /api-keys/verify": apiKeyVerifyHandler,
  "GET /orgs/{org}/series": seriesHandler,
  "GET /orgs/{org}/series/{id}": seriesHandler,
  "POST /series": seriesHandler,
  "GET /orgs/{org}/feeds": feedsHandler,
  "POST /feeds": feedsHandler,
  "GET /orgs/{org}/segments": segmentsHandler,
  "POST /segments": segmentsHandler,
  "GET /orgs/{org}/segments/{segment}/members": segmentMembersHandler,
  "POST /segments/members": segmentMembersHandler,
  "GET /orgs/{org}/drip-sequences": dripSequencesHandler,
  "POST /drip-sequences": dripSequencesHandler,
  "POST /drip-sequences/enroll": dripEnrollHandler,
  "GET /orgs/{org}/subscribers": subscribersListHandler,
  "GET /orgs/{org}/subscribers/{sub}": subscriberDetailHandler,
  "GET /orgs/{org}/subscribers/{sub}/timeline": subscriberTimelineHandler,
  "POST /subscribers/attributes": subscriberAttributesHandler,
  "POST /subscribers/subscription": subscriptionStatusHandler,
  "GET /orgs/{org}/suppressions": suppressionsListHandler,
  "GET /orgs/{org}/suppression/check": suppressionCheckHandler,
  "POST /subscribers/suppress": subscriberSuppressHandler,
  "POST /subscribers/unsubscribe": subscriberUnsubscribeHandler,
  "POST /subscribers/unsuppress": subscriberUnsuppressHandler,
  "POST /orgs/{org}/import": importHandler,
  "GET /orgs/{org}/audit": auditReadHandler,
  "GET /orgs/{org}/health": healthHandler,
  "GET /orgs/{org}/team": teamHandler,
  "POST /team": teamHandler,
  "GET /orgs/{org}/export": exportHandler,
  "POST /orgs/{org}/import/preview": importPreviewHandler,
  "POST /orgs/{org}/import/suppression": importSuppressionHandler,
  "POST /orgs/{org}/import/segment": importSegmentHandler,
  "POST /orgs/{org}/import/upload-url": importUploadUrlHandler,
  "POST /orgs/{org}/import/upload-preview": importUploadPreviewHandler,
  "POST /orgs/{org}/import/async": importAsyncHandler,
  "POST /orgs/{org}/import/mapped": importMappedHandler,
  "GET /orgs/{org}/import/batches": importBatchesHandler,
  "GET /orgs/{org}/import/mappings": importMappingsHandler,
  "POST /orgs/{org}/import/mappings": importMappingsHandler,
  "POST /privacy": privacyHandler,
  "POST /orgs/branding": brandingHandler,
  "POST /orgs/settings": settingsHandler,
  "GET /orgs/{org}/customer-sync": customerSyncHandler,
  "POST /orgs/customer-sync": customerSyncHandler,
  "GET /orgs/{org}/reengagement": reengagementHandler,
  "POST /orgs/reengagement": reengagementHandler,
  "GET /orgs/{org}/alerts": alertConfigHandler,
  "POST /orgs/alerts": alertConfigHandler,
};

/** Unauthenticated. Deliberately excludes every admin handler. */
const PUBLIC_ROUTES: Record<string, RouteHandler> = {
  "POST /signup": signupHandler,
  "POST /signup/batch": signupBatchHandler,
  "GET /confirm": confirmHandler,
  "GET /unsubscribe": unsubscribeHandler,
  "POST /unsubscribe": unsubscribeHandler,
  // The preference centre (#74). Unauthenticated by necessity — proof of
  // ownership is the emailed `scope: "manage"` token, not a session.
  "POST /preferences/request": preferenceRequestHandler,
  "GET /preferences": preferencesHandler,
  "POST /preferences": preferencesHandler,
  "GET /orgs/{org}/lists/{list}/public": publicListHandler,
  "GET /orgs/{org}/directory": publicDirectoryHandler,
  // The subscriber site reads branding to theme itself, unauthenticated. It was
  // registered in CDK and missing from this manifest (#238) — so it worked in
  // the deployed stack and was unreachable in `npm run dev`, which is exactly
  // the drift the parity guard now catches.
  "GET /orgs/{org}/branding": brandingHandler,

  "GET /version": versionHandler,
  "POST /webhooks/entitlement": entitlementSyncHandler,
  "POST /webhooks/identity": identitySyncHandler,
};

/**
 * API Gateway supplies `routeKey` ("METHOD /path" with path parameters in their
 * template form). Falling back to method+rawPath would NOT be equivalent — a
 * concrete path like `/orgs/acme` doesn't match the `/orgs/{org}` key — so an
 * absent routeKey is an error rather than something to paper over.
 */
async function dispatch(
  table: Record<string, RouteHandler>,
  event: HttpEvent,
): Promise<HttpResult> {
  const routeKey = event.requestContext?.routeKey;
  if (!routeKey) return json(500, { error: "no routeKey on request" });
  const handler = table[routeKey];
  // A 404 here means CDK registered a route this router doesn't know about.
  // The route-parity test exists so that mismatch is caught at build time.
  if (!handler) return json(404, { error: `no handler for ${routeKey}` });
  return handler(event);
}

export const adminRouter = (event: HttpEvent): Promise<HttpResult> =>
  dispatch(ADMIN_ROUTES, event);
export const publicRouter = (event: HttpEvent): Promise<HttpResult> =>
  dispatch(PUBLIC_ROUTES, event);

export { applyMigrations, type Migration } from "./migrations.js";

/** Exported so the route-parity test can assert against the CDK route list. */
export const ROUTE_KEYS = {
  admin: Object.keys(ADMIN_ROUTES),
  public: Object.keys(PUBLIC_ROUTES),
};
