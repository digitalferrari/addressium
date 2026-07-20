# @addressium/magiclink-verify

Hardened reference verifier for addressium magic-link tokens. **Copy this into
your main website** (Node or browser) rather than writing your own — the token is
verified with a *public* key, and rolling your own verifier is the easiest way to
introduce an algorithm-confusion vulnerability (RFC 8725). See
[`../../docs/SECURITY.md`](../../docs/SECURITY.md) §4.1 and
[`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §12.

## Usage (server — e.g. a Cognito custom-auth Lambda)

```ts
import { verifyMagicLinkToken } from "@addressium/magiclink-verify";

const claims = await verifyMagicLinkToken(token, {
  jwksUri: "https://api.addressium.example/summit/jwks.json", // per-org
  issuer: "https://addressium.example/summit",
  audience: "summitdaily.com",
});
// claims.sub  -> existing Cognito user in the shared pool
// claims.entitlement -> "free" | "paid"
```

## Usage (browser — the CloudFront-cached page)

```ts
import { tryVerifyMagicLinkToken } from "@addressium/magiclink-verify";

const token = new URLSearchParams(location.hash.slice(1)).get("tok");
const claims = token ? await tryVerifyMagicLinkToken(token, opts) : null;
if (claims?.entitlement === "paid") dropPaywallOverlay();   // else: leave the wall
```

## Non-negotiable rules

- **Pin `ES256`.** Never widen `algorithms` or trust the JWT header's `alg`.
- **Verify, don't decode.** A throw means "no session — show the wall."
- **Lite only.** Never elevate a `magic_link` session; gate profile/account
  behind step-up authentication.
