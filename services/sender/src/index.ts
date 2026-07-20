/**
 * addressium service: sender — drains the SQS send queue and sends via SES.
 *
 * Multi-org: for each message it loads the org record and builds the org's
 * OWN magic-link signer (its KMS key) and SES config set, so tokens are signed
 * with the right per-org key and metrics land on the right config set (§4.11).
 * See docs/ARCHITECTURE.md §4.4.
 */
import { DynamoStores, KmsMagicLinkSigner, SesEmailSender, SqsSendQueue } from "@addressium/adapters-aws";
import {
  SystemClock,
  TokenBucket,
  fanOutCampaign,
  sendCampaign,
  type SendDescriptor,
} from "@addressium/domain";

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
const TTL = Number(process.env.MAGIC_TTL_SECONDS ?? 60 * 60 * 24 * 14);
// SES max send rate (msgs/sec) this worker paces to; and the fan-out chunk size.
const SES_RATE = Number(process.env.SES_MAX_SEND_RATE ?? 14);
const CHUNK_SIZE = Number(process.env.SEND_CHUNK_SIZE ?? 2000);

export async function handler(event: SqsEvent) {
  const s = stores();
  const results = [];
  // One shared token bucket paces every send this invocation makes to SES.
  const throttle = new TokenBucket(SES_RATE, Math.max(1, Math.ceil(SES_RATE)), clock);

  for (const record of event.Records ?? []) {
    const descriptor = JSON.parse(record.body) as SendDescriptor;
    const org = await s.organizations.get(descriptor.orgId);
    if (!org) throw new Error(`unknown org ${descriptor.orgId}`);

    // Large lists with no slice yet: fan out into per-window SQS messages so
    // the queue parallelizes the work instead of one long invocation (#9).
    if (!descriptor.slice) {
      const slices = await fanOutCampaign(s, queue(), descriptor, CHUNK_SIZE);
      if (slices.length > 0) {
        results.push({ fannedOut: slices.length });
        continue;
      }
    }

    // Per-org signer (its KMS key) + per-org SES configuration set.
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

    results.push(await sendCampaign(s, ses, magic, clock, descriptor, { throttle }));
  }
  return { batchItemFailures: [], results };
}
