/**
 * One bad address must not strand the rest of the list (#293).
 *
 * A campaign send is a loop over recipients, and every error used to abort it.
 * A permanently-rejected address therefore stranded everyone after it: SQS
 * redelivered, the claims skipped the already-sent prefix, the loop reached the
 * same address, and it failed identically until the message dead-lettered.
 * Measured before the fix on a 10-recipient list with one bad address at
 * position 4 — 3 delivered, 6 never mailed, DLQ depth the only signal.
 *
 * The distinction these pin is which errors are PER-RECIPIENT. Continuing past
 * an account-level fault would be the worse bug: it would report a completed
 * send that mailed nobody.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SystemClock,
  sendCampaign,
  memStores,
  RecipientRejectedError,
} from "@addressium/domain";
import type { EmailSender, SentMessage, MagicLinkSigner } from "@addressium/domain";

const ORG = "acme";
const LIST = "ledger";
const magic: MagicLinkSigner = { mint: async () => "TOK" };

/** Rejects specific addresses the way SES rejects one it will not send to. */
class RejectingSender implements EmailSender {
  public readonly sent: SentMessage[] = [];
  public attempts = 0;
  public firstAttempt: string | undefined;
  constructor(private readonly bad: Set<string>) {}
  async send(msg: SentMessage): Promise<void> {
    this.attempts++;
    this.firstAttempt ??= msg.to;
    if (this.bad.has(msg.to)) {
      throw new RecipientRejectedError(
        msg.to,
        `Email address is not verified. The following identities failed the check in region US-EAST-1: ${msg.to}`,
      );
    }
    this.sent.push(msg);
  }
}

/** A transient, account-level failure — throttling. Must still abort. */
class ThrottledSender implements EmailSender {
  public readonly sent: SentMessage[] = [];
  constructor(private readonly failAfter: number) {}
  async send(msg: SentMessage): Promise<void> {
    if (this.sent.length >= this.failAfter) {
      const e = new Error("Maximum sending rate exceeded.");
      e.name = "TooManyRequestsException";
      throw e;
    }
    this.sent.push(msg);
  }
}

async function seed(n: number) {
  const stores = memStores();
  const clock = new SystemClock();
  await stores.lists.put({
    orgId: ORG, listId: LIST, name: "Ledger", optInPolicy: "double",
    fromAddress: "news@acme.example", access: "free", visibility: "open",
    complianceFooter: "footer", physicalAddress: "1 Main St",
  });
  for (let i = 0; i < n; i++) {
    const sub = `s${String(i).padStart(3, "0")}`;
    await stores.subscribers.put({
      orgId: ORG, sub, email: `r${i}@x.example`, status: "active",
      entitlement: "free", attributes: {},
    });
    await stores.subscriptions.put({
      orgId: ORG, subscriberId: sub, listId: LIST, status: "confirmed",
      updatedAt: clock.now().toISOString(),
    });
  }
  return { stores, clock };
}

const descriptor = {
  orgId: ORG, campaignId: "daily-1", listId: LIST, subject: "Hi",
  template: { blocks: [{ kind: "text" as const, html: "<p>hello</p>" }] },
};

test("a rejected recipient does not strand the ones after it", async () => {
  const { stores, clock } = await seed(3);
  const sender = new RejectingSender(new Set(["r1@x.example"]));

  const res = await sendCampaign(stores, sender, magic, clock, descriptor);

  // The whole point: the third recipient is mailed even though the second failed.
  assert.deepEqual(sender.sent.map((m) => m.to), ["r0@x.example", "r2@x.example"]);
  assert.equal(res.sent, 2);
  assert.equal(res.rejected, 1, "the rejection is counted, not swallowed");

  // `reject`, never `bounce`: no receiver refused anything, so suppressing the
  // address would punish a subscriber for our fault.
  const events = await stores.events.all(ORG, "daily-1");
  const rejects = events.filter((e) => e.type === "reject");
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0]!.subscriberId, "s001");
  assert.equal(events.filter((e) => e.type === "bounce").length, 0);
});

