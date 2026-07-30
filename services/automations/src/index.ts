/**
 * addressium service: automations — the launch handler for recurring series.
 *
 * EventBridge Scheduler recurring schedules target this handler on each firing
 * (e.g. daily 6am ET) with a RecurringLaunchPayload as Input. On each firing it
 * pulls the series' feed (SSRF-guarded), builds a fresh edition (subject +
 * editorial blocks), stamps an editionKey-idempotent campaign id, and enqueues
 * it to the send queue for the sender to drain. See ARCHITECTURE.md §4.6, §4.16.
 */
import { DynamoStores, KmsMagicLinkSigner, SesEmailSender, SqsSendQueue } from "@addressium/adapters-aws";
import type { Organization } from "@addressium/core";
import {
  SystemClock,
  TokenBucket,
  dripCampaignId,
  emailTemplateFromStored,
  enrollmentSuperseded,
  escapeHtml,
  evaluateDripStep,
  nextStepIndex,
  planLaunchDescriptor,
  runReengagementSweep,
  scheduleActive,
  sendToSubscriber,
  type EmailTemplate,
  type RecurringLaunchPayload,
  type SendDescriptor,
} from "@addressium/domain";
import { fetchFeedItems } from "@addressium/svc-feeds";

/**
 * Automations pace themselves to SES too (#176).
 *
 * `dripStepHandler` and `reengagementSweepHandler` passed NO throttle at all,
 * despite `SendOneInput` and the sweep both supporting one — so a large drip
 * cohort or win-back sweep ran flat out, competing with campaign sends for the
 * same account quota. SES then throttles the loop mid-flight, and since the
 * claim is already burned those recipients are silently lost (#163).
 *
 * Deliberately a fraction of the account rate rather than all of it: automations
 * run alongside campaigns, and a win-back sweep that starves a scheduled send is
 * the same failure wearing different clothes.
 */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`env ${name} must be a positive number, got ${raw}`);
  return n;
}
const AUTOMATION_SES_RATE = Math.max(
  0.1,
  numEnv("SES_MAX_SEND_RATE", 14) / numEnv("AUTOMATION_RATE_DIVISOR", 4),
);
const automationThrottle = () =>
  new TokenBucket(AUTOMATION_SES_RATE, Math.max(1, Math.ceil(AUTOMATION_SES_RATE)), clock);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

let _queue: SqsSendQueue | undefined;
const queue = () => (_queue ??= new SqsSendQueue(env("SEND_QUEUE_URL")));
let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));
const clock = new SystemClock();
const TTL = Number(process.env.MAGIC_TTL_SECONDS ?? 60 * 60 * 24 * 14);

/**
 * Per-org magic-link signer, or `undefined` when the org has the feature off.
 * Building no signer means no KMS Sign call per recipient — drip and
 * re-engagement sends still go out, with untokenized editorial links that keep
 * their link-ids so click tracking is unaffected (§4.9).
 */
function signerFor(org: Organization): KmsMagicLinkSigner | undefined {
  if (!org.magicLink) return undefined;
  return new KmsMagicLinkSigner(
    {
      keyId: org.magicLink.kmsKeyArn,
      kid: org.magicLink.kid,
      issuer: org.magicLink.issuer,
      audience: org.magicLink.audience,
      ttlSeconds: TTL,
    },
    clock,
  );
}

/**
 * Normalize an edition key into something safe to embed in a campaign id.
 *
 * The scheduler substitutes `<aws.scheduler.scheduled-time>` with this firing's
 * time (e.g. `2026-07-27T13:00:00Z`) — stable across retries of that firing, so
 * the send stays idempotent. If substitution did not happen (local invoke, or a
 * legacy schedule created before #162), fall back to the current UTC hour so a
 * retry within the hour still collapses onto the same edition rather than
 * double-sending.
 */
function editionKeyFrom(raw: string | undefined, now: Date): string {
  const s = (raw ?? "").trim();
  const usable = s && !s.startsWith("<") ? s : now.toISOString().slice(0, 13);
  return usable.replace(/[^0-9A-Za-z]/g, "").slice(0, 16) || "edition";
}

