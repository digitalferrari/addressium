/**
 * Google reCAPTCHA server-side verification (#62).
 *
 * Verifies the widget's token against Google's siteverify endpoint. `fetch` is
 * injectable so the verify logic is unit-testable without a network call, and a
 * timeout keeps a slow/unreachable Google from hanging the signup request.
 */
import type { CaptchaVerifier } from "@addressium/domain";

const SITEVERIFY = "https://www.google.com/recaptcha/api/siteverify";
const TIMEOUT_MS = 5_000;
/** v3 scores range 0..1; treat >= this as human. Ignored for v2 (no score). */
const MIN_SCORE = 0.5;

export class GoogleRecaptchaVerifier implements CaptchaVerifier {
  constructor(
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async verify(token: string): Promise<boolean> {
    if (!token) return false;
    const body = new URLSearchParams({ secret: this.secret, response: token }).toString();
    let res: Response;
    try {
      res = await this.fetchImpl(SITEVERIFY, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return false; // network/timeout → fail closed
    }
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: boolean; score?: number };
    return json.success === true && (json.score === undefined || json.score >= MIN_SCORE);
  }
}