test("a retry does not re-attempt the rejected address", async () => {
  const { stores, clock } = await seed(3);
  await sendCampaign(stores, new RejectingSender(new Set(["r1@x.example"])), magic, clock, descriptor);

  // The claim is deliberately KEPT on a rejection — retrying it would fail
  // identically, and re-attempting forever is what filled the DLQ.
  const retry = new RejectingSender(new Set(["r1@x.example"]));
  const res = await sendCampaign(stores, retry, magic, clock, descriptor);
  assert.equal(res.sent, 0);
  assert.equal(retry.attempts, 0, "no recipient is re-attempted");
});

test("a throttling error still aborts the slice, so SQS retries it", async () => {
  // The dangerous direction is treating an account-level fault as per-recipient:
  // it would write one reject per recipient and report a send that mailed
  // nobody. Only RecipientRejectedError is per-recipient; this must abort.
  const { stores, clock } = await seed(5);
  const sender = new ThrottledSender(2);
  await assert.rejects(
    () => sendCampaign(stores, sender, magic, clock, descriptor),
    /Maximum sending rate exceeded/,
  );
  assert.equal(sender.sent.length, 2);
  const events = await stores.events.all(ORG, "daily-1");
  assert.equal(events.filter((e) => e.type === "reject").length, 0, "a throttle is not a rejection");
});

test("an all-rejecting send trips the breaker instead of reporting success", async () => {
  // An unverified FROM identity raises the same MessageRejected for EVERY
  // recipient. Continuing would complete the slice having mailed nobody, which
  // looks like success — worse than aborting.
  const { stores, clock } = await seed(40);
  const all = new Set(Array.from({ length: 40 }, (_, i) => `r${i}@x.example`));
  const sender = new RejectingSender(all);

  await assert.rejects(
    () => sendCampaign(stores, sender, magic, clock, descriptor),
    /consecutive recipient rejections/,
  );
  // Stopped at the threshold, not after all 40.
  assert.ok(sender.attempts <= 12, `stopped early, attempted ${sender.attempts}`);
  assert.equal(sender.sent.length, 0);
});

test("scattered bad addresses do not trip the breaker", async () => {
  // Consecutive, not total: a real imported list has some bad addresses and
  // must keep sending to everyone else.
  const { stores, clock } = await seed(30);
  const bad = new Set(["r3@x.example", "r11@x.example", "r19@x.example", "r27@x.example"]);
  const sender = new RejectingSender(bad);

  const res = await sendCampaign(stores, sender, magic, clock, descriptor);
  assert.equal(res.sent, 26);
  assert.equal(res.rejected, 4);
});

test("the breaker strands nobody: a retry re-attempts the same recipients", async () => {
  // The breaker fires on a systemic fault, so its rejections are NOT evidence
  // that those addresses are bad. Committing them eagerly meant each retry kept
  // the previous run's claims and marched 10 further into the list — with SQS
  // maxReceiveCount at 5, that permanently skipped 50 recipients for the
  // edition, whom a redrive after fixing the fault would never mail.
  const { stores, clock } = await seed(40);
  const all = new Set(Array.from({ length: 40 }, (_, i) => `r${i}@x.example`));

  const first = new RejectingSender(all);
  await assert.rejects(() => sendCampaign(stores, first, magic, clock, descriptor));

  const second = new RejectingSender(all);
  await assert.rejects(() => sendCampaign(stores, second, magic, clock, descriptor));

  assert.deepEqual(
    second.sent.length === 0 && firstAttempted(second) === firstAttempted(first),
    true,
    "the retry must re-attempt the SAME recipients, not march past them",
  );
  // And it must leave no trace: a reject event here would be a false record that
  // the address is bad, when the sender was at fault.
  const events = await stores.events.all(ORG, "daily-1");
  assert.equal(events.filter((e) => e.type === "reject").length, 0);
});

/** The first address a run actually attempted. */
function firstAttempted(s: RejectingSender): string | undefined {
  return s.firstAttempt;
}