/** Accept the rich payload, or a bare descriptor (legacy) which we wrap. */
function normalize(input: RecurringLaunchPayload | SendDescriptor, now: Date): RecurringLaunchPayload {
  if ("descriptor" in input) {
    return { ...input, editionKey: editionKeyFrom(input.editionKey, now) };
  }
  return { descriptor: input, editionKey: editionKeyFrom(undefined, now) };
}

export async function handler(input: RecurringLaunchPayload | SendDescriptor) {
  const payload = normalize(input, clock.now());
  // Lifecycle gate (§4.6): if the series was paused or archived, skip this
  // firing entirely. The EventBridge schedule keeps ticking (we never delete
  // it) but no edition is built or enqueued until it's resumed.
  const state = await stores().schedules.get(payload.descriptor.orgId, payload.descriptor.campaignId);
  if (!scheduleActive(state)) {
    return { ok: true, skipped: state?.status ?? "inactive" };
  }
  // Pull + parse the feed for this firing (guarded fetch, pinned IP, size cap).
  const items = payload.feed
    ? await fetchFeedItems(payload.feed.url, payload.feed.format)
    : undefined;
  // A feed that yielded no usable items must NOT become an edition. parseFeed
  // returns [] rather than throwing for a truncated body or an HTML error page
  // served with 200, and [] is truthy — so this used to build an edition with
  // zero blocks and send a BLANK email to the entire list. Worse, the edition id
  // is claimed on send, so it could never be corrected and re-sent (#174).
  if (payload.feed && (!items || items.length === 0)) {
    return { ok: true, skipped: "empty-feed", campaignId: payload.descriptor.campaignId };
  }
  const descriptor = planLaunchDescriptor(payload, items);
  await queue().enqueue(descriptor);
  return { ok: true, enqueued: descriptor.campaignId };
}

/**
 * Drip step Task (#23) — invoked by the Step Functions state machine at each
 * step after its Wait. Evaluates the per-subscriber choice; on "send" it mints
 * the org's magic token and sends the one message. Returns the decision + the
 * next step index (+ its wait) so the machine's Choice state can loop or end.
 */
export interface DripStepEvent {
  orgId: string;
  sequenceId: string;
  subscriberId: string;
  stepIndex: number;
  /**
   * Which enrollment this run belongs to, supplied by the starter (#245).
   *
   * It exists to give each enrollment its OWN send-claim namespace. The claim is
   * a permanent conditional Put with no TTL, so without this the key for step N
   * was the same string for every enrollment a subscriber ever had: someone who
   * subscribed, ran the sequence, unsubscribed and came back months later found
   * every step's claim already burned from the first run and received ZERO
   * emails on the second. That is #207 verbatim, one automation over — see
   * `reengagementCampaignId`, which fixed it there with the same field.
   *
   * Optional for executions started before this field existed; absent, the
   * campaign id keeps its original shape so those runs finish as they began.
   */
  enrollmentId?: string;
}

