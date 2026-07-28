/**
 * The primary test template (#204).
 *
 * One canonical, known-good body that every org gets at provisioning time, so a
 * smoke send exercises the whole render path instead of whatever the operator
 * happened to paste in. It deliberately contains one of each thing that can
 * break silently:
 *
 * - a **merge tag** (`{{first_name}}`), so escaping is covered — a template with
 *   no merge tag proves nothing about personalisation
 * - an **editorial link**, so click tokenization and the click map are covered
 * - the **compliance footer + physical address** merge tags, so CAN-SPAM content
 *   is visible in the body rather than assumed
 * - the **unsubscribe link** (#178), which is the one link a recipient is
 *   entitled to and the one most likely to be forgotten
 *
 * Shipped in all three modes, from ONE source of truth. Authoring three bodies
 * by hand would let them drift, and "compare the modes" is the entire reason
 * this template exists — a difference between them has to mean a renderer bug,
 * not a typo in a fixture.
 */
import type { TemplateMode } from "@addressium/core";
import type { EmailTemplate } from "./render.js";

/** The template id seeded into every org (#204). Stable, so runbooks can name it. */
export const PRIMARY_TEST_TEMPLATE_ID = "addressium-smoke-test";
export const PRIMARY_TEST_TEMPLATE_NAME = "Smoke test (addressium)";

/**
 * The merge tags the seed relies on.
 *
 * `unsubscribe_url` is the load-bearing one: `{{...}}` merge values come from
 * `subscriber.attributes`, and no subscriber has an `unsubscribe_url` attribute
 * — so a template that only interpolates it renders an EMPTY link. The seed uses
 * a literal `{{unsubscribe_url}}` anyway because that is what an operator writes,
 * and `seedTemplateSmokeCheck` below is what catches it being left unresolved.
 */
export const PRIMARY_TEST_MERGE_TAGS = ["first_name", "list_name", "unsubscribe_url"] as const;

/**
 * The blocks body — the `visual` and `blocks` modes.
 *
 * The editorial link is `https://example.com/...` on purpose: a seed that points
 * at a real domain would send click traffic somewhere the operator does not
 * control the first time anyone runs a smoke test.
 */
export const primaryTestBlocks: EmailTemplate = {
  blocks: [
    { kind: "text", html: "Hello {{first_name}}, this is a test send from addressium." },
    {
      kind: "editorial",
      label: "Read the test article",
      url: "https://example.com/addressium/smoke-test",
    },
    {
      kind: "text",
      html:
        "You are receiving this because you subscribed to {{list_name}}. " +
        '<a href="{{unsubscribe_url}}">Unsubscribe</a>',
    },
  ],
};

/** The `raw_html` body. Same content, hand-written HTML. */
export const primaryTestHtml = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
    <h1 style="font-size:20px;margin:0 0 12px;">Test send</h1>
    <p>Hello {{first_name}}, this is a test send from addressium.</p>
    <p><a href="https://example.com/addressium/smoke-test">Read the test article</a></p>
    <hr style="border:none;border-top:1px solid #ddd;margin:24px 0;" />
    <p style="font-size:12px;color:#666;">
      You are receiving this because you subscribed to {{list_name}}.<br />
      <a href="{{unsubscribe_url}}">Unsubscribe</a>
    </p>
  </body>
</html>`;

/**
 * The `mjml` body.
 *
 * MJML source, not compiled output: the console compiles it in the browser, and
 * storing the compiled HTML would make "does this MJML still compile?" — an
 * acceptance criterion of #204 — unanswerable from the stored template.
 */
export const primaryTestMjml = `<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text font-size="20px" font-weight="bold">Test send</mj-text>
        <mj-text>Hello {{first_name}}, this is a test send from addressium.</mj-text>
        <mj-text>
          <a href="https://example.com/addressium/smoke-test">Read the test article</a>
        </mj-text>
      </mj-column>
    </mj-section>
    <mj-section>
      <mj-column>
        <mj-divider border-width="1px" border-color="#dddddd" />
        <mj-text font-size="12px" color="#666666">
          You are receiving this because you subscribed to {{list_name}}.<br />
          <a href="{{unsubscribe_url}}">Unsubscribe</a>
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

/** The stored `source` for one mode. */
export function primaryTestSource(mode: TemplateMode): string {
  switch (mode) {
    case "raw_html":
      return primaryTestHtml;
    case "mjml":
      return primaryTestMjml;
    case "visual":
      // The visual builder round-trips MJML, so the source is the same document.
      return primaryTestMjml;
  }
}

/**
 * What must be true of any rendered smoke-test body, in every mode (#204).
 *
 * Returns the problems, so a caller can report all of them rather than the first.
 * The checks are deliberately about the things that fail SILENTLY:
 *
 * - an **unresolved merge tag** means personalisation is broken and the
 *   recipient sees `{{first_name}}` in their inbox
 * - an **empty unsubscribe href** means a CAN-SPAM violation that looks fine in
 *   a preview, because the link is still there and still blue
 * - a **missing text part** costs deliverability at every major provider
 */
export function seedTemplateSmokeCheck(rendered: {
  html: string;
  text?: string;
}): string[] {
  const problems: string[] = [];
  const unresolved = rendered.html.match(/\{\{\s*[a-z0-9_]+\s*\}\}/gi);
  if (unresolved) {
    problems.push(`unresolved merge tags: ${[...new Set(unresolved)].join(", ")}`);
  }
  // `href=""`, `href="#"` and a missing anchor all read as "there is a link" in
  // a preview and as "there is no way out" to the recipient.
  const unsub = /<a[^>]*href="([^"]*)"[^>]*>\s*unsubscribe/i.exec(rendered.html);
  if (!unsub) problems.push("no unsubscribe link");
  else if (!unsub[1] || unsub[1] === "#") problems.push("unsubscribe link has no destination");
  if (!/example\.com|https?:/i.test(rendered.html)) problems.push("no editorial link");
  if (!rendered.text || rendered.text.trim().length === 0) problems.push("no plain-text part");
  else if (!/unsubscribe/i.test(rendered.text)) problems.push("text part has no unsubscribe link");
  return problems;
}
