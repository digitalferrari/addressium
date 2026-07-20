/**
 * Provider-agnostic LLM advisor for campaign analytics (§4.8, #32).
 *
 * One adapter, three vendors (Anthropic / OpenAI / Gemini): the request shape +
 * response extraction differ per vendor, but callers just get an AnalysisResult.
 * The API key is passed in (resolved from Secrets Manager by the service), never
 * stored here. Timeouts + graceful failure so a provider outage degrades to an
 * error the handler can surface rather than hanging the request.
 */
import type { AiConfig, AiVendor } from "@addressium/core";
import type { AnalysisResult, AnalyticsAdvisor } from "@addressium/domain";

const TIMEOUT_MS = 20_000;

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

export class HttpLlmAdvisor implements AnalyticsAdvisor {
  constructor(
    private readonly config: AiConfig,
    private readonly apiKey: string,
  ) {}

  async analyze(prompt: string): Promise<AnalysisResult> {
    const call = callFor(this.config.vendor, this.config.model, this.apiKey, prompt);
    const res = await fetch(call.url, {
      method: "POST",
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`LLM provider ${this.config.vendor} returned ${res.status}`);
    }
    const text = call.extract(await res.json());
    return { vendor: this.config.vendor, model: this.config.model, text };
  }
}
