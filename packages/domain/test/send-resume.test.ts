/**
 * Regression (#163): a send that dies mid-loop must RESUME, not strand its
 * remaining recipients.
 *
 * The claim used to be taken once for the whole campaign/slice before the loop
 * and never released, so a crash at recipient N left the claim held; the SQS
 * redelivery returned `skipped` and the message was ACKed. Everyone after N was
 * never emailed and nothing reported it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SystemClock, sendCampaign, memStores } from "@addressium/domain";
import type { EmailSender, SentMessage, MagicLinkSigner } from "@addressium/domain";

const ORG = "acme";
const LIST = "ledger";

const magic: MagicLinkSigner = { mint: async () => "TOK" };

/** Sender that throws after `failAfter` successful sends, like a Lambda timeout. */
class FlakySender implements EmailSender {
  public readonly sent: SentMessage[] = [];
  constructor(private failAfter = Infinity) {}
  async send(msg: SentMessage): Promise<void> {
    if (this.sent.length >= this.failAfter) throw new Error("simulated SES failure");
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

test("a crash mid-loop resumes and delivers exactly the remainder, once each", async () => {
  const { stores, clock } = await seed(10);

  // First delivery dies after 4 sends.
  const flaky = new FlakySender(4);
  await assert.rejects(() => sendCampaign(stores, flaky, magic, clock, descriptor));
  assert.equal(flaky.sent.length, 4);

  // SQS redelivers. The remaining 6 must go out — this used to return skipped.
  const retry = new FlakySender();
  const res = await sendCampaign(stores, retry, magic, clock, descriptor);
  assert.equal(res.sent, 6, "delivers the remainder");
  assert.equal(res.alreadySent, 4, "recognizes the four already dispatched");

  const all = [...flaky.sent, ...retry.sent].map((m) => m.to);
  assert.equal(all.length, 10, "every recipient received exactly one message");
  assert.equal(new Set(all).size, 10, "no duplicates");
});

test("a full redelivery is a no-op and still reports skipped", async () => {
  const { stores, clock } = await seed(5);
  const first = new FlakySender();
  const a = await sendCampaign(stores, first, magic, clock, descriptor);
  assert.equal(a.sent, 5);
  assert.equal(a.skipped, false);

  const second = new FlakySender();
  const b = await sendCampaign(stores, second, magic, clock, descriptor);
  assert.equal(b.sent, 0);
  assert.equal(b.alreadySent, 5);
  assert.equal(b.skipped, true, "contract preserved for a complete redelivery");
  assert.equal(second.sent.length, 0, "nobody is emailed twice");
});

test("an unsliced send followed by a sliced one cannot double-send (#172)", async () => {
  const { stores, clock } = await seed(6);
  const whole = new FlakySender();
  await sendCampaign(stores, whole, magic, clock, descriptor);
  assert.equal(whole.sent.length, 6);

  // The chunk boundary was crossed and the redelivery fans out instead. Slice
  // claims used to live in a different key space, so the list went out twice.
  const sliced = new FlakySender();
  const r = await sendCampaign(stores, sliced, magic, clock, {
    ...descriptor,
    slice: {}, // the whole range — one open-ended window

  });
  assert.equal(sliced.sent.length, 0, "slice must not re-send an already-sent list");
  assert.equal(r.alreadySent, 6);
});
