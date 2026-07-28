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
import { HONEYPOT_FIELD } from "@addressium/core";


/**
 * True when the honeypot field is filled — i.e. a bot. Humans never see the field.
 *
 * The default name comes from `@addressium/core` rather than a literal here
 * (#230): the check and every client that renders the trap must agree, and a
 * mismatch fails OPEN — the trap quietly stops catching anything, and because a
 * caught bot is answered with a silent 202, nothing reports the difference.
 */
export function isHoneypotTripped(
  fields: Record<string, unknown>,
  fieldName: string = HONEYPOT_FIELD,
): boolean {
  const v = fields[fieldName];
  return typeof v === "string" && v.trim() !== "";
}

/** Verifies a CAPTCHA token (e.g. reCAPTCHA siteverify). Injected so it's optional + testable. */
export interface CaptchaVerifier {
  verify(token: string): Promise<boolean>;
}
