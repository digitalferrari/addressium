/**
 * SesEmailSender header/body construction (adapters-aws, RFC 8058).
 *
 * The one-click POST header is only conformant alongside an `https`
 * List-Unsubscribe URI; a `mailto:`-only value (transactional confirmations)
 * must not advertise one-click. A plain-text part is emitted when provided.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SesEmailSender } from "@addressium/adapters-aws";

/** Capture the SendEmailCommand input without hitting SES. */
function fakeClient() {
  const inputs: any[] = [];
  const client = { send: async (cmd: any) => { inputs.push(cmd.input); return {}; } };
  return { client: client as any, inputs };
}

const base = {
  from: "news@acme.example",
  to: "reader@example.com",
  subject: "Hello",
  html: "<p>hi</p>",
};

test("https List-Unsubscribe advertises one-click POST", async () => {
  const { client, inputs } = fakeClient();
  const sender = new SesEmailSender("cs-acme", client);
  await sender.send({ ...base, listUnsubscribe: "<https://acme.example/u?token=abc>" });
  const headers = inputs[0].Content.Simple.Headers as Array<{ Name: string; Value: string }>;
  const names = headers.map((h) => h.Name);
  assert.ok(names.includes("List-Unsubscribe"));
  assert.ok(names.includes("List-Unsubscribe-Post"), "one-click present for https");
});

test("mailto List-Unsubscribe does NOT advertise one-click POST", async () => {
  const { client, inputs } = fakeClient();
  const sender = new SesEmailSender("cs-acme", client);
  await sender.send({ ...base, listUnsubscribe: "<mailto:news@acme.example>" });
  const headers = inputs[0].Content.Simple.Headers as Array<{ Name: string; Value: string }>;
  const names = headers.map((h) => h.Name);
  assert.ok(names.includes("List-Unsubscribe"));
  assert.ok(!names.includes("List-Unsubscribe-Post"), "one-click omitted for mailto");
});

test("plain-text part is emitted only when provided", async () => {
  const { client, inputs } = fakeClient();
  const sender = new SesEmailSender("cs-acme", client);
  await sender.send({ ...base, listUnsubscribe: "<mailto:news@acme.example>" });
  assert.equal(inputs[0].Content.Simple.Body.Text, undefined);

  await sender.send({ ...base, text: "hi (plain)", listUnsubscribe: "<mailto:news@acme.example>" });
  assert.equal(inputs[1].Content.Simple.Body.Text.Data, "hi (plain)");
  assert.equal(inputs[1].Content.Simple.Body.Html.Data, "<p>hi</p>");
});

// ---- class → configuration set (#237) ----

test("a transactional message goes out on the transactional configuration set", async () => {
  // Reputation is per-config-set. If a confirmation shares one with a marketing
  // blast, a complaint spike on the blast drags confirmations down — and
  // confirmation mail failing is what stops new subscribers arriving.
  const sent: Record<string, unknown>[] = [];
  const client = { send: async (c: { input: Record<string, unknown> }) => void sent.push(c.input) };
  const sender = new SesEmailSender("addressium-acme", client as never, "addressium-acme-transactional");

  await sender.send({
    emailClass: "transactional",
    from: "l@x.example",
    to: "a@x.example",
    subject: "Confirm",
    html: "<p>x</p>",
    listUnsubscribe: "<mailto:l@x.example>",
  });
  assert.equal(sent[0]!.ConfigurationSetName, "addressium-acme-transactional");
});

test("a marketing message — and one with no class — uses the marketing set", async () => {
  // Absent reads as marketing everywhere, so a caller that forgets cannot
  // silently move traffic onto the transactional reputation.
  const sent: Record<string, unknown>[] = [];
  const client = { send: async (c: { input: Record<string, unknown> }) => void sent.push(c.input) };
  const sender = new SesEmailSender("addressium-acme", client as never, "addressium-acme-transactional");
  const base = {
    from: "l@x.example",
    to: "a@x.example",
    subject: "s",
    html: "<p>x</p>",
    listUnsubscribe: "<https://x.example/u?token=t>",
  };
  await sender.send({ ...base, emailClass: "marketing" });
  await sender.send(base);
  assert.deepEqual(
    sent.map((s) => s.ConfigurationSetName),
    ["addressium-acme", "addressium-acme"],
  );
});

test("with no transactional set configured, transactional falls back to the marketing one", async () => {
  // NOT to no set at all: a message sent with no configuration set publishes no
  // events, and a silent event plane is the failure mode #208 was. Orgs
  // provisioned before #237 have only the one set.
  const sent: Record<string, unknown>[] = [];
  const client = { send: async (c: { input: Record<string, unknown> }) => void sent.push(c.input) };
  const sender = new SesEmailSender("addressium-acme", client as never);
  await sender.send({
    emailClass: "transactional",
    from: "l@x.example",
    to: "a@x.example",
    subject: "s",
    html: "<p>x</p>",
    listUnsubscribe: "<mailto:l@x.example>",
  });
  assert.equal(sent[0]!.ConfigurationSetName, "addressium-acme");
});
