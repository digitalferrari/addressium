/**
 * Public-signup bot mitigation (#62).
 *
 * Two cheap, layered defenses for the unauthenticated embed/signup path:
 * - **Honeypot** — a hidden field bots fill and humans leave empty. A non-empty
 *   value means "bot"; the caller should silently accept (return success without
 *   doing anything) so scrapers can't tell they were caught.
 * - **CAPTCHA** — a human-interaction token (reCAPTCHA) verified server-side.
 *   The verifier is a port so it's injectable/optional (skipped when the org
 *   hasn't configured a secret) and unit-testable without calling Google.
 */

/** True when the honeypot field is filled — i.e. a bot. Humans never see the field. */
export function isHoneypotTripped(fields: Record<string, unknown>, fieldName = "website"): boolean {
  const v = fields[fieldName];
  return typeof v === "string" && v.trim() !== "";
}

/** Verifies a CAPTCHA token (e.g. reCAPTCHA siteverify). Injected so it's optional + testable. */
export interface CaptchaVerifier {
  verify(token: string): Promise<boolean>;
}
