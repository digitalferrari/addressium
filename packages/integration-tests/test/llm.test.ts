/**
 * HttpLlmAdvisor hardening (#50): retry/backoff/deadline behavior is exercised
 * with an injected fetch, a no-op sleep, deterministic jitter, and a fake clock,
 * so the tests are network-free and instant. We assert: succeeds-after-retry,
 * gives-up-after-max, fast-fail-on-4xx, timeout-is-retried, Retry-After is
 * honored, the response is size-capped, and the API key never leaks into errors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HttpLlmAdvisor, LlmAdvisorError } from "@addressium/adapters-aws";
import type { AiConfig } from "@addressium/core";

const CONFIG: AiConfig = { vendor: "anthropic", model: "claude-x", apiKeySecretArn: "arn:aws:secretsmanager:us-east-1:0:secret:llm" };
const KEY = "sk-super-secret-key";

function ok(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}
function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response("{}", { status: code, headers });
}
const anthropicBody = (text: string) => ({ content: [{ text }] });

/** Deterministic deps: no real waiting, jitter=0, controllable clock. Records sleeps. */
function deps(responses: Array<() => Promise<Response> | Response>) {
  const sleeps: number[] = [];
  let clock = 0;
  let i = 0;
  return {
    sleeps,
    advance: (ms: number) => { clock += ms; },
    opts: {
      fetch: (async () => {
        const next = responses[Math.min(i, responses.length - 1)]!;
        i += 1;
        return next();
      }) as unknown as typeof fetch,
      sleep: async (ms: number) => { sleeps.push(ms); },
      rng: () => 0,
      now: () => clock,
    },
    calls: () => i,
  };
}

test("succeeds after transient 429s (retries, then returns the analysis)", async () => {
  const d = deps([() => status(429), () => status(429), () => ok(anthropicBody("Good open rate."))]);
  const advisor = new HttpLlmAdvisor(CONFIG, KEY, d.opts);
  const res = await advisor.analyze("prompt");
  assert.equal(res.text, "Good open rate.");
  assert.equal(res.vendor, "anthropic");
  assert.equal(d.calls(), 3); // two failures + one success
  assert.equal(d.sleeps.length, 2); // one backoff before each retry
});

test("gives up after maxAttempts on persistent 5xx and throws a typed retryable error", async () => {
  const d = deps([() => status(503)]);
  const advisor = new HttpLlmAdvisor(CONFIG, KEY, { ...d.opts, policy: { maxAttempts: 3 } });
  await assert.rejects(
    () => advisor.analyze("prompt"),
    (e: unknown) => {
      assert.ok(e instanceof LlmAdvisorError);
      assert.equal(e.vendor, "anthropic");
      assert.equal(e.status, 503);
      assert.equal(e.attempts, 3);
      assert.equal(e.retryable, true);
      return true;
    },
  );
  assert.equal(d.calls(), 3);
});

test("fails fast on a non-retryable 4xx (no retries)", async () => {
  const d = deps([() => status(401)]);
  const advisor = new HttpLlmAdvisor(CONFIG, KEY, d.opts);
  await assert.rejects(
    () => advisor.analyze("prompt"),
    (e: unknown) => e instanceof LlmAdvisorError && e.status === 401 && e.retryable === false && e.attempts === 1,
  );
  assert.equal(d.calls(), 1); // no retry
  assert.equal(d.sleeps.length, 0);
});

test("retries a timeout/abort throw", async () => {
  const timeout = () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
  const d = deps([timeout, () => ok(anthropicBody("Recovered."))]);
  const advisor = new HttpLlmAdvisor(CONFIG, KEY, d.opts);
  const res = await advisor.analyze("prompt");
  assert.equal(res.text, "Recovered.");
  assert.equal(d.calls(), 2);
});

test("honors Retry-After (seconds) over computed backoff", async () => {
  const d = deps([() => status(429, { "retry-after": "5" }), () => ok(anthropicBody("ok"))]);
  const advisor = new HttpLlmAdvisor(CONFIG, KEY, d.opts);
  await advisor.analyze("prompt");
  assert.deepEqual(d.sleeps, [5000]); // 5s from the header, not the base backoff
});

test("stops once the overall deadline is exhausted", async () => {
  const d = deps([() => status(500)]);
  // Each attempt advances the clock past the deadline via the fetch side effect.
  const opts = {
    ...d.opts,
    fetch: (async () => { d.advance(30_000); return status(500); }) as unknown as typeof fetch,
    policy: { maxAttempts: 10, overallDeadlineMs: 45_000 },
  };
  const advisor = new HttpLlmAdvisor(CONFIG, KEY, opts);
  await assert.rejects(() => advisor.analyze("prompt"), LlmAdvisorError);
  assert.ok(d.calls() < 10, `expected the deadline to stop retries early, got ${d.calls()} calls`);
});

test("caps an oversized response body", async () => {
  const huge = new Response("x".repeat(50), { status: 200, headers: { "content-type": "application/json" } });
  const advisor = new HttpLlmAdvisor(CONFIG, KEY, { ...deps([() => huge]).opts, maxResponseBytes: 10 });
  await assert.rejects(
    () => advisor.analyze("prompt"),
    (e: unknown) => e instanceof LlmAdvisorError && e.retryable === false && /exceeds 10 bytes/.test(e.message),
  );
});

test("the API key never appears in a thrown error", async () => {
  const d = deps([() => status(500)]);
  const advisor = new HttpLlmAdvisor(CONFIG, KEY, { ...d.opts, policy: { maxAttempts: 2 } });
  const err = await advisor.analyze("prompt").catch((e: Error) => e);
  assert.ok(err instanceof LlmAdvisorError);
  assert.equal(JSON.stringify({ m: err.message, ...err }).includes(KEY), false);
});
