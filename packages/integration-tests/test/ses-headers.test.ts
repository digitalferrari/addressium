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
