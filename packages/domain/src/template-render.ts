/**
 * Convert a stored `Template` into an `EmailTemplate` for the shared send
 * pipeline (#95). Used by drip steps (and any other server-side send that
 * references a template by id) so they render the operator's real template
 * instead of a placeholder body.
 *
 * Modes:
 *  - `raw_html`: the stored `source` is already hard-sanitized at save time, so
 *    it flows straight through as `{ html }` (the render pipeline still escapes
 *    merge tags and tokenizes `<a>` links per recipient).
 *  - `mjml` / `visual`: `source` is MJML. Campaigns compile MJML to HTML in the
 *    browser before scheduling; there is no server-side MJML compiler wired, so
 *    a drip step cannot render MJML on its own. We fail loudly rather than mail
 *    raw `<mjml>` tags. Use a `raw_html` template for drip steps (or pre-compile).
 */
import type { Template } from "@addressium/core";
import type { EmailTemplate } from "./render.js";

export class UnrenderableTemplateError extends Error {
  constructor(public readonly templateId: string, mode: string) {
    super(
      `template ${templateId} is "${mode}" — server-side MJML compilation isn't ` +
        `available for drip/automation sends; use a raw_html template or pre-compile it`,
    );
    this.name = "UnrenderableTemplateError";
  }
}

export function emailTemplateFromStored(template: Template): EmailTemplate {
  if (template.mode === "raw_html") return { html: template.source };
  throw new UnrenderableTemplateError(template.templateId, template.mode);
}
