/**
 * Regression (#170): /signup/batch had honeypot + reCAPTCHA protection while
 * /signup — the primary, most-embedded signup path — had neither. An
 * unprotected signup endpoint is a list-poisoning and confirmation-spam vector:
 * every submission sends real mail to an attacker-chosen address, burning the
 * org's own SES sender reputation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HONEYPOT_FIELD } from "@addressium/core";
import { isHoneypotTripped } from "@addressium/domain";

test("the honeypot trips on a filled hidden field", () => {
  assert.equal(isHoneypotTripped({ website: "http://spam.example" }), true);
  assert.equal(isHoneypotTripped({ website: "   x  " }), true, "whitespace-padded still counts");
});

test("a normal submission does not trip the honeypot", () => {
  assert.equal(isHoneypotTripped({ orgId: "acme", listId: "l", email: "a@x.example" }), false);
  assert.equal(isHoneypotTripped({ website: "" }), false, "an empty hidden field is a real user");
  assert.equal(isHoneypotTripped({ website: "   " }), false, "whitespace-only is empty");
  assert.equal(isHoneypotTripped({}), false);
});

test("the trap field name is configurable, so a bot can't hardcode one name", () => {
  assert.equal(isHoneypotTripped({ fax: "spam" }, "fax"), true);
  // ...and the default name is not consulted when another is configured.
  assert.equal(isHoneypotTripped({ website: "spam" }, "fax"), false);
});

/**
 * Client/server agreement on the trap's name (#230).
 *
 * A honeypot whose field name drifts fails OPEN: the check simply stops
 * matching, every bot sails through, and because a caught bot is answered with
 * a silent 202 there is no signal that anything changed. The React clients
 * import the constant, so they cannot drift. `embed.js` is a plain static
 * script served as-is with no build step and cannot import anything — so this is
 * the only thing standing between it and a silent regression.
 */
test("embed.js renders the same trap field the server checks", () => {
  // Walked up rather than resolved relatively: this file runs from dist/test/,
  // whose depth differs from the source tree's.
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = "apps/public-web/public/embed.js";
  for (let i = 0; i < 8 && !existsSync(resolve(dir, rel)); i++) dir = resolve(dir, "..");
  const embed = readFileSync(resolve(dir, rel), "utf8");
  assert.match(
    embed,
    new RegExp(`hp\\.name\\s*=\\s*["']${HONEYPOT_FIELD}["']`),
    `embed.js must name its trap field "${HONEYPOT_FIELD}" — @addressium/core is the source of truth`,
  );
  // ...and actually send it, which is the half a rename would not catch.
  assert.match(embed, new RegExp(`${HONEYPOT_FIELD}\\s*:\\s*hp\\.value`));
  // Off-screen, not display:none — a bot that skips obviously hidden inputs
  // still fills this one, and aria-hidden/tabindex keep humans out instead.
  assert.match(embed, /position:\s*absolute/);
  assert.match(embed, /tabindex/i);
  assert.match(embed, /aria-hidden/i);
});

test("the default the server checks IS the shared constant", () => {
  // Belt and braces: if someone reintroduces a literal in botcheck.ts, the
  // clients keep sending `website` and the check silently looks elsewhere.
  assert.equal(isHoneypotTripped({ [HONEYPOT_FIELD]: "x" }), true);
});
