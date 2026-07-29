/**
 * addressium service: sender — drains the SQS send queue and sends via SES.
 *
 * Multi-org: for each message it loads the org record and builds the org's
 * OWN magic-link signer (its KMS key) and SES config set, so tokens are signed
 * with the right per-org key and metrics land on the right config set (§4.11).
 * See docs/ARCHITECTURE.md §4.4.
 */
import {
  DynamoStores,
  KmsMagicLinkSigner,
  SesEmailSender,
  SqsSendQueue,
  getSecret,
} from "@addressium/adapters-aws";
import {
  HmacConfirmationSigner,
  SystemClock,
  TokenBucket,
  fanOutCampaign,
  sendCampaign,
  type SendDescriptor,
} from "@addressium/domain";
import { GsiSegmentEngine } from "@addressium/segment";

export interface SqsEvent {
  Records: Array<{ body: string; messageId?: string }>;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const clock = new SystemClock();
let _stores: DynamoStores | undefined;
const stores = () => (_stores ??= new DynamoStores(env("TABLE_NAME")));
let _queue: SqsSendQueue | undefined;
const queue = () => (_queue ??= new SqsSendQueue(env("SEND_QUEUE_URL")));
/**
 * Resolves a segment-targeted campaign to its members (#203).
 *
 * The v1 GSI engine, matching what the console's segment picker offers. Without
 * one wired here `sendCampaign` throws on a segment-targeted descriptor rather
 * than mailing the whole list, which is the direction that cannot be undone.
 */
let _segments: GsiSegmentEngine | undefined;
const segments = () => (_segments ??= new GsiSegmentEngine(stores()));
/**
 * Numeric env with a fail-fast guard. `Number("typo")` is NaN, and `NaN <= 0` is
 * false — so a malformed value slipped past every downstream guard: a NaN rate
 * made the TokenBucket a no-op (unthrottled), and a NaN chunk size made the
 * campaign claim itself and then "succeed" having sent to nobody (#201).
 *
 * The chunk-size half of that reads differently since #171: fan-out plans KEY
 * RANGES rather than offset/limit windows, so a NaN can no longer produce a
 * window that silently matches nothing. `planFanOut` still rejects a
 * non-positive chunk size outright, and this guard still stops the value
 * reaching it — belt and braces on a failure whose symptom was a campaign that
 * reported success.
 */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`env ${name} must be a positive number, got ${raw}`);
  return n;
}

const TTL = numEnv("MAGIC_TTL_SECONDS", 60 * 60 * 24 * 14);
/**
 * The ACCOUNT's SES rate, and how many senders may run at once (#176).
 *
 * The TokenBucket is per-invocation. SQS→Lambda scales the sender out, so N
 * concurrent invocations each pacing to the full account rate produce N × the
 * quota — SES then throttles mid-loop, the claim is already burned, and the
 * recipients in flight are silently lost (#163). Sustained throttling also costs
 * sending reputation, which is far harder to get back than a slow campaign.
 *
 * So each invocation gets the account rate DIVIDED by the concurrency cap the
 * event source enforces. CDK sets both from one constant; if the env is missing
 * we assume the cap is in force and divide by its default rather than
 * optimistically taking the whole quota.
 */
const SES_ACCOUNT_RATE = numEnv("SES_MAX_SEND_RATE", 14);
const SENDER_MAX_CONCURRENCY = numEnv("SENDER_MAX_CONCURRENCY", 5);
// Never below a trickle: a tiny account rate divided by the cap must still let a
// campaign finish rather than stall at zero tokens.
const SES_RATE = Math.max(0.1, SES_ACCOUNT_RATE / SENDER_MAX_CONCURRENCY);
const CHUNK_SIZE = numEnv("SEND_CHUNK_SIZE", 2000);

/**
 * RFC 8058 one-click unsubscribe link builder (#178).
 *
 * The URL must point at the real `/unsubscribe` route and carry a SIGNED token —
 * that handler verifies one, and the old header sent bare `?sub=&list=` params
 * at a `.example` host, so one-click never worked. Built lazily so the secret is
 * fetched once per cold start. If either env var is missing we return undefined
 * and the domain degrades to a `mailto:` header rather than advertising a
 * one-click URL that would fail.
 */
