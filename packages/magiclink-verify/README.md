# @addressium/magiclink-verify

Verify an addressium magic-link token and turn it into a session, on the
integrator's own site. Two layers:

- **`@addressium/magiclink-verify`** — the verifier. Node or browser, returns
  claims, throws on failure.
- **`@addressium/magiclink-verify/browser`** — the drop-in. Reads the token from
  the URL, verifies it, cleans the address bar, caches the result, and never
  throws. This is what a website should use.

Do not write your own verifier. The token is verified with a *public* key, so
the classic attack is algorithm confusion (RFC 8725 §2.1, §3.1): forge an HS256
token using the public key bytes as the HMAC secret, or send `alg: none`. The
mitigation is pinning `ES256` and never letting the token header choose. See
[`../../docs/SECURITY.md`](../../docs/SECURITY.md) §4.1 and
[`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §12.

## The drop-in (what most sites want)

No npm, no bundler, no build step. `npm run build` in this package emits both
artifacts with `jose` bundled in, plus an SRI hash for each:

```
dist/addressium-magiclink.esm.js    + .sri
dist/addressium-magiclink.iife.js   + .sri
```

Serve one from your own origin — a third-party script tag without `integrity`
is a standing supply-chain hole, because whoever can change the file can read
every subscriber id on the page.

```html
<script
  src="/vendor/addressium-magiclink.iife.js"
  integrity="sha384-…"          <!-- from dist/addressium-magiclink.iife.js.sri -->
  crossorigin="anonymous"
></script>
<script>
  const session = await addressiumMagicLink.consume({
    issuer: "https://addressium.example/summit",
    audience: "https://summitdaily.example",
    jwks: JWKS,                 // your org's public key, copied in — see below
  });

  if (session.authenticated && session.entitlement === "paid") dropPaywall();
</script>
```

A complete working page is in [`example/paywall.html`](example/paywall.html).

### The session object

```ts
{
  authenticated: boolean;
  reason: "verified" | "restored" | "no_token"
        | "expired" | "bad_signature" | "wrong_issuer" | "wrong_audience"
        | "not_yet_valid" | "malformed" | "wrong_scope" | "missing_claim"
        | "no_key_source";
  subscriberId?: string;    // addressium's id for this reader
  poolSub?: string;         // their `sub` in YOUR Cognito pool — the join key
  entitlement?: "free" | "paid";
  entitlementAsOf?: string; // ISO-8601
  expiresAt?: string;       // ISO-8601
}
```

`reason` is an enumerated string precisely so you can branch on it — "expired,
offer a fresh link" and "forged, show nothing" are different product decisions,
and `err.message.includes(...)` breaks the first time a dependency rewords an
error.

`subscriberId` and `poolSub` are named apart on purpose. The JWT calls them
`sub` and `external_sub`, and confusing the two is how the wrong id ends up in
someone's analytics.

### What it does that the raw verifier does not

- **Never throws.** A paywall's failure path is "show the wall", not "unhandled
  rejection blanks the article".
- **Removes the token from the URL**, via `history.replaceState` — before
  verification even resolves, so a slow or failing check cannot leave the
  credential in the address bar. Your own fragment state is preserved.
- **Caches the session in `sessionStorage`** so an in-site navigation does not
  need the token again. It expires exactly when the token does. Pass
  `cache: false` if you have your own session layer. The cache is a copy of a
  verified result, never evidence: editing it fools only that browser.
- **Makes no network call** when you pass `jwks` inline.

### Embed the key, don't fetch it

Copy your org's public JWKS from `https://<your-api>/<org>/jwks.json` into the
page. Fetching it at runtime would make your paywall fail whenever addressium is
slow or unreachable, and would tell addressium which of your readers opened
which article — a cross-site read of your audience that this design exists to
avoid. The cost is that a key rotation needs a redeploy of the page. That is the
trade the token model is built around.

### Other exports

```ts
currentSession()        // the cached session, synchronous — safe in a render path
clearSession()          // sign-out, or an entitlement change you were told about
readToken(hash, param?) // if you want to handle the URL yourself
stripTokenFromUrl(href, param?)
```

## The verifier (server side)

For a Cognito custom-auth Lambda or your own backend:

```ts
import { verifyMagicLinkToken } from "@addressium/magiclink-verify";

const claims = await verifyMagicLinkToken(token, {
  jwksUri: "https://api.addressium.example/summit/jwks.json", // per-org
  issuer: "https://addressium.example/summit",
  audience: "https://summitdaily.example",
});
// claims.sub           -> addressium's subscriber id
// claims.external_sub  -> the user's `sub` in YOUR Cognito pool
// claims.entitlement   -> "free" | "paid"
```

Throws `MagicLinkError`, which carries a `code` from the same enumeration
`reason` uses.

## Non-negotiable rules

- **Pin `ES256`.** Never widen `algorithms` or trust the JWT header's `alg`.
- **Verify, don't decode.** A refusal means "no session — show the wall."
- **Lite only.** A `magic_link` session is `content:read`. Never elevate it;
  gate profile and account behind step-up authentication.
