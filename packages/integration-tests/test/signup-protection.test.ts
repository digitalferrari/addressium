/**
 * Regression (#170): /signup/batch had honeypot + reCAPTCHA protection while
 * /signup — the primary, most-embedded signup path — had neither. An
 * unprotected signup endpoint is a list-poisoning and confirmation-spam vector:
 * every submission sends real mail to an attacker-chosen address, burning the
 * org's own SES sender reputation.
 */
import test from "node:test";
import assert from "node:assert/strict";
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