export async function dripStepHandler(event: DripStepEvent) {
  const s = stores();
  // Routing identity is echoed back so the state machine can loop without a
  // separate Pass to reconstruct it after the Task overwrites the state.
  // `enrollmentId` is part of it: drop it here and the second iteration loses the
  // claim namespace, which is worse than never having had one.
  const routing = {
    orgId: event.orgId,
    sequenceId: event.sequenceId,
    subscriberId: event.subscriberId,
    // A string rather than null when absent: the machine reads this field back
    // with `JsonPath.stringAt`, and a null there is a States.Runtime failure on
    // the second iteration — a loop that dies at step 1 over a field that is only
    // a namespace.
    enrollmentId: event.enrollmentId ?? "",
  };
  const sequence = await s.dripSequences.get(event.orgId, event.sequenceId);
  if (!sequence) throw new Error(`unknown drip sequence ${event.sequenceId}`);
  // A newer enrollment retires this one (#245). A re-signup mid-sequence mints a
  // fresh enrollment id and therefore a second execution, and this one cannot be
  // cancelled from outside — nothing remembers its name. Left running, both
  // executions would send every remaining step, each under its own claim
  // namespace, on two offset schedules.
  if (await enrollmentSuperseded(s, sequence, event.subscriberId, event.enrollmentId)) {
    return { ...routing, done: true, action: "exit", reason: "superseded by a newer enrollment", nextStepIndex: null, nextWaitSeconds: null };
  }
  const step = sequence.steps[event.stepIndex];
  if (!step) return { ...routing, done: true, action: "exit", reason: "no such step", nextStepIndex: null, nextWaitSeconds: null };

  const subscriber = await s.subscribers.get(event.orgId, event.subscriberId);
  const subscription = await s.subscriptions.get(event.orgId, event.subscriberId, step.listId);
  const decision = evaluateDripStep(step, subscriber, subscription);

  if (decision.type === "exit") {
    return { ...routing, done: true, action: "exit", reason: decision.reason, nextStepIndex: null, nextWaitSeconds: null };
  }

  if (decision.type === "send") {
    const org = await s.organizations.get(event.orgId);
    if (!org) throw new Error(`unknown org ${event.orgId}`);
    const magic = signerFor(org);
    const ses = new SesEmailSender(org.sesConfigSet, undefined, org.sesTransactionalConfigSet);
    // Resolve the step's stored template and render it through the shared
    // pipeline (#95) — same merge-escape + link-tokenization + click-map as a
    // campaign. A step with no templateId falls back to a minimal subject block.
    let template: EmailTemplate = { blocks: [{ kind: "text", html: escapeHtml(step.subject) }] };
    if (step.templateId) {
      const stored = await s.templates.get(event.orgId, step.templateId);
      if (!stored) throw new Error(`drip step references unknown template ${step.templateId}`);
      template = emailTemplateFromStored(stored);
    }
    await sendToSubscriber(s, ses, magic, clock, {
      orgId: event.orgId,
      campaignId: dripCampaignId(event.sequenceId, step.stepId, event.enrollmentId),
      subscriberId: event.subscriberId,
      listId: step.listId,
      subject: step.subject,
      template,
      throttle: automationThrottle(),
    });
  }

  const next = nextStepIndex(sequence, event.stepIndex);
  return {
    ...routing,
    done: next === undefined,
    action: decision.type,
    // null (not undefined) so Step Functions always sees the field for its loop.
    nextStepIndex: next ?? null,
    nextWaitSeconds: next !== undefined ? (sequence.steps[next]?.waitSeconds ?? 0) : null,
  };
}

/**
 * Re-engagement / sunset sweep (§4.22) — a recurring (daily) EventBridge schedule
 * targets this with a per-org payload. Enrolls cold subscribers into the win-back
 * sequence, advances or graduates the enrolled, and sunsets those who never
 * click. No-op unless the org has `reengagement.enabled`.
 */
export interface ReengagementSweepEvent {
  orgId: string;
  /** Flagship list the win-back emails send under (sunset unsubscribes from all). */
  listId: string;
  subject?: string;
  /** Optional custom win-back body; a plain "still want these?" block by default. */
  template?: EmailTemplate;
  /** Subscribers to examine in this invocation (#233). Default 1000. */
  maxSubscribers?: number;
}

