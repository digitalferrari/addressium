/**
 * AWS adapters that satisfy the domain ports (DynamoDB / SES / KMS), plus a
 * factory that builds them from environment variables. Services construct these
 * once per cold start and pass them to the pure domain functions.
 */
export { DynamoStores } from "./dynamo.js";
export { SesEmailSender } from "./ses.js";
export { KmsMagicLinkSigner, type KmsMagicLinkSignerConfig } from "./kms.js";
export { SqsSendQueue } from "./sqs.js";
export { EventBridgeScheduler, type EventBridgeSchedulerConfig } from "./scheduler.js";
export { getSecret, upsertSecret } from "./secrets.js";
export { KmsJwksProvider, spkiDerToJwk, type Jwk } from "./jwks.js";
export { SnsAlertPublisher } from "./sns.js";
export { AwsProvisioningProviders } from "./provisioning.js";
export { S3AuditLog } from "./s3audit.js";
export { OpenSearchBulkWriter } from "./opensearch.js";
export {
  HttpLlmAdvisor,
  LlmAdvisorError,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  type HttpLlmAdvisorDeps,
} from "./llm.js";
export { GoogleRecaptchaVerifier } from "./recaptcha.js";
export { sanitizeEmailHtml } from "./sanitize.js";
export { CognitoSubscriberAccounts } from "./cognito-accounts.js";

import { DynamoStores } from "./dynamo.js";
import { SesEmailSender } from "./ses.js";
import { KmsMagicLinkSigner } from "./kms.js";
import { SqsSendQueue } from "./sqs.js";
import { HmacConfirmationSigner, SystemClock, type Stores } from "@addressium/domain";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

export interface Deps {
  stores: Stores;
  sender: SesEmailSender;
  magic: KmsMagicLinkSigner;
  confirmation: HmacConfirmationSigner;
  queue: SqsSendQueue;
  clock: SystemClock;
}

/** Build all adapters from env. Call once per Lambda cold start. */
export function depsFromEnv(): Deps {
  const clock = new SystemClock();
  return {
    stores: new DynamoStores(required("TABLE_NAME")),
    sender: new SesEmailSender(process.env.SES_CONFIG_SET),
    magic: new KmsMagicLinkSigner(
      {
        keyId: required("MAGIC_KMS_KEY_ID"),
        kid: required("MAGIC_KID"),
        issuer: required("MAGIC_ISSUER"),
        audience: required("MAGIC_AUDIENCE"),
        ttlSeconds: Number(process.env.MAGIC_TTL_SECONDS ?? 60 * 60 * 24 * 14),
      },
      clock,
    ),
    confirmation: new HmacConfirmationSigner(required("CONFIRM_SECRET")),
    queue: new SqsSendQueue(required("SEND_QUEUE_URL")),
    clock,
  };
}
