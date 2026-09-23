# Machine API (`/v1`)

API-key authenticated HTTP surface for integrations (#291). Separate from the
console's JWT API by design — see *Why it is separate* below.

## Authentication

```
Authorization: Bearer ak_<key>
```

The key goes in the header and **only** in the header. Never a query parameter:
query strings are written to CloudFront and API Gateway access logs, so a key
passed that way is a credential handed to anyone who can read logs.

Keys are issued and revoked from the console (Settings → API & Webhooks). The
plaintext is shown once at creation and is not recoverable — only a SHA-256
digest is stored.

## Routes

| Method | Path | Scope | Returns |
|---|---|---|---|
| `GET` | `/v1/orgs/{org}/subscribers/{email}` | `subscribers:read` | subscriber + their subscriptions |
| `POST` | `/v1/orgs/{org}/suppression` | `suppression:write` | `202` |
| `GET` | `/v1/orgs/{org}/campaigns` | `campaigns:read` | campaigns with counters |

`POST /v1/orgs/{org}/suppression` takes `{"email": "..."}`. It unsubscribes the
address from every list **and** adds it to the org suppression list — which is
what an integration means by "stop mailing this person". Suppressing alone would
leave the subscriptions confirmed, and the next import could revive them.

## Error contract

| Status | Meaning |
|---|---|
| `401` | **Any** authentication failure |
| `400` | The request itself was malformed (missing or invalid email) |
| `404` | Authenticated correctly; the resource does not exist |
| `500` | Our fault. Body carries a generic sentence, never internals |

**Every authentication failure is an identical `401` with body
`{"error":"unauthorized"}`** — unknown key, revoked key, key belonging to another
org, key lacking the scope, and a malformed header all produce the same bytes.

That uniformity is deliberate. Returning `403` for "insufficient scope" would
confirm the key is real, belongs to this org and is not revoked, which is most of
what someone probing keys wants to learn. A test asserts all six causes produce
one response, and that no response mentions an org id or a reason.

## Why it is separate from the console API

1. **No JWT authorizer on these routes.** An API Gateway authorizer caches per
   identity source, so a revoked key would keep working until the cache expired.
   Authentication happens inside the handler, against the stored key, on every
   request — which is what makes revocation immediate.
2. **A key is never converted into a grant.** `requireGrant` answers "which
   console role is this person"; a machine credential has no person and no role,
   only scopes. Keeping them apart is what stops a key inheriting a console
   capability nobody granted it.
3. **Its own Lambda and reserved concurrency**, so machine traffic cannot starve
   the console, or the reverse.

Machine credentials cannot issue credentials, manage teams, or change their own
scopes. Those are console operations and have no machine route.

## `lastUsedAt`

A successful call updates the key's `lastUsedAt`. A **rejected** call does not —
a column that moved on rejection would let a prober confirm a key exists by
watching the console. Asserted by test.

## Rate limiting

**Currently the API Gateway stage throttle only**, shared across all callers.
HTTP APIs have no per-key usage plans, so a per-key limit needs an
application-level token bucket. Deferred deliberately, and recorded here rather
than left implied: today one integration can consume the stage's capacity.

Worth adding before the first high-volume integration, and required before any
transactional-send route (below).

## Transactional send — deliberately excluded

Not built, and the decision is recorded rather than left as an omission.

Such a route lets an API key trigger SES mail to arbitrary addresses in an org's
domain. That is an abuse surface that needs a per-key rate limit (see above), its
own scope, and the dev-org allowlist enforced on it — none of which exist yet.
It is also not on the Pinpoint cutover path, which is what the machine API is
being built ahead of.

Build it when there is a caller, together with the per-key throttle.