export async function reengagementSweepHandler(event: ReengagementSweepEvent) {
  const s = stores();
  const org = await s.organizations.get(event.orgId);
  if (!org) throw new Error(`unknown org ${event.orgId}`);
  const magic = signerFor(org);
  const ses = new SesEmailSender(org.sesConfigSet, undefined, org.sesTransactionalConfigSet);
  const subject = event.subject ?? "Still want our newsletters?";
  const template: EmailTemplate = event.template ?? {
    blocks: [
      {
        kind: "text",
        html: `<p>We've missed you. <a href="#">Yes, keep me subscribed</a> — otherwise we'll stop sending to keep your inbox tidy.</p>`,
      },
    ],
  };
  // Resume where the last invocation stopped (#233, #182). The sweep used to
  // read the whole org into memory with no way to record progress, so a retry
  // restarted from zero and an org large enough to matter was never fully swept.
  const checkpoint = await s.sweepCheckpoints.get(event.orgId, "reengagement");
  const startedAt = checkpoint?.startedAt ?? clock.now().toISOString();

  const result = await runReengagementSweep(s, ses, magic, clock, {
    orgId: event.orgId,
    listId: event.listId,
    subject,
    template,
    // One bucket for the WHOLE sweep — a per-recipient bucket would pace
    // nothing, since each would start full.
    throttle: automationThrottle(),
    ...(checkpoint?.cursor ? { cursor: checkpoint.cursor } : {}),
    ...(event.maxSubscribers ? { maxSubscribers: event.maxSubscribers } : {}),
  });

  if (result.cursor) {
    // More to do. The checkpoint is written AFTER the work, so a crash re-does a
    // page rather than skipping one — the sweep's actions are idempotent (send
    // claims, step spacing), so a repeat is a near no-op while a skip would
    // leave subscribers permanently unswept.
    await s.sweepCheckpoints.put({
      orgId: event.orgId,
      sweep: "reengagement",
      cursor: result.cursor,
      startedAt,
      updatedAt: clock.now().toISOString(),
      scanned: (checkpoint?.scanned ?? 0) + result.scanned,
      completedPasses: checkpoint?.completedPasses ?? 0,
    });
  } else {
    // The pass finished. Clearing rather than storing a null cursor, so "no
    // checkpoint" unambiguously means "start from the beginning next time".
    await s.sweepCheckpoints.put({
      orgId: event.orgId,
      sweep: "reengagement",
      startedAt: clock.now().toISOString(),
      updatedAt: clock.now().toISOString(),
      scanned: 0,
      completedPasses: (checkpoint?.completedPasses ?? 0) + 1,
    });
  }

  return { ok: true, ...result, complete: !result.cursor };
}

/**
 * Weekly fan-out across every org that opted in (#233).
 *
 * A single EventBridge rule targets this; it finds the orgs with
 * `reengagement.enabled` and sweeps each. Per-org opt-in is the whole point: the
 * sweep's terminal step UNSUBSCRIBES cold subscribers, so a deployment-wide
 * default would start silently shrinking lists on installs where nobody asked
 * for it.
 *
 * An org that enabled the policy but never named a `listId` is REPORTED, not
 * swept. The win-back emails need a list to send under — one carrying a
 * from-address and a CAN-SPAM footer — and guessing one would mail an audience
 * the operator did not choose. Silence here would look identical to "no cold
 * subscribers", which is the failure mode this whole issue is about.
 */
export async function reengagementDispatchHandler(event?: { maxSubscribers?: number }) {
  const s = stores();
  const orgs = await s.organizations.list();
  const swept: Record<string, unknown>[] = [];
  const skipped: { orgId: string; reason: string }[] = [];

  for (const org of orgs) {
    if (!org.reengagement?.enabled) continue;
    if (!org.reengagement.listId) {
      skipped.push({ orgId: org.orgId, reason: "reengagement.enabled with no listId" });
      console.warn("automations: re-engagement enabled but no listId configured", {
        orgId: org.orgId,
      });
      continue;
    }
    try {
      const r = await reengagementSweepHandler({
        orgId: org.orgId,
        listId: org.reengagement.listId,
        ...(event?.maxSubscribers ? { maxSubscribers: event.maxSubscribers } : {}),
      });
      swept.push({ orgId: org.orgId, ...r });
    } catch (e) {
      // One org's failure must not stop the others: they are separate tenants
      // and a bad list in one is not a reason to skip everyone else's hygiene.
      console.error("automations: re-engagement sweep failed", {
        orgId: org.orgId,
        error: (e as Error).message,
      });
      skipped.push({ orgId: org.orgId, reason: (e as Error).message });
    }
  }
  console.log("automations: re-engagement dispatch complete", {
    orgs: orgs.length,
    swept: swept.length,
    skipped: skipped.length,
  });
  return { ok: true, swept, skipped };
}
export { rotateConfirmSecretHandler, newKeyMaterial, type RotationEvent } from "./rotate-confirm-secret.js";
