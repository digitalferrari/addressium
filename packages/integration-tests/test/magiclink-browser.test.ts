/**
 * The browser drop-in (#215).
 *
 * The verifier's cryptography is covered elsewhere and is not retested here.
 * What is covered is the consumption layer — the half that was left to every
 * integrator to write, and the half where the mistakes are not cryptographic:
 * a throw that blanks the article, a credential left in the address bar, a
 * cached session that outlives the token it came from, and failure reasons a
 * paywall cannot branch on.
 *
 * Signing uses real ES256 against a real local JWKS: a fake token would prove
 * only that the wrapper calls through.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JSONWebKeySet } from "jose";
import {
  clearSession,
  consume,
  currentSession,
  readToken,
  stripTokenFromUrl,
  type MagicLinkSession,
} from "@addressium/magiclink-verify/browser";

const ISS = "https://addressium.example/summit";
const AUD = "https://summitdaily.example";

interface Keys {
  privateKey: CryptoKey;
  jwks: JSONWebKeySet;
  other: CryptoKey;
}

async function keys(): Promise<Keys> {
  const a = await generateKeyPair("ES256");
  const b = await generateKeyPair("ES256");
  const jwk = await exportJWK(a.publicKey);
  return {
    privateKey: a.privateKey,
    other: b.privateKey,
    jwks: { keys: [{ ...jwk, kid: "k1", alg: "ES256", use: "sig" }] },
  };
}

async function mint(
  key: CryptoKey,
  over: Record<string, unknown> = {},
  ttlSec = 900,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    external_sub: "cognito-sub-9",
    scope: "content:read",
    amr: ["magic_link"],
    entitlement: "paid",
    entitlement_asof: "2026-07-28T00:00:00.000Z",
    ...over,
  })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setSubject("addressium-sub-1")
    .setIssuer(ISS)
    .setAudience(AUD)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSec)
    .sign(key);
}

/** A page: its URL, its history, its sessionStorage. */
function page(hash = "") {
  const store = new Map<string, string>();
  const env = {
    location: { href: `https://summitdaily.example/article/1${hash}`, hash },
    history: {
      replaceState(_d: unknown, _t: string, url: string) {
        env.location.href = url;
        const at = url.indexOf("#");
        env.location.hash = at < 0 ? "" : url.slice(at);
      },
    },
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    store,
  };
  return env;
}

const opts = (k: Keys, p: ReturnType<typeof page>, extra = {}) => ({
  issuer: ISS,
  audience: AUD,
  jwks: k.jwks,
  location: p.location,
  history: p.history,
  storage: p.storage,
  ...extra,
});

test("a valid token becomes a session the site can use", async () => {
  const k = await keys();
  const p = page(`#tok=${await mint(k.privateKey)}`);
  const s = await consume(opts(k, p));

  assert.equal(s.authenticated, true);
  assert.equal(s.reason, "verified");
  // Two ids, deliberately named apart: `sub` meaning "addressium subscriber"
  // while `external_sub` means "your Cognito user" is exactly the confusion that
  // puts the wrong id in someone's analytics.
  assert.equal(s.subscriberId, "addressium-sub-1");
  assert.equal(s.poolSub, "cognito-sub-9");
  assert.equal(s.entitlement, "paid");
  assert.equal(s.entitlementAsOf, "2026-07-28T00:00:00.000Z");
  assert.ok(Date.parse(s.expiresAt!) > Date.now());
});

test("the token is removed from the URL", async () => {
  // A magic link left in location.hash survives in the address bar, in a
  // copy-pasted link, in a screenshot, and in anything that reads
  // document.location.
  const k = await keys();
  const p = page(`#tok=${await mint(k.privateKey)}`);
  await consume(opts(k, p));
  assert.equal(p.location.hash, "");
  assert.equal(p.location.href, "https://summitdaily.example/article/1");
});

test("the site's own fragment state survives the strip", async () => {
  // Removing the whole hash would break a deep link or an open tab the site
  // tracks there.
  const k = await keys();
  const token = await mint(k.privateKey);
  const p = page(`#section=sports&tok=${token}&theme=dark`);
  await consume(opts(k, p));
  assert.equal(p.location.hash, "#section=sports&theme=dark");
});

test("the token is stripped even when verification fails", async () => {
  // Otherwise a forged or expired link leaves its payload in the address bar,
  // where it is copied and pasted around like a working one.
  const k = await keys();
  const p = page(`#tok=${await mint(k.other)}`);
  const s = await consume(opts(k, p));
  assert.equal(s.authenticated, false);
  assert.equal(p.location.hash, "");
});

