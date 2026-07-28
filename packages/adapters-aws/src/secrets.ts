/**
 * Secrets Manager resolver (docs/SECURITY.md §4.6).
 *
 * The CDK passes secret ARNs (not values) so no plaintext lands in the template;
 * handlers resolve the value here at cold start and cache it for the container's
 * lifetime. Never log the returned value.
 *
 * READ-ONLY, deliberately. Nothing in the product writes a secret: the stack's
 * own signing keys are created by CDK, and an operator's reCAPTCHA secret is
 * theirs to create — they supply the ARN. The one writer was the AI layer's API
 * -key upsert, and it went with it (#227), so no role holds
 * `secretsmanager:CreateSecret` or `PutSecretValue` at all.
 */
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});
const cache = new Map<string, string>();

export async function getSecret(secretArn: string): Promise<string> {
  const cached = cache.get(secretArn);
  if (cached !== undefined) return cached;
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const value = res.SecretString ?? "";
  cache.set(secretArn, value);
  return value;
}

