/**
 * Transactional (double opt-in) confirmation emails. These are 1:1 system mail:
 * they carry a plain-text alternative part and a mailto-only List-Unsubscribe
 * (which the SES adapter must NOT advertise as one-click — see the adapter test).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { List } from "@addressium/core";
import { buildConfirmationEmail, buildBatchConfirmationEmail } from "@addressium/domain";

const list = (overrides: Partial<List> = {}): List => ({
  orgId: "acme",
  listId: "ledger",
  name: "The Ledger",
  optInPolicy: "double",
  fromAddress: "news@acme.example",
  access: "free",
  visibility: "open",
  complianceFooter: "You get this because you signed up.",
  physicalAddress: "1 Main St, Anytown",
  ...overrides,
});

test("single confirmation email has a plain-text part and a mailto List-Unsubscribe", () => {
  const msg = buildConfirmationEmail(list(), "reader@example.com", "https://acme.example/confirm?token=abc");
  assert.ok(msg.text, "text alternative present");
  assert.match(msg.text!, /Confirm: https:\/\/acme\.example\/confirm\?token=abc/);
  assert.match(msg.text!, /The Ledger/);
  assert.equal(msg.listUnsubscribe, "<mailto:news@acme.example>");
});

test("batch confirmation email lists every name in the text part", () => {
  const msg = buildBatchConfirmationEmail(
    [list(), list({ listId: "brief", name: "The Brief" })],
    "reader@example.com",
    "https://acme.example/confirm?token=xyz",
  );
  assert.ok(msg.text, "text alternative present");
  assert.match(msg.text!, /- The Ledger/);
  assert.match(msg.text!, /- The Brief/);
  assert.match(msg.text!, /Confirm all: https:\/\/acme\.example\/confirm\?token=xyz/);
  assert.equal(msg.listUnsubscribe, "<mailto:news@acme.example>");
});
