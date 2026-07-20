/**
 * Inbound webhook signature verification (docs/SECURITY.md §4.6).
 *
 * The entitlement-sync endpoint accepts updates from an external billing system
 * (e.g. Stripe). We authenticate the caller with an HMAC over the raw body,
 * compared in constant time — never trust an unsigned/unverified webhook.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Compute the expected signature (hex) for a raw body. */
export function signWebhook(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Constant-time verify a hex HMAC signature over the raw body. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHex: string,
): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHex, "hex");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
