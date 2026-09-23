/**
 * Reject at import what SES rejects at send (#293).
 *
 * The import paths accepted anything containing an `@`, so `a@@b` and `a@`
 * reached the send path from real uploaded lists. The sender now survives them
 * — it records a `reject` and carries on — but a permanently-unsendable address
 * left on a list rejects on EVERY edition: one SES call and one `reject` event
 * every morning, for ever. Enough of them and `RecipientRejectAlarm` fires on
 * every send and gets muted.
 *
 * The risk in the other direction is worse, which is why the admitted set is
 * deliberately generous: a stricter-than-RFC check silently drops real
 * subscribers, and nobody finds out until they ask why they stopped receiving
 * the newsletter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isSendableEmail } from "@addressium/domain";

test("rejects exactly what live SES rejected", () => {
  // These two strings are the probes run against SES in us-east-1 (2026-09-23):
  //   nobody@@invalid.example -> BadRequestException "Domain contains illegal character"
  //   trailing@               -> BadRequestException "Missing domain"
  for (const bad of ["nobody@@invalid.example", "trailing@"]) {
    assert.equal(isSendableEmail(bad), false, `${bad} must be rejected at import`);
  }
});

test("rejects the other undeliverable shapes", () => {
  for (const bad of [
    "", "   ", "no-at-sign.example.com",
    "@nolocal.example",        // empty local part
    "a@b",                     // no dot: not a routable public domain
    "a@.b.example", "a@b.example.", "a@b..example",  // empty label
    "a@-b.example", "a@b-.example",                   // leading/trailing hyphen
    "two@at@example.com",
    "spa ce@example.com", "a<b@example.com", "a,b@example.com",
    `${"x".repeat(65)}@example.com`,  // local part over 64
    `${"x".repeat(250)}@example.com`, // whole address over 254
  ]) {
    assert.equal(isSendableEmail(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("admits the addresses real subscriber lists actually contain", () => {
  // The expensive failure direction. Each of these is ordinary and must survive
  // an import — a false reject silently drops a real person from the list.
  for (const good of [
    "reader@example.com",
    "first.last@example.com",
    "first+newsletter@example.com",          // plus-addressing is common
    "first_last@example.co.uk",
    "a@b.io",                                // short but routable
    "1234@example.com",                      // all-numeric local part
    "o'brien@example.com",                   // apostrophes are legal
    "user-name@sub.domain.example.com",
    "MiXeD@Example.COM",                     // case is not our business
    "  padded@example.com  ",                // callers trim; so do we
  ]) {
    assert.equal(isSendableEmail(good), true, `${good} must be accepted`);
  }
});
