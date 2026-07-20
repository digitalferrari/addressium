/**
 * Provider-agnostic LLM advisor for campaign analytics (§4.8, #32; hardened #50).
 *
 * One adapter, three vendors (Anthropic / OpenAI / Gemini): the request shape +
 * response extraction differ per vendor, but callers just get an AnalysisResult.
 * The API key is passed in (resolved from Secrets Manager by the service), never
 * stored beyond the call and never placed in an error message or log.
 *
 * Hardening (#50): transient failures (429, 5xx, network resets, timeouts) are
 * retried with exponential backoff + jitter, honoring `Retry-After`, bounded by
 * both a per-attempt timeout and an overall deadline. Non-retryable 4xx fail
 * fast. Failures surface as a typed {@link LlmAdvisorError}. The response body is
 * read with a hard size cap. `fetch`, `sleep`, `rng` and `now` are injectable so
 * the retry/timeout behavior is unit-testable without real network or timers.
 */
import type { AiConfig, AiVendor } from "@addressium/core";
import type { AnalysisResult, AnalyticsAdvisor } from "@addressium/domain";

/** Bounds on a single advisor call. All values are milliseconds unless noted. */
export interface RetryPolicy {
  /** Total attempts including the first (default 4). */
  maxAttempts: number;
  /** Base backoff before jitter (default 500). */
  baseDelayMs: number;
  /** Backoff ceiling per wait, and the cap applied to `Retry-After` (default 8000). */
  maxDelayMs: number;
  /** Abort a single attempt after this long (default 20000). */
  perAttemptTimeoutMs: number;
  /** Give up once total elapsed time crosses this, even mid-backoff (default 45000). */
  overallDeadlineMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  perAttemptTimeoutMs: 20_000,
  overallDeadlineMs: 45_000,
};

/** 1 MiB is far more than any of these vendors return for a short analysis. */
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Typed failure carrying enough context for the handler to branch on. Never includes the API key. */
export class LlmAdvisorError extends Error {
  constructor(
    message: string,
    readonly vendor: AiVendor,
    readonly attempts: number,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmAdvisorError";
  }
}

export interface HttpLlmAdvisorDeps {
  /** Defaults to the global fetch. Injected in tests. */
  fetch?: typeof fetch;
  /** Defaults to a real timer. Injected in tests so backoff is instant. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0,1). Defaults to Math.random; inject for determinism. */
  rng?: () => number;
  /** Monotonic-ish clock for the overall deadline. Defaults to Date.now. */
  now?: () => number;
  policy?: Partial<RetryPolicy>;
  maxResponseBytes?: number;
}

interface VendorCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  extract(json: unknown): string;
}

function anthropicCall(model: string, key: string, prompt: string): VendorCall {
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: { model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] },
    extract: (j) => {
      const parts = (j as { content?: Array<{ text?: string }> }).content ?? [];
      return parts.map((p) => p.text ?? "").join("");
    },
  };
}

