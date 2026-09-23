/**
 * Signed customer-sync webhook envelopes.
 *
 * Delivery is deliberately a worker concern, but the wire contract belongs in
 * the domain package so it can be tested without an AWS queue or an HTTP
 * endpoint. The receiver gets a stable event id (for its deduplication store),
 * a timestamp (for its replay window), and an HMAC over both plus the exact
 * bytes posted. A signature over only the JSON body could be replayed forever;
 * a timestamp not covered by the signature could be substituted by an attacker.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CUSTOMER_SYNC_SIGNATURE_VERSION = "v1";
/** Enough time for a normal SQS retry without making an old secret long-lived. */
export const CUSTOMER_SYNC_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

export interface CustomerSyncSigningSecret {
  version: 1;
  current: string;
  /** Retained only while an endpoint rolls to the new key. */
  previous?: string;
  /** ISO timestamp after which `previous` is ignored for outbound signing. */
  previousExpiresAt?: string;
}

/**
 * Existing deployments stored one opaque plaintext secret. Treat it as the
 * current key so turning on signed delivery is an additive deployment change,
 * not an outage for every configured destination.
 */
export function parseCustomerSyncSigningSecret(value: string): CustomerSyncSigningSecret {
  try {
    const parsed = JSON.parse(value) as Partial<CustomerSyncSigningSecret>;
    if (
      parsed.version === 1 &&
      typeof parsed.current === "string" &&
      parsed.current.length > 0 &&
      (parsed.previous === undefined || typeof parsed.previous === "string") &&
      (parsed.previousExpiresAt === undefined || typeof parsed.previousExpiresAt === "string")
    ) {
      return {
        version: 1,
        current: parsed.current,
        ...(parsed.previous ? { previous: parsed.previous } : {}),
        ...(parsed.previousExpiresAt ? { previousExpiresAt: parsed.previousExpiresAt } : {}),
      };
    }
  } catch {
    // A legacy opaque secret is not JSON. It remains valid as the current key.
  }
  if (!value) throw new Error("customer-sync secret is empty");
  return { version: 1, current: value };
}

export function serializeCustomerSyncSigningSecret(secret: CustomerSyncSigningSecret): string {
  return JSON.stringify(secret);
}

/** Rotate without a delivery gap: the old key signs in a short, explicit grace window. */
export function rotateCustomerSyncSigningSecret(
  existing: string,
  next: string,
  now: Date = new Date(),
): CustomerSyncSigningSecret {
  if (!next) throw new Error("customer-sync secret is empty");
  const current = parseCustomerSyncSigningSecret(existing).current;
  return {
    version: 1,
    current: next,
    previous: current,
    previousExpiresAt: new Date(now.getTime() + CUSTOMER_SYNC_ROTATION_GRACE_MS).toISOString(),
  };
}

/** The exact string the HMAC covers. Keep this stable; receivers implement it too. */
export function customerSyncSigningInput(timestamp: string, eventId: string, body: string): string {
  return `${CUSTOMER_SYNC_SIGNATURE_VERSION}.${timestamp}.${eventId}.${body}`;
}

export function signCustomerSyncWebhook(
  secret: string,
  timestamp: string,
  eventId: string,
  body: string,
): string {
  return `${CUSTOMER_SYNC_SIGNATURE_VERSION}=${createHmac("sha256", secret)
    .update(customerSyncSigningInput(timestamp, eventId, body), "utf8")
    .digest("hex")}`;
}

/**
 * How stale a signed request may be before a receiver should refuse it (#295).
 *
 * Five minutes: long enough to survive clock skew between two machines and a
 * slow network, short enough that a captured request is not replayable for an
 * afternoon. The signature covers the timestamp, so an attacker cannot move it
 * without the key — but without a window check a valid old request stays valid
 * forever, which is the whole replay problem.
 */
export const CUSTOMER_SYNC_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Verify a delivery. Reference implementation for integration authors, and the
 * thing they will copy — so it enforces the full contract rather than the
 * signature alone.
 *
 * `docs/ARCHITECTURE.md` tells receivers to "reject timestamps outside their
 * replay window and durably deduplicate eventId". The first half is now done
 * here, because a reference verifier that omits a rule the documentation states
 * teaches every integrator to omit it too.
 *
 * The second half — deduplicating `eventId` — cannot live here: it needs
 * durable storage on the RECEIVER's side, and SQS retries deliberately preserve
 * the id so that dedupe is possible. `eventId` is returned rather than
 * swallowed for exactly that reason.
 */
export function verifyCustomerSyncWebhook(
  signature: string,
  secret: string,
  timestamp: string,
  eventId: string,
  body: string,
  opts: { now?: Date; maxSkewMs?: number } = {},
): boolean {
  // Checked BEFORE the HMAC: a stale request is refused whether or not its
  // signature is valid, and there is no reason to spend the comparison.
  const sent = Date.parse(timestamp);
  if (Number.isNaN(sent)) return false;
  const now = (opts.now ?? new Date()).getTime();
  const skew = opts.maxSkewMs ?? CUSTOMER_SYNC_MAX_SKEW_MS;
  // Absolute, so a request from a clock running fast is refused too. A future
  // timestamp is as suspicious as an old one and is the easier mistake to make
  // when an attacker controls neither clock.
  if (Math.abs(now - sent) > skew) return false;

  const expected = Buffer.from(signCustomerSyncWebhook(secret, timestamp, eventId, body), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function customerSyncWebhookHeaders(
  secretValue: string,
  eventId: string,
  body: string,
  now: Date = new Date(),
): Record<string, string> {
  const secret = parseCustomerSyncSigningSecret(secretValue);
  const timestamp = now.toISOString();
  const headers: Record<string, string> = {
    "x-addressium-event-id": eventId,
    "x-addressium-timestamp": timestamp,
    "x-addressium-signature": signCustomerSyncWebhook(secret.current, timestamp, eventId, body),
  };
  if (
    secret.previous &&
    secret.previousExpiresAt &&
    !Number.isNaN(Date.parse(secret.previousExpiresAt)) &&
    now.getTime() <= Date.parse(secret.previousExpiresAt)
  ) {
    headers["x-addressium-previous-signature"] = signCustomerSyncWebhook(
      secret.previous,
      timestamp,
      eventId,
      body,
    );
  }
  return headers;
}
