/**
 * The confirmation-token keyring (#234).
 *
 * `ConfirmSecret` signs two things that sit in people's inboxes for years: the
 * double opt-in link, and the RFC 8058 one-click unsubscribe link that is in
 * every message ever sent and that the law requires to keep working. With a
 * single-key signer, rotating the secret invalidated all of them at the instant
 * of rotation — so the secret was, in any practical sense, unrotatable.
 *
 * These tests are about ONE property above all others: rotation must not orphan
 * a link already in an inbox.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  HmacConfirmationSigner,
  RetiredKeyError,
  TokenExpiredError,
  deriveKid,
  parseKeyring,
  rotateKeyring,
  serializeKeyring,
} from "@addressium/domain";

const far = () => Math.floor(Date.now() / 1000) + 60 * 60;
const claims = (over: Record<string, unknown> = {}) => ({
  orgId: "summit",
  sub: "s-1",
  listId: "ledger",
  exp: far(),
  ...over,
});

// ---- the property this exists for ----

test("a link signed before a rotation still works after it", async () => {
  const before = new HmacConfirmationSigner("k1");
  const oldLink = before.sign(claims());

  const after = new HmacConfirmationSigner(rotateKeyring(parseKeyring("k1"), "k2"));
  assert.equal(after.verify(oldLink).sub, "s-1");
  // …and the new key is what NEW links get signed with.
  assert.notEqual(after.activeKid, before.activeKid);
  assert.equal(after.verify(after.sign(claims())).sub, "s-1");
});

test("links survive several rotations, not just one", async () => {
  // The unsubscribe token TTL is five years. At yearly rotation that is five
  // rotations a link has to outlive, so "keeps the previous key" is not enough —
  // rotation must never DROP.
  let ring = parseKeyring("k0");
  const oldest = new HmacConfirmationSigner(ring).sign(claims());
  for (const k of ["k1", "k2", "k3", "k4", "k5"]) ring = rotateKeyring(ring, k);
  assert.equal(new HmacConfirmationSigner(ring).verify(oldest).sub, "s-1");
  assert.equal(ring.length, 6);
});

test("rotation puts the new key FIRST — signing follows the ring order", async () => {
  const ring = rotateKeyring(parseKeyring("k1"), "k2");
  assert.equal(ring[0]!.kid, deriveKid("k2"));
  assert.equal(new HmacConfirmationSigner(ring).activeKid, deriveKid("k2"));
});

// ---- and the failures it has to distinguish ----

test("a token from a RETIRED key is distinguishable from a forgery", async () => {
  // Both are HMAC failures. One is an attack; the other is our own retirement
  // decision arriving in somebody's inbox, and telling that person "invalid
  // link" while they try to exercise a legal right is the outcome to avoid.
  const retired = new HmacConfirmationSigner("k1").sign(claims());
  const current = new HmacConfirmationSigner("k2");
  assert.throws(() => current.verify(retired), RetiredKeyError);

  // A forged signature under a kid we DO hold is an ordinary bad signature.
  const good = current.sign(claims());
  const [kid, body] = good.split(".");
  assert.throws(
    () => current.verify(`${kid}.${body}.AAAA`),
    (e: Error) => !(e instanceof RetiredKeyError) && /signature/.test(e.message),
  );
});

test("an expired token is its own error, not a signature failure", async () => {
  const signer = new HmacConfirmationSigner("k1");
  const token = signer.sign(claims({ exp: Math.floor(Date.now() / 1000) - 1 }));
  assert.throws(() => signer.verify(token), TokenExpiredError);
});

test("the kid is signed, so it cannot be swapped to steer verification", async () => {
  // Two keys in the ring. Take a token minted under key A and relabel it as key
  // B: if the kid were only a routing prefix, this would be a way to probe
  // verification against a key of the attacker's choosing.
  const ring = rotateKeyring(parseKeyring("k1"), "k2");
  const signer = new HmacConfirmationSigner(ring);
  const token = signer.sign(claims());
  const [, body, sig] = token.split(".");
  const otherKid = signer.acceptedKids.find((k) => k !== signer.activeKid)!;
  assert.throws(() => signer.verify(`${otherKid}.${body}.${sig}`), /signature/);
});

test("malformed tokens are rejected without a stack trace's worth of guessing", async () => {
  const signer = new HmacConfirmationSigner("k1");
  for (const bad of ["", ".", "a.b", "a.b.c.d", "..", "a..c"]) {
    assert.throws(() => signer.verify(bad), /malformed|signature|retired/i, `accepted ${JSON.stringify(bad)}`);
  }
});

// ---- the secret's own shape ----

test("a bare secret string still works — that is the first deploy", async () => {
  // CloudFormation generates a random string on the very first deploy, before
  // anything has rotated. A fresh install has to work with no rotation
  // infrastructure in place at all.
  const ring = parseKeyring("a-random-generated-value");
  assert.equal(ring.length, 1);
  assert.equal(ring[0]!.secret, "a-random-generated-value");
  assert.equal(ring[0]!.kid, deriveKid("a-random-generated-value"));
});

test("a keyring round-trips through Secrets Manager's string value", async () => {
  const ring = rotateKeyring(parseKeyring("k1"), "k2");
  const parsed = parseKeyring(serializeKeyring(ring));
  assert.deepEqual(parsed, ring);
});

test("a MALFORMED keyring throws rather than degrading to one key", async () => {
  // The tempting fallback — "if it doesn't parse, treat the whole blob as the
  // secret" — appears to work: it produces a signer and new links verify. It
  // also silently orphans every token ever issued, which is the exact failure
  // this issue exists to prevent. Loud beats plausible.
  for (const bad of ['{"keys":[]}', '{"keys":"nope"}', '{"nope":1}', '{"keys":[{"kid":"a"}]}']) {
    assert.throws(() => parseKeyring(bad), /keyring|secret/i, `accepted ${bad}`);
  }
  assert.throws(() => parseKeyring("   "), /empty/);
});

test("re-rotating to the same material does not shadow the ring", async () => {
  // Identical material yields an identical kid. Left unhandled it appears twice
  // in the ring and the second entry is unreachable in the lookup map — a key
  // that looks retained and is not.
  const ring = rotateKeyring(rotateKeyring(parseKeyring("k1"), "k2"), "k2");
  assert.deepEqual(
    ring.map((k) => k.kid),
    [deriveKid("k2"), deriveKid("k1")],
  );
});
