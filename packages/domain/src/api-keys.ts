/**
 * API keys (#280, closing the management half of #266) — issuance, revocation
 * and verification of machine credentials scoped to one organization.
 *
 * SCOPE OF THIS MODULE. Outbound customer-record delivery is implemented as a
 * separate FIFO queue/worker pipeline; it is not API-key authenticated. HMAC
 * signing and rotation remain deferred in #267. This module is key MANAGEMENT.
 * Every admin route
 * continues to ride the Cognito JWT authorizer; an API key is not a second way
 * into the console and `authenticateApiKey` is deliberately not wired into any
 * route's auth path.
 *
 * WHAT THAT MEANS FOR "LAST USED", and it is the thing to get right: no route in
 * this build is AUTHENTICATED BY an API key, so a `lastUsedAt` that nothing
 * could ever write would be exactly the plausible-looking timestamp this feature
 * must not ship. It is instead written by one function, `authenticateApiKey`,
 * and by nothing else — not by listing, not by the console opening the screen.
 *
 * That function is reachable over HTTP as `POST /api-keys/verify`, which sits in
 * the ADMIN table behind the Cognito authorizer and `apikeys:manage`, not on the
 * public surface. Public, it would be an oracle: anyone could grind candidate
 * keys against it. Admin-gated, the only callers are operators who already hold
 * full console access to that org, and it answers a real operator question —
 * *is this the key in our CI, or the one we revoked?* — while stamping the use
 * it just made. A key that has never been verified shows "Never" because it
 * genuinely has never been presented.
 *
 * THE HASH IS THE DESIGN.
 *
 *  - The plaintext is 32 bytes of `randomBytes`, base64url, prefixed `ak_`. It
 *    is returned from `issueApiKey` ONCE and is not stored, logged or
 *    recoverable. A caller who loses it issues another key; there is no "show
 *    key again", because a store that could show it again is a store that could
 *    leak it again.
 *  - What IS stored is `sha256(plaintext)` as hex. Not bcrypt, not argon2: the
 *    secret is full-entropy CSPRNG output rather than a human-chosen password,
 *    so there is nothing for a slow KDF to defend — and a salted KDF cannot be
 *    looked up BY digest, which would turn every verification into a table scan.
 *  - `displayPrefix` is the first few plaintext characters, captured at
 *    issuance. The console's Key column has to render something the operator can
 *    match against what they pasted into their integration, and a hash renders
 *    nothing. Those characters are public the moment the key is used and are far
 *    too few to narrow a 256-bit search.
 *
 * REVOCATION KEEPS THE ROW. `revokeApiKey` stamps `revokedAt`; it does not
 * delete. After an incident the operator's question is "what could this
 * credential do and when did we cut it off", and a deleted row answers neither.
 * `listApiKeys` returns revoked keys, labeled, and `authenticateApiKey` is what
 * refuses them.
 */
import { createHash, randomBytes } from "node:crypto";
import type { ApiKey, ApiKeyScope, schemas } from "@addressium/core";
import { InvalidInputError, type Clock, type Stores } from "./ports.js";

/**
 * How a key looks on the wire. `ak_` rather than the prototype's `sk_live_`:
 * "sk"/"live" is a convention borrowed from a payments API where a test mode
 * exists, and there is no test mode here — a prefix that implies one is a
 * promise the product does not keep.
 */
const KEY_PREFIX = "ak_";

/** Characters of the plaintext kept for display. Enough to disambiguate a handful of keys, far too few to search. */
const DISPLAY_CHARS = KEY_PREFIX.length + 6;

/** SHA-256 hex of a plaintext key. The only transformation between wire and store. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * One key as the console renders it: the stored record MINUS the digest.
 *
 * `keyHash` is stripped rather than passed through. It is not a secret in the
 * sense the plaintext is — it cannot be reversed — but it is the exact value
 * `findByHash` accepts, so anything that could write to the console's data path
 * would be handed a working lookup token for free. There is no screen that needs
 * it, so no response carries it.
 */
export interface ApiKeyView {
  orgId: string;
  keyId: string;
  name: string;
  scopes: ApiKeyScope[];
  displayPrefix: string;
  createdAt: string;
  createdBy?: string;
  revokedAt?: string;
  /** Absent means the key has genuinely never been presented to `authenticateApiKey`. */
  lastUsedAt?: string;
  /** Derived, not stored — `revokedAt` is the fact; this saves every caller re-deriving it. */
  revoked: boolean;
}

export function toApiKeyView(k: ApiKey): ApiKeyView {
  return {
    orgId: k.orgId,
    keyId: k.keyId,
    name: k.name,
    scopes: k.scopes,
    displayPrefix: k.displayPrefix,
    createdAt: k.createdAt,
    ...(k.createdBy === undefined ? {} : { createdBy: k.createdBy }),
    ...(k.revokedAt === undefined ? {} : { revokedAt: k.revokedAt }),
    ...(k.lastUsedAt === undefined ? {} : { lastUsedAt: k.lastUsedAt }),
    revoked: k.revokedAt !== undefined,
  };
}

/**
 * The ONE response that carries a plaintext key, and the only one that ever
 * will. Named so that a handler returning it is obviously returning a secret.
 */
export interface IssuedApiKey {
  key: ApiKeyView;
  /**
   * The plaintext, shown to the operator exactly once. Not stored, not
   * recoverable, and absent from every other response in this module.
   */
  plaintext: string;
}

