/**
 * GoogleRecaptchaVerifier (#62): verifies against siteverify with an injected
 * fetch — success passes, failure/low-score/empty-token/network-error fail closed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GoogleRecaptchaVerifier } from "@addressium/adapters-aws";

function fetchReturning(payload: unknown, ok = true): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
}

test("passes when siteverify reports success", async () => {
  const v = new GoogleRecaptchaVerifier("secret", fetchReturning({ success: true }));
  assert.equal(await v.verify("tok"), true);
});

test("fails when siteverify reports failure", async () => {
  const v = new GoogleRecaptchaVerifier("secret", fetchReturning({ success: false, "error-codes": ["invalid-input-response"] }));
  assert.equal(await v.verify("tok"), false);
});

test("fails a low v3 score even if success is true", async () => {
  const v = new GoogleRecaptchaVerifier("secret", fetchReturning({ success: true, score: 0.1 }));
  assert.equal(await v.verify("tok"), false);
});

test("passes a high v3 score", async () => {
  const v = new GoogleRecaptchaVerifier("secret", fetchReturning({ success: true, score: 0.9 }));
  assert.equal(await v.verify("tok"), true);
});

test("empty token fails without calling the network", async () => {
  let called = false;
  const v = new GoogleRecaptchaVerifier("secret", (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch);
  assert.equal(await v.verify(""), false);
  assert.equal(called, false);
});

test("network error fails closed", async () => {
  const v = new GoogleRecaptchaVerifier("secret", (async () => { throw new Error("boom"); }) as unknown as typeof fetch);
  assert.equal(await v.verify("tok"), false);
});
