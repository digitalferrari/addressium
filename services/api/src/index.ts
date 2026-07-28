/**
 * addressium service: api — thin HTTP handlers over the domain.
 *
 * Handlers validate/authorize, then call pure functions from @addressium/domain
 * against DynamoDB-backed stores (@addressium/adapters-aws). No business logic
 * lives here. See docs/ARCHITECTURE.md §4.2–4.3, §4.12.
 */
import {
  CognitoAdminDirectory,
  CognitoSubscriberAccounts,
  DynamoStores,
  EventBridgeScheduler,
  GoogleRecaptchaVerifier,
  SesEmailSender,
  getSecret,
  sanitizeEmailHtml,
  upsertSecret,
} from "@addressium/adapters-aws";
import { schemas, APP_VERSION, EXPECTED_SCHEMA_VERSION, type AlertConfig } from "@addressium/core";
import {
  HmacConfirmationSigner,
  SystemClock,
  applyEntitlementSync,
  applyIdentitySync,
  buildConfirmationEmail,
  buildBatchConfirmationEmail,
  confirmOptInAny,
  effectiveOneOffTime,
  evaluateSetup,
  isHoneypotTripped,
  markScheduleActive,
  transitionSchedule,
  type EmailTemplate,
  provisionSubscriberAccount,
  manualSuppress,
  liftSuppression,
  capabilitiesOf,
  exportCsv,
  exportJsonl,
  importCsvSubscribers,
  inviteMember,
  listTeam,
  setMemberAccess,
  setMemberEnabled,
  importWithMapping,
  previewCsv,
  suggestMapping,
  validateMapping,
  type MappingPlan,
  type NewListDefaults,
  exportSubscriber,
  eraseSubscriber,
  publicListView,
  setAiConfig,
  setBranding,
  setListPresentation,
  saveCampaignDraft,
  saveList,
  saveSegment,
  saveDripSequence,
  saveTemplate,
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

/** POST /signup — public, double opt-in (§4.2). */
export async function signupHandler(event: HttpEvent): Promise<HttpResult> {
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

    const res = await signupMany(stores(), await confirmSigner(), clock, raw, provenance(event));
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
    const subs = await confirmOptInAny(stores(), await confirmSigner(), clock, token, provenance(event));

    // After the double opt-in is verified, ensure the subscriber has an account
    // in the org's linked pool, so their magic-link tokens can carry the pool
    // `sub` a paywall resolves against. Gated on the org having magic links on
    // — with the feature off addressium never touches Cognito at all. This
    // replaces the old `createAccountsOnConfirm` opt-in, which was incompatible
    // with the token contract: an org whose subscribers mostly lacked an
    // account would mint mostly unresolvable tokens.
    //
    // Best-effort: a provisioning hiccup must not fail the confirmation the
    // subscriber just completed. A subscriber left without an externalId is
    // sent to without a token and shows up in SendResult.untokenized.
    const first = subs[0];
    if (first) {
      const org = await stores().organizations.get(first.orgId);
      if (org?.magicLink && org.subscriberPoolId) {
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

/** POST /campaigns/schedule — send now, at a time, or recurring (§4.6, §4.16). */
export async function scheduleCampaignHandler(event: HttpEvent): Promise<HttpResult> {
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
        await markScheduleActive(stores(), clock, {
          orgId: body.orgId,
          scheduleId: body.campaignId,
          kind: "one_off",
        });
        return json(202, { status: "scheduled", at: at.toISOString(), scheduleId: body.campaignId });
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
          // Must be a RecurringLaunchPayload, not a bare descriptor: the launch
          // handler's legacy branch hardcodes editionKey "edition", which made
          // every firing compute the SAME campaign id — so the first edition
          // claimed it and every later firing was silently skipped (#162).
          // EventBridge Scheduler substitutes the context attribute below with
          // this firing's scheduled time, and it is stable across retries of
          // that firing, so idempotency still holds.
          payload: { descriptor, editionKey: "<aws.scheduler.scheduled-time>" },
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
    return json(200, state);
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

/** GET /orgs/{org} — lightweight org metadata (name, environment) for the console header. */
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
      // Surface the configured AI provider (vendor + model only) so the console
      // can reflect saved state; the API key/secret ARN is never echoed (#144).
      aiConfig: org.aiConfig ? { vendor: org.aiConfig.vendor, model: org.aiConfig.model } : undefined,
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

/**
 * GET /orgs/{org}/subscribers — subscriber lookup/list for the admin console
 * (#102). Optional `?q=` filters by email substring. Returns a projection (no
 * raw attributes bag) so the table stays light. Paginated at the adapter layer.
 */
export async function subscribersListHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const q = (event.queryStringParameters?.q ?? "").trim().toLowerCase();
    const all = await stores().subscribers.list(orgId);
    const rows = all
      .filter((s) => (q ? s.email.toLowerCase().includes(q) : true))
      .map((s) => ({
        sub: s.sub,
        email: s.email,
        status: s.status,
        entitlement: s.entitlement,
        lastEngagedAt: s.lastEngagedAt,
      }));
    return json(200, rows);
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

/** POST /subscribers/unsuppress — lift an org suppression + reactivate (#102). */
export async function subscriberUnsuppressHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const { orgId, email } = JSON.parse(event.body ?? "{}") as { orgId?: string; email?: string };
    if (!orgId || !email) return json(400, { error: "orgId and email required" });
    requireGrant(event, "suppression:manage", orgId);
    return json(200, await liftSuppression(stores(), { orgId, email }));
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
      case "invite":
        return json(200, await inviteMember(directory(), {
          email: body.email ?? "",
          role: body.role ?? "",
          orgs: body.orgs ?? [],
        }));
      case "access":
        if (!body.username) return json(400, { error: "username required" });
        return json(200, await setMemberAccess(directory(), body.username, {
          role: body.role ?? "",
          orgs: body.orgs ?? [],
        }));
      case "enable":
      case "disable":
        if (!body.username) return json(400, { error: "username required" });
        await setMemberEnabled(directory(), body.username, body.action === "enable");
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

    const body = format === "jsonl" ? await exportJsonl(stores(), opts) : await exportCsv(stores(), opts);
    const stamp = clock.now().toISOString().slice(0, 10);
    return {
      statusCode: 200,
      headers: {
        "content-type": format === "jsonl" ? "application/x-ndjson" : "text/csv",
        "content-disposition": `attachment; filename="addressium-${orgId}-${stamp}.${format}"`,
      },
      body,
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /orgs/{org}/import/preview — headers, sample rows and a suggested
 * mapping (#216). Writes NOTHING: the console renders this so the operator can
 * see what the file actually contains before committing to it.
 */
export async function importPreviewHandler(event: HttpEvent): Promise<HttpResult> {
  try {
    const orgId = event.pathParameters?.org ?? "";
    requireGrant(event, "subscribers:manage", orgId);
    const body = JSON.parse(event.body ?? "{}") as { csv?: string; consentBasis?: "explicit" | "implicit" };
    if (typeof body.csv !== "string" || body.csv.trim() === "") {
      return json(400, { error: "csv required" });
    }

    const preview = previewCsv(body.csv);
    if (preview.headers.length === 0) return json(400, { error: "file has no header row" });

    // Bind suggestions to what this org already has, so a column maps to an
    // existing list or attribute rather than proposing a duplicate.
    const lists = await stores().lists.list(orgId);
    const plan = suggestMapping(preview, {
      knownLists: lists.map((l) => ({ listId: l.listId, name: l.name })),
      ...(body.consentBasis ? { consentBasis: body.consentBasis } : {}),
    });
    return json(200, {
      headers: preview.headers,
      sample: preview.sample,
      rowCount: preview.rowCount,
      fingerprint: preview.fingerprint,
      suggested: plan,
      problems: validateMapping(plan, preview.headers),
    });
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
      plan?: MappingPlan;
      status?: "confirmed" | "pending";
      batchId?: string;
      sourceFile?: string;
      newListDefaults?: NewListDefaults;
      dryRun?: boolean;
    };
    if (typeof body.csv !== "string" || !body.plan?.columns) {
      return json(400, { error: "csv and plan required" });
    }
    const report = await importWithMapping(stores(), clock, {
      orgId,
      csv: body.csv,
      plan: body.plan,
      ...(body.status ? { status: body.status } : {}),
      // A batch id is always stamped, so a bad file's rows stay findable even
      // when the caller did not think to supply one (#223).
      batchId: body.batchId ?? `imp_${clock.now().toISOString()}`,
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
    return json(200, report);
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
      return json(200, { found: data !== undefined, data });
    }
    if (action === "erase") {
      requireGrant(event, "subscribers:delete", orgId);
      return json(200, { erased: await eraseSubscriber(stores(), clock, orgId, email) });
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
const ADMIN_ROUTES: Record<string, RouteHandler> = {
  "GET /orgs/{org}": orgMetaHandler,
  "GET /orgs/{org}/setup": setupStateHandler,
  "GET /orgs/{org}/lists": listsHandler,
  "POST /lists": listsHandler,
  "POST /lists/visibility": listVisibilityHandler,
  "POST /lists/presentation": listPresentationHandler,
  "GET /orgs/{org}/campaigns": campaignsListHandler,
  "GET /orgs/{org}/campaigns/{id}": campaignsHandler,
  "POST /campaigns": campaignsHandler,
  "GET /orgs/{org}/schedules": schedulesListHandler,
  "POST /campaigns/lifecycle": scheduleLifecycleHandler,
  "GET /orgs/{org}/templates": templatesHandler,
  "GET /orgs/{org}/templates/{id}": templatesHandler,
  "POST /templates": templatesHandler,
  "GET /orgs/{org}/segments": segmentsHandler,
  "POST /segments": segmentsHandler,
  "GET /orgs/{org}/drip-sequences": dripSequencesHandler,
  "POST /drip-sequences": dripSequencesHandler,
  "GET /orgs/{org}/subscribers": subscribersListHandler,
  "GET /orgs/{org}/suppressions": suppressionsListHandler,
  "POST /subscribers/suppress": subscriberSuppressHandler,
  "POST /subscribers/unsubscribe": subscriberUnsubscribeHandler,
  "POST /subscribers/unsuppress": subscriberUnsuppressHandler,
  "POST /orgs/{org}/import": importHandler,
  "GET /orgs/{org}/team": teamHandler,
  "POST /team": teamHandler,
  "GET /orgs/{org}/export": exportHandler,
  "POST /orgs/{org}/import/preview": importPreviewHandler,
  "POST /orgs/{org}/import/mapped": importMappedHandler,
  "POST /privacy": privacyHandler,
  "POST /orgs/branding": brandingHandler,
  "GET /orgs/{org}/alerts": alertConfigHandler,
  "POST /orgs/alerts": alertConfigHandler,
  "POST /orgs/ai-config": aiConfigHandler,
};

/** Unauthenticated. Deliberately excludes every admin handler. */
const PUBLIC_ROUTES: Record<string, RouteHandler> = {
  "POST /signup": signupHandler,
  "POST /signup/batch": signupBatchHandler,
  "GET /confirm": confirmHandler,
  "POST /unsubscribe": unsubscribeHandler,
  "GET /orgs/{org}/lists/{list}/public": publicListHandler,
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

/** Exported so the route-parity test can assert against the CDK route list. */
export const ROUTE_KEYS = {
  admin: Object.keys(ADMIN_ROUTES),
  public: Object.keys(PUBLIC_ROUTES),
};
