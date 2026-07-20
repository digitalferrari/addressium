/**
 * addressium service: sender — drains the SQS send queue and sends via SES.
 *
 * Multi-org: for each message it loads the org record and builds the org's
 * OWN magic-link signer (its KMS key) and SES config set, so tokens are signed
 * with the right per-org key and metrics land on the right config set (§4.11).
 * See docs/ARCHITECTURE.md §4.4.
 */
import { DynamoStores, KmsMagicLinkSigner, SesEmailSender } from "@addressium/adapters-aws";
import { SystemClock, sendCampaign, type SendDescriptor } from "@addressium/domain";

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
const TTL = Number(process.env.MAGIC_TTL_SECONDS ?? 60 * 60 * 24 * 14);

export async function handler(event: SqsEvent) {
  const s = stores();
  const results = [];
  for (const record of event.Records ?? []) {
    const descriptor = JSON.parse(record.body) as SendDescriptor;
    const org = await s.organizations.get(descriptor.orgId);
    if (!org) throw new Error(`unknown org ${descriptor.orgId}`);

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

    // TODO: token-bucket throttle across records to respect the SES rate (#9).
    results.push(await sendCampaign(s, ses, magic, clock, descriptor));
  }
  return { batchItemFailures: [], results };
}
