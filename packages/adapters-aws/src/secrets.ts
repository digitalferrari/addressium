/**
 * Secrets Manager resolver (docs/SECURITY.md §4.6).
 *
 * The CDK passes secret ARNs (not values) so no plaintext lands in the template;
 * handlers resolve the value here at cold start and cache it for the container's
 * lifetime. Never log the returned value.
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
