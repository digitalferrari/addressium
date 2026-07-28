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
import {
  SystemClock,
  emailTemplateFromStored,
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
}

export async function dripStepHandler(event: DripStepEvent) {
  const s = stores();
  // Routing identity is echoed back so the state machine can loop without a
  // separate Pass to reconstruct it after the Task overwrites the state.
  const routing = { orgId: event.orgId, sequenceId: event.sequenceId, subscriberId: event.subscriberId };
  const sequence = await s.dripSequences.get(event.orgId, event.sequenceId);
  if (!sequence) throw new Error(`unknown drip sequence ${event.sequenceId}`);
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
    const magic = new KmsMagicLinkSigner(
      {
        keyId: org.magicLink.kmsKeyArn,
        kid: org.magicLink.kid,
        issuer: org.magicLink.issuer,
        audience: org.magicLink.audience,
        ttlSeconds: TTL,
      },
      clock,
    );
    const ses = new SesEmailSender(org.sesConfigSet);
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
      campaignId: `drip-${event.sequenceId}-${step.stepId}`,
      subscriberId: event.subscriberId,
      listId: step.listId,
      subject: step.subject,
      template,
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
}

export async function reengagementSweepHandler(event: ReengagementSweepEvent) {
  const s = stores();
  const org = await s.organizations.get(event.orgId);
  if (!org) throw new Error(`unknown org ${event.orgId}`);
  const magic = new KmsMagicLinkSigner(
    {
      keyId: org.magicLink.kmsKeyArn,
      kid: org.magicLink.kid,
      issuer: org.magicLink.issuer,
      audience: org.magicLink.audience,
      ttlSeconds: TTL,
    },
    clock,
  );
  const ses = new SesEmailSender(org.sesConfigSet);
  const subject = event.subject ?? "Still want our newsletters?";
  const template: EmailTemplate = event.template ?? {
    blocks: [
      {
        kind: "text",
        html: `<p>We've missed you. <a href="#">Yes, keep me subscribed</a> — otherwise we'll stop sending to keep your inbox tidy.</p>`,
      },
    ],
  };
  const result = await runReengagementSweep(s, ses, magic, clock, {
    orgId: event.orgId,
    listId: event.listId,
    subject,
    template,
  });
  return { ok: true, ...result };
}