test("every failure is a distinct reason, and nothing throws", async () => {
  // A paywall has to BRANCH: "expired, offer a fresh link" and "forged, show
  // nothing" are different product decisions. Branching on message text breaks
  // the first time a dependency rewords an error.
  const k = await keys();
  const cases: [string, string][] = [
    [await mint(k.other), "bad_signature"],
    [await mint(k.privateKey, {}, -60), "expired"],
    [await mint(k.privateKey, { scope: "account:write" }), "wrong_scope"],
    [await mint(k.privateKey, { amr: ["password"] }), "missing_claim"],
    [await mint(k.privateKey, { entitlement: "platinum" }), "missing_claim"],
    [await mint(k.privateKey, { external_sub: "" }), "missing_claim"],
    ["not-a-jwt-at-all", "malformed"],
  ];

  for (const [token, reason] of cases) {
    const p = page(`#tok=${token}`);
    const s = await consume(opts(k, p));
    assert.equal(s.authenticated, false, reason);
    assert.equal(s.reason, reason, `token classified as ${s.reason}`);
    assert.equal(s.subscriberId, undefined, "a refused token leaks no identity");
  }
});

test("a token for another site is refused as wrong_audience", async () => {
  // The audience check is what stops a token minted for one operator's site
  // being replayed against another's.
  const k = await keys();
  const p = page(`#tok=${await mint(k.privateKey)}`);
  const s = await consume({ ...opts(k, p), audience: "https://someone-else.example" });
  assert.equal(s.reason, "wrong_audience");
});

test("no token at all is 'no_token', not an error", async () => {
  const k = await keys();
  const s = await consume(opts(k, page()));
  assert.equal(s.authenticated, false);
  assert.equal(s.reason, "no_token");
});

test("verification makes no network call", async () => {
  // The whole point of signing entitlement into the token: a CDN-cached page
  // decides access with no request to addressium. A fetch here would also mean
  // the paywall breaks whenever addressium is slow or down.
  const k = await keys();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("the drop-in must not call the network");
  }) as typeof fetch;
  try {
    const p = page(`#tok=${await mint(k.privateKey)}`);
    assert.equal((await consume(opts(k, p))).authenticated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a session survives an in-site navigation without the token", async () => {
  const k = await keys();
  const first = page(`#tok=${await mint(k.privateKey)}`);
  await consume(opts(k, first));

  // Same tab, next article, no token in the URL — the storage carries over.
  const next = page();
  next.store.set(
    "addressium.magiclink.session",
    first.store.get("addressium.magiclink.session")!,
  );
  const s = await consume(opts(k, next));
  assert.equal(s.authenticated, true);
  assert.equal(s.reason, "restored", "distinguishable from a fresh verification");
  assert.equal(s.subscriberId, "addressium-sub-1");
});

test("a cached session expires exactly when its token did", async () => {
  // The cache is a copy of a verified result, not evidence. Anyone who edits
  // sessionStorage to extend it has fooled only their own browser — nothing
  // server-side ever trusted it — but it must still not outlive the token.
  const k = await keys();
  const p = page(`#tok=${await mint(k.privateKey, {}, 60)}`);
  const live = await consume(opts(k, p));
  const expiry = Date.parse(live.expiresAt!);

  const after = page();
  after.store.set("addressium.magiclink.session", p.store.get("addressium.magiclink.session")!);
  const s = currentSession({ storage: after.storage, now: () => expiry + 1 });
  assert.equal(s.authenticated, false);
  assert.equal(after.store.size, 0, "and the stale entry is dropped, not left to be found again");
});

test("a refused token invalidates whatever was cached", async () => {
  // A reader whose entitlement was revoked must not keep reading on a session
  // the previous token left behind.
  const k = await keys();
  const p = page(`#tok=${await mint(k.privateKey)}`);
  assert.equal((await consume(opts(k, p))).authenticated, true);
  assert.equal(p.store.size, 1);

  p.location.hash = `#tok=${await mint(k.other)}`;
  const s = await consume(opts(k, p));
  assert.equal(s.authenticated, false);
  assert.equal(p.store.size, 0);
});

test("a tampered cache entry is discarded rather than trusted", async () => {
  const k = await keys();
  const p = page();
  for (const bad of [
    "{ not json",
    JSON.stringify({ authenticated: true, entitlement: "paid" }), // no expiry
    JSON.stringify({ authenticated: true, expiresAt: "2020-01-01T00:00:00Z" }),
  ]) {
    p.store.set("addressium.magiclink.session", bad);
    assert.equal(currentSession({ storage: p.storage }).authenticated, false, bad);
  }
});

test("clearSession forgets the reader", async () => {
  const k = await keys();
  const p = page(`#tok=${await mint(k.privateKey)}`);
  await consume(opts(k, p));
  clearSession({ storage: p.storage });
  assert.equal(currentSession({ storage: p.storage }).authenticated, false);
});

