/**
 * Secrets Manager resolver (docs/SECURITY.md §4.6).
 *
 * The CDK passes secret ARNs (not values) so no plaintext lands in the template;
 * handlers resolve the value here at cold start and cache it for the container's
 * lifetime. Never log the returned value.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

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

/**
 * Create the named secret (or update its value if it already exists) and return
 * its ARN. Used when an admin supplies an LLM API key (#32) — the plaintext key
 * goes straight to Secrets Manager; only the ARN is persisted on the org.
 */
export async function upsertSecret(name: string, value: string): Promise<string> {
  try {
    const res = await client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
    cache.set(res.ARN ?? name, value);
    return res.ARN ?? name;
  } catch (e) {
    if ((e as { name?: string }).name !== "ResourceExistsException") throw e;
    const res = await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    cache.delete(res.ARN ?? name);
    return res.ARN ?? name;
  }
}
