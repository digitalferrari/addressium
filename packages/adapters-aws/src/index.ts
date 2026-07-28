/**
 * AWS adapters that satisfy the domain ports (DynamoDB / SES / KMS). Services
 * construct the ones they need once per cold start and pass them to the pure
 * domain functions.
 *
 * There is deliberately no build-everything-from-env factory. Magic-link
 * signing is per-ORG config read from the Organization record at send time
 * (§4.9) — a per-deployment `MAGIC_*` env model contradicts that, and an org
 * with the feature off has no key for it to read, so such a factory could only
 * fail at cold start with a message that named an env var instead of the
 * toggle.
 */
export { DynamoStores } from "./dynamo.js";
export { SesEmailSender, SES_TAG, encodeTag, decodeTag } from "./ses.js";
export {
  unwrap,
  unwrapRecords,
  normalize,
  type Notification,
  type SesNotification,
  type UnwrappedRecord,
} from "./ses-events.js";
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
export { CognitoAdminDirectory } from "./admin-directory.js";
export { CloudWatchHealth, type HealthReport, type HealthStatus } from "./health.js";