function openaiCall(model: string, key: string, prompt: string): VendorCall {
  return {
    url: "https://api.openai.com/v1/chat/completions",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: { model, messages: [{ role: "user", content: prompt }] },
    extract: (j) =>
      (j as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "",
  };
}

function geminiCall(model: string, key: string, prompt: string): VendorCall {
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    headers: { "content-type": "application/json" },
    body: { contents: [{ parts: [{ text: prompt }] }] },
    extract: (j) => {
      const parts =
        (j as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates?.[0]
          ?.content?.parts ?? [];
      return parts.map((p) => p.text ?? "").join("");
    },
  };
}

function callFor(vendor: AiVendor, model: string, key: string, prompt: string): VendorCall {
  switch (vendor) {
    case "anthropic":
      return anthropicCall(model, key, prompt);
    case "openai":
      return openaiCall(model, key, prompt);
    case "gemini":
      return geminiCall(model, key, prompt);
  }
}

/** A thrown fetch error is retryable when it looks like a network reset or an abort/timeout. */
function isRetryableThrow(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  return name === "AbortError" || name === "TimeoutError" || err instanceof TypeError;
}

/** `Retry-After` may be seconds or an HTTP date. Returns ms, or undefined if unusable. `now` keeps it testable. */
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/** Read the body with a hard byte cap so a hostile/huge response can't exhaust memory. */
async function readCapped(res: Response, max: number, vendor: AiVendor, attempts: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    throw new LlmAdvisorError(`LLM provider ${vendor} response exceeds ${max} bytes`, vendor, attempts, false, res.status);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > max) {
      throw new LlmAdvisorError(`LLM provider ${vendor} response exceeds ${max} bytes`, vendor, attempts, false, res.status);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new LlmAdvisorError(`LLM provider ${vendor} response exceeds ${max} bytes`, vendor, attempts, false, res.status);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpLlmAdvisor implements AnalyticsAdvisor {
  private readonly policy: RetryPolicy;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly config: AiConfig,
    private readonly apiKey: string,
    deps: HttpLlmAdvisorDeps = {},
  ) {
    this.policy = { ...DEFAULT_RETRY_POLICY, ...deps.policy };
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? realSleep;
    this.rng = deps.rng ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /** Backoff for the wait *before* attempt N (1-based): exponential, capped, with equal jitter. */
  private backoffMs(attempt: number): number {
    const exp = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(exp / 2 + this.rng() * (exp / 2));
  }

  async analyze(prompt: string): Promise<AnalysisResult> {
    const call = callFor(this.config.vendor, this.config.model, this.apiKey, prompt);
    const vendor = this.config.vendor;
    const start = this.now();
    let attempt = 0;
    let lastErr: LlmAdvisorError | undefined;

    while (attempt < this.policy.maxAttempts) {
      attempt += 1;
      let retryAfterMs: number | undefined;
      try {
        const res = await this.fetch(call.url, {
          method: "POST",
          headers: call.headers,
          body: JSON.stringify(call.body),
          signal: AbortSignal.timeout(this.policy.perAttemptTimeoutMs),
        });

        if (res.ok) {
          const text = await readCapped(res, this.maxResponseBytes, vendor, attempt);
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            throw new LlmAdvisorError(`LLM provider ${vendor} returned malformed JSON`, vendor, attempt, false, res.status);
          }
          return { vendor, model: this.config.model, text: call.extract(json) };
        }

        // Drain the error body (capped) so the connection can be reused; ignore its content.
        await readCapped(res, this.maxResponseBytes, vendor, attempt).catch(() => undefined);
        const retryable = RETRYABLE_STATUS.has(res.status);
        lastErr = new LlmAdvisorError(
          `LLM provider ${vendor} returned ${res.status}`,
          vendor,
          attempt,
          retryable,
          res.status,
        );
        if (!retryable) throw lastErr;
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), this.now());
      } catch (err) {
        if (err instanceof LlmAdvisorError) {
          if (!err.retryable) throw err;
          lastErr = err;
        } else if (isRetryableThrow(err)) {
          lastErr = new LlmAdvisorError(
            `LLM provider ${vendor} request failed: ${(err as Error).name || "network error"}`,
            vendor,
            attempt,
            true,
          );
        } else {
          throw err;
        }
      }

      if (attempt >= this.policy.maxAttempts) break;

      const elapsed = this.now() - start;
      const remaining = this.policy.overallDeadlineMs - elapsed;
      if (remaining <= 0) break;
      const wait = Math.min(remaining, retryAfterMs ?? this.backoffMs(attempt));
      await this.sleep(wait);
      if (this.now() - start >= this.policy.overallDeadlineMs) break;
    }

    throw (
      lastErr ??
      new LlmAdvisorError(`LLM provider ${vendor} failed after ${attempt} attempts`, vendor, attempt, true)
    );
  }
}