test("caching can be turned off entirely", async () => {
  // A site with its own session layer should not have a second copy of the
  // reader's identity sitting in storage it did not ask for.
  const k = await keys();
  const p = page(`#tok=${await mint(k.privateKey)}`);
  const s = await consume(opts(k, p, { cache: false }));
  assert.equal(s.authenticated, true);
  assert.equal(p.store.size, 0);
});

test("storage being unavailable degrades to no cache, not to no session", async () => {
  // Private browsing and blocked third-party storage both throw on setItem.
  const k = await keys();
  const p = page(`#tok=${await mint(k.privateKey)}`);
  const hostile = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  const s: MagicLinkSession = await consume(opts(k, p, { storage: hostile }));
  assert.equal(s.authenticated, true);
});

test("the URL helpers are exported, because a site may want to do this itself", () => {
  assert.equal(readToken("#tok=abc"), "abc");
  assert.equal(readToken("tok=abc"), "abc", "with or without the leading #");
  assert.equal(readToken("#other=1"), undefined);
  assert.equal(readToken("#tok="), undefined, "an empty token is no token");
  assert.equal(readToken("#magic=abc", "magic"), "abc");

  assert.equal(stripTokenFromUrl("https://x.example/a#tok=abc"), "https://x.example/a");
  assert.equal(stripTokenFromUrl("https://x.example/a"), "https://x.example/a");
  assert.equal(stripTokenFromUrl("https://x.example/a#b=1"), "https://x.example/a#b=1");
  assert.equal(stripTokenFromUrl("https://x.example/a?q=1#tok=abc"), "https://x.example/a?q=1");
});

/**
 * The bundle (#215).
 *
 * "Drop-in" is a claim about the artifact, not the source. These load the built
 * file the way a site would — from outside the workspace, with no node_modules
 * to resolve `jose` from — because a bundle that only works next to its own
 * dependencies is exactly the thing the issue says we keep shipping.
 */
const DIST = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = "packages/magiclink-verify/dist";
  for (let i = 0; i < 8 && !existsSync(resolve(dir, rel)); i++) dir = resolve(dir, "..");
  return resolve(dir, rel);
})();

test("the ESM bundle carries its dependencies — no bare imports survive", () => {
  const src = readFileSync(resolve(DIST, "addressium-magiclink.esm.js"), "utf8");
  // A surviving `from "jose"` means the site still needs npm and a bundler,
  // which is the entire gap this was built to close.
  assert.doesNotMatch(src, /\bfrom\s*["']jose["']/);
  assert.doesNotMatch(src, /\brequire\s*\(\s*["']jose["']\s*\)/);
  // And no accidental Node dependency: this has to run in a browser.
  assert.doesNotMatch(src, /["']node:[a-z]+["']/);
});

test("the IIFE bundle exposes exactly the documented surface", () => {
  const src = readFileSync(resolve(DIST, "addressium-magiclink.iife.js"), "utf8");
  assert.match(src, /addressiumMagicLink/, "the global a <script> tag would use");
  for (const name of ["consume", "currentSession", "clearSession", "readToken"]) {
    assert.ok(src.includes(name), `${name} must be reachable from the global`);
  }
});

test("an SRI hash is published, and it matches the bytes", async () => {
  // A third-party script tag without `integrity` is a standing supply-chain
  // hole: whoever can change the file can read every subscriber id on the page.
  for (const name of ["addressium-magiclink.esm.js", "addressium-magiclink.iife.js"]) {
    const bytes = readFileSync(resolve(DIST, name));
    const published = readFileSync(resolve(DIST, `${name}.sri`), "utf8").trim();
    const { createHash } = await import("node:crypto");
    assert.equal(published, `sha384-${createHash("sha384").update(bytes).digest("base64")}`);
  }
});

test("the built bundle verifies a real token from outside the workspace", async () => {
  // Copied somewhere with no node_modules and imported by absolute path — the
  // closest thing to "a static file on someone else's web server" that a Node
  // test can reach.
  const { mkdtemp, copyFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(resolve(tmpdir(), "addressium-dropin-"));
  const dest = resolve(dir, "addressium-magiclink.esm.js");
  await copyFile(resolve(DIST, "addressium-magiclink.esm.js"), dest);

  const mod = (await import(pathToFileURL(dest).href)) as {
    consume: typeof consume;
  };
  const k = await keys();
  const p = page(`#tok=${await mint(k.privateKey)}`);
  const session = await mod.consume(opts(k, p));

  assert.equal(session.authenticated, true);
  assert.equal(session.entitlement, "paid");
  assert.equal(p.location.hash, "", "and it still cleans the URL");
});
