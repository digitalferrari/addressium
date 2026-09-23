/**
 * Which SES failures are PER-RECIPIENT (#293).
 *
 * `sendCampaign` continues past a `RecipientRejectedError` and aborts on
 * everything else. That makes this classification the load-bearing part: map
 * too narrowly and one bad address still strands the list; map too widely and
 * an account-level fault writes one reject per recipient and reports a
 * completed send that mailed nobody.
 *
 * SES raises the SAME `MessageRejected` for an unverified FROM identity as for
 * an unsendable recipient, so the name alone is not enough — the message has to
 * NAME the recipient.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SesEmailSender } from "@addressium/adapters-aws";
import { RecipientRejectedError } from "@addressium/domain";

/** A client that fails with a specific SES exception shape. */
function throwingClient(name: string, message: string) {
  return {
    send: async () => {
      const e = new Error(message);
      e.name = name;
      throw e;
    },
  } as any;
}

const base = {
  from: "news@acme.example",
  to: "reader@example.com",
  subject: "Hello",
  html: "<p>hi</p>",
  listUnsubscribe: "<https://acme.example/u?token=abc>",
};

test("MessageRejected naming the recipient is per-recipient", async () => {
  const sender = new SesEmailSender(
    "cs-acme",
    throwingClient(
      "MessageRejected",
      "Email address is not verified. The following identities failed the check in region US-EAST-1: reader@example.com",
    ),
  );
  await assert.rejects(
    () => sender.send(base),
    (e: Error) => {
      assert.ok(e instanceof RecipientRejectedError, `got ${e.name}`);
      assert.equal((e as RecipientRejectedError).recipient, "reader@example.com");
      return true;
    },
  );
});

test("MessageRejected naming the FROM identity is NOT per-recipient", async () => {
  // The case that matters most. This is an account-wide fault: every recipient
  // would fail the same way. Continuing would mail nobody and report success.
  const sender = new SesEmailSender(
    "cs-acme",
    throwingClient(
      "MessageRejected",
      "Email address is not verified. The following identities failed the check in region US-EAST-1: news@acme.example",
    ),
  );
  await assert.rejects(
    () => sender.send(base),
    (e: Error) => {
      assert.ok(!(e instanceof RecipientRejectedError), "must abort the slice, not skip one recipient");
      assert.equal(e.name, "MessageRejected");
      return true;
    },
  );
});

test("throttling, quota and account-level faults abort the slice", async () => {
  // Every one of these means the NEXT recipient fails too, so retrying the
  // whole slice through SQS is the correct response.
  for (const name of [
    "TooManyRequestsException",
    "LimitExceededException",
    "AccountSuspendedException",
    "SendingPausedException",
    "MailFromDomainNotVerifiedException",
    "InternalServiceErrorException",
  ]) {
    const sender = new SesEmailSender("cs-acme", throwingClient(name, `${name}: reader@example.com`));
    await assert.rejects(
      () => sender.send(base),
      (e: Error) => {
        assert.ok(
          !(e instanceof RecipientRejectedError),
          `${name} must NOT be treated as per-recipient`,
        );
        return true;
      },
    );
  }
});

test("a network error with no name aborts the slice", async () => {
  const sender = new SesEmailSender("cs-acme", {
    send: async () => { throw new Error("socket hang up"); },
  } as any);
  await assert.rejects(
    () => sender.send(base),
    (e: Error) => !(e instanceof RecipientRejectedError),
  );
});

test("recipient matching is case-insensitive", async () => {
  // SES echoes the address as given; addresses are case-insensitive in the
  // domain part, so a case difference must not turn a per-recipient rejection
  // into a slice abort.
  const sender = new SesEmailSender(
    "cs-acme",
    throwingClient("MessageRejected", "not verified: Reader@Example.com"),
  );
  await assert.rejects(
    () => sender.send(base),
    (e: Error) => e instanceof RecipientRejectedError,
  );
});

test("an error naming BOTH the sender and the recipient aborts the slice", async () => {
  // SES lists every failing identity in one message. An error that names the
  // FROM address as well is an account-wide fault that merely mentions the
  // recipient in passing — the naming check alone would have let it through and
  // skipped every recipient, reporting a send that mailed nobody.
  const sender = new SesEmailSender(
    "cs-acme",
    throwingClient(
      "MessageRejected",
      "Email address is not verified. The following identities failed the check in region US-EAST-1: news@acme.example, reader@example.com",
    ),
  );
  await assert.rejects(
    () => sender.send(base),
    (e: Error) => {
      assert.ok(!(e instanceof RecipientRejectedError), "must abort: the sender is unverified too");
      return true;
    },
  );
});