/**
 * Issue a key for one org.
 *
 * Refuses to overwrite an existing `keyId`. Every other registry in this repo
 * treats a re-put as an update, and that is right where the record IS the
 * content (a merge tag, a template). A credential is not: silently replacing
 * `billing-sync` would invalidate the key a running integration is already
 * using, while returning a fresh plaintext that looks like success — the
 * integration breaks later, somewhere else, for no visible reason. So this is
 * create-only, and the collision is an `InvalidInputError` naming the id (#265).
 */
export async function issueApiKey(
  stores: Stores,
  clock: Clock,
  input: schemas.IssueApiKeyInput,
  createdBy?: string,
): Promise<IssuedApiKey> {
  const org = await stores.organizations.get(input.orgId);
  if (!org) throw new InvalidInputError(`unknown org ${input.orgId}`);

  const existing = await stores.apiKeys.get(input.orgId, input.keyId);
  if (existing) {
    throw new InvalidInputError(
      `an API key with id "${input.keyId}" already exists in this organization. ` +
        `Keys are never replaced in place — an integration holding the old key would ` +
        `stop working with no visible cause. Revoke it, or choose another id.`,
    );
  }

  // Deduped, and a repeat is refused rather than quietly collapsed: a scope list
  // that comes back shorter than the one submitted looks like the server dropped
  // a permission, and the operator cannot tell which.
  const seen = new Set<ApiKeyScope>();
  for (const s of input.scopes) {
    if (seen.has(s)) throw new InvalidInputError(`scope "${s}" is listed twice`);
    seen.add(s);
  }

  const plaintext = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const record: ApiKey = {
    orgId: input.orgId,
    keyId: input.keyId,
    name: input.name,
    scopes: [...input.scopes],
    keyHash: hashApiKey(plaintext),
    displayPrefix: plaintext.slice(0, DISPLAY_CHARS),
    createdAt: clock.now().toISOString(),
    ...(createdBy === undefined ? {} : { createdBy }),
  };
  await stores.apiKeys.put(record);
  return { key: toApiKeyView(record), plaintext };
}

/**
 * Every key the org holds, newest first, revoked ones included and flagged.
 *
 * Revoked keys stay in the list on purpose — see the module header. Sorting is
 * by `createdAt` descending so the key an operator just issued is the one at the
 * top of the screen they are looking at.
 *
 * Reads nothing and writes nothing else: in particular this does NOT touch
 * `lastUsedAt`. Stamping it here would make "Last used" a record of the operator
 * opening the console rather than of the credential being used, which is the
 * plausible-looking-timestamp failure this feature is required to avoid.
 */
export async function listApiKeys(stores: Stores, orgId: string): Promise<ApiKeyView[]> {
  const keys = await stores.apiKeys.list(orgId);
  return keys
    .map(toApiKeyView)
    .sort((a, b) => (a.createdAt === b.createdAt ? a.keyId.localeCompare(b.keyId) : b.createdAt.localeCompare(a.createdAt)));
}

/**
 * Revoke a key. Idempotent in effect but not in report: revoking an
 * already-revoked key is refused with the date it was cut off, because an
 * operator reaching for that button during an incident needs to know whether
 * they are the one who did it or whether it was already done.
 */
export async function revokeApiKey(
  stores: Stores,
  clock: Clock,
  orgId: string,
  keyId: string,
): Promise<ApiKeyView> {
  const existing = await stores.apiKeys.get(orgId, keyId);
  if (!existing) throw new InvalidInputError(`unknown API key "${keyId}"`);
  if (existing.revokedAt) {
    throw new InvalidInputError(`API key "${keyId}" was already revoked at ${existing.revokedAt}.`);
  }
  const revoked: ApiKey = { ...existing, revokedAt: clock.now().toISOString() };
  await stores.apiKeys.put(revoked);
  return toApiKeyView(revoked);
}

/**
 * Verify a presented key and RECORD the use.
 *
 * This is the only writer of `lastUsedAt` in the product. That is what makes the
 * console's "Last used" column a fact rather than a decoration: a key that shows
 * "Never" has genuinely never been presented here.
 *
 * EVERY REJECTION IS SILENT AND UNSTAMPED. `opts.orgId` — an org mismatch —
 * `requiredScope`, a revoked key and an unknown digest all raise the same one
 * sentence and none of them write the stamp.
 *
 *  - The org check is INSIDE this function rather than in the handler because
 *    the stamp happens here. A caller authorized for org A posting org B's key
 *    would otherwise get `lastUsedAt` written on another tenant's credential and
 *    a response naming it, before any handler could compare the two.
 *  - A key that authenticates but lacks the scope is a valid credential making
 *    an invalid call; stamping it would record a use that did not happen.
 *  - One sentence for every cause, because distinguishing "no such key" from
 *    "revoked" confirms to a guesser that a particular value was once real. The
 *    operator's view of those same facts is the console, behind RBAC.
 */
export async function authenticateApiKey(
  stores: Stores,
  clock: Clock,
  plaintext: string,
  opts?: { orgId?: string; requiredScope?: ApiKeyScope },
): Promise<ApiKeyView> {
  const rejected = new InvalidInputError("invalid API key");
  if (typeof plaintext !== "string" || plaintext.length === 0) throw rejected;

  const found = await stores.apiKeys.findByHash(hashApiKey(plaintext));
  if (!found) throw rejected;
  if (opts?.orgId !== undefined && found.orgId !== opts.orgId) throw rejected;
  if (found.revokedAt) throw rejected;
  if (opts?.requiredScope && !found.scopes.includes(opts.requiredScope)) throw rejected;

  const used: ApiKey = { ...found, lastUsedAt: clock.now().toISOString() };
  await stores.apiKeys.put(used);
  return toApiKeyView(used);
}