const UNSUB_TOKEN_TTL_SECONDS = 5 * 365 * 24 * 60 * 60; // ~5 years

let _unsub: { build(i: { orgId: string; subscriberId: string; listId: string }): Promise<string> } | undefined;
let _unsubInit = false;
async function unsubscribeLink() {
  if (_unsubInit) return _unsub;
  _unsubInit = true;
  const base = process.env.UNSUBSCRIBE_URL_BASE;
  const secretArn = process.env.CONFIRM_SECRET_ARN;
  if (!base || !secretArn) {
    console.warn("sender: UNSUBSCRIBE_URL_BASE/CONFIRM_SECRET_ARN unset — falling back to mailto");
    return undefined;
  }
  const signer = new HmacConfirmationSigner(await getSecret(secretArn));
  _unsub = {
    build: async ({ orgId, subscriberId, listId }) => {
      // Long-lived deliberately: a List-Unsubscribe header must still work when
      // someone opens an archived email years later, and unsubscribing is a safe,
      // idempotent action. The token is HMAC-signed, so it can't be forged or
      // enumerated the way the old bare ?sub=&list= URL could.
      const exp = Math.floor(clock.now().getTime() / 1000) + UNSUB_TOKEN_TTL_SECONDS;
      const token = signer.sign({ orgId, sub: subscriberId, listId, exp });
      return `${base.replace(/\/+$/, "")}?token=${encodeURIComponent(token)}`;
    },
  };
  return _unsub;
}

export async function handler(event: SqsEvent) {
  const s = stores();
  const results = [];
  // Per-message failures, reported back to SQS so ONLY the failing message is
  // redelivered. Previously any throw failed the whole batch and redelivered
  // the already-processed messages, re-sending delivered mail (#177).
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  // One shared token bucket paces every send this invocation makes to SES.
  const throttle = new TokenBucket(SES_RATE, Math.max(1, Math.ceil(SES_RATE)), clock);
  const unsubscribeLinkBuilder = await unsubscribeLink();

  for (const record of event.Records ?? []) {
   try {
    const descriptor = JSON.parse(record.body) as SendDescriptor;
    const org = await s.organizations.get(descriptor.orgId);
    if (!org) throw new Error(`unknown org ${descriptor.orgId}`);

    // Large lists with no slice yet: fan out into per-window SQS messages so
    // the queue parallelizes the work instead of one long invocation (#9).
    if (!descriptor.slice) {
      const slices = await fanOutCampaign(s, queue(), descriptor, CHUNK_SIZE, segments());
      if (slices.length > 0) {
        results.push({ fannedOut: slices.length });
        continue;
      }
    }

    // Per-org signer (its KMS key) + per-org SES configuration set. `magicLink`
    // absent means the org has the feature off: no signer is built, so no KMS
    // Sign call is made per recipient and the send costs nothing extra.
    const magic = org.magicLink
      ? new KmsMagicLinkSigner(
          {
            keyId: org.magicLink.kmsKeyArn,
            kid: org.magicLink.kid,
            issuer: org.magicLink.issuer,
            audience: org.magicLink.audience,
            ttlSeconds: TTL,
          },
          clock,
        )
      : undefined;
    const ses = new SesEmailSender(org.sesConfigSet, undefined, org.sesTransactionalConfigSet);

    results.push(
      await sendCampaign(s, ses, magic, clock, descriptor, {
        throttle,
        unsubscribeLink: unsubscribeLinkBuilder,
        // Required whenever a descriptor names a segment; `sendCampaign` throws
        // rather than falling back to the whole list if it is missing (#203).
        segments: segments(),
      }),
    );
   } catch (e) {
     // Isolate the failure to this message. Without an identifier SQS can't be
     // told which one failed, so fall back to failing loudly.
     const id = record.messageId;
     if (!id) throw e;
     console.error("send record failed", { messageId: id, error: (e as Error).message });
     batchItemFailures.push({ itemIdentifier: id });
   }
  }
  return { batchItemFailures, results };
}
