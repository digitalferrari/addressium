/**
 * Local stand-ins for SES and SQS, spoken over the wire (#232).
 *
 * ## Why an HTTP server rather than a fake adapter
 *
 * The obvious approach is to hand the handlers an in-memory `EmailSender` and
 * `SendQueue`. That would make `npm run dev` a test of the fakes: the real
 * `SesEmailSender` — which is where the RFC 8058 headers, the `emailClass`
 * configuration-set routing and the base64url message tags live — would never
 * run, and those are exactly the layers where this repo's defects have been.
 *
 * So instead the AWS SDK is pointed at this server with
 * `AWS_ENDPOINT_URL_SESV2` / `AWS_ENDPOINT_URL_SQS`. The production adapters run
 * verbatim, construct real commands, and serialize real payloads; only the far
 * end is local. It also means **zero `ADDRESSIUM_LOCAL` branches in the send
 * path** — nothing in `packages/adapters-aws/src/ses.ts` or `sqs.ts` knows this
 * exists.
 *
 * These implement the narrow slice of each protocol addressium actually calls,
 * and nothing else. An unrecognised operation answers 501 by name rather than
 * an empty 200, so a new SDK call shows up as a loud error instead of silently
 * appearing to succeed.
 */
import { createServer } from "node:http";
import { mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const readBody = (req) =>
  new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res(b));
  });

/**
 * One in-memory FIFO standing in for the send queue.
 *
 * No visibility timeout and no redrive: a local queue that hides a message for
 * 30 seconds turns "why did nothing send?" into a waiting game, and the DLQ
 * behaviour worth testing is the domain's claim/release logic, which runs
 * regardless.
 */
class Queue {
  #messages = [];
  #inFlight = new Map();

  send(body) {
    const id = randomUUID();
    this.#messages.push({ id, body });
    return id;
  }

  receive(max = 10) {
    const out = this.#messages.splice(0, max);
    for (const m of out) this.#inFlight.set(m.id, m);
    return out;
  }

  delete(id) {
    this.#inFlight.delete(id);
  }

  /** Messages taken but never deleted — a handler that threw. Surfaced, not hidden. */
  get stuck() {
    return [...this.#inFlight.values()];
  }

  get depth() {
    return this.#messages.length;
  }
}

/**
 * Start the stubs and point the SDK at them.
 *
 * @param outbox directory the mail sink appends to
 * @returns `{ queue, close, outboxPath }`
 */
export async function startAwsStubs(outbox) {
  mkdirSync(outbox, { recursive: true });
  const outboxPath = resolve(outbox, "mail.ndjson");
  const queue = new Queue();

  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const reply = (code, obj) => {
      res.writeHead(code, { "content-type": "application/x-amz-json-1.0" });
      res.end(JSON.stringify(obj));
    };

    // ---- SESv2: the one call the sender makes ----
    if (req.url?.startsWith("/v2/email/outbound-emails")) {
      const msg = JSON.parse(body || "{}");
      const simple = msg.Content?.Simple ?? {};
      // The whole message is written, not a summary: the point of the outbox is
      // that a developer can read the headers the adapter actually produced —
      // List-Unsubscribe, the one-click POST header, the message tags, the
      // configuration set — rather than trusting that it produced them.
      appendFileSync(
        outboxPath,
        `${JSON.stringify({
          at: new Date().toISOString(),
          from: msg.FromEmailAddress,
          to: msg.Destination?.ToAddresses ?? [],
          subject: simple.Subject?.Data,
          html: simple.Body?.Html?.Data,
          text: simple.Body?.Text?.Data,
          headers: simple.Headers ?? [],
          configurationSet: msg.ConfigurationSetName,
          tags: msg.EmailTags ?? [],
        })}\n`,
      );
      return reply(200, { MessageId: randomUUID() });
    }

    // ---- EventBridge Scheduler ----
    //
    // A one-off send is placed at least five minutes out in production so it
    // stays cancellable (§4.6). Locally it fires IMMEDIATELY: waiting five
    // minutes to find out whether your send works defeats the entire point of a
    // dev server, and the five-minute window is a product decision about
    // cancellation, not behaviour under test.
    //
    // The target Input is the SendDescriptor, so pushing it onto the queue here
    // is exactly what Scheduler would eventually do.
    if (req.url?.startsWith("/schedules/")) {
      if (req.method === "DELETE") return reply(200, {});
      const sched = JSON.parse(body || "{}");
      const input = sched.Target?.Input;
      if (input) {
        queue.send(input);
        console.log("dev-aws-stubs: schedule fired immediately (prod waits 5 minutes)");
      }
      return reply(200, { ScheduleArn: `arn:aws:scheduler:local::schedule/${randomUUID()}` });
    }

    // ---- SQS: JSON protocol, dispatched on X-Amz-Target ----
    const target = String(req.headers["x-amz-target"] ?? "").split(".").pop();
    if (target === "SendMessage") {
      const { MessageBody } = JSON.parse(body || "{}");
      return reply(200, { MessageId: queue.send(MessageBody) });
    }
    if (target === "ReceiveMessage") {
      const { MaxNumberOfMessages } = JSON.parse(body || "{}");
      const msgs = queue.receive(MaxNumberOfMessages ?? 10);
      return reply(200, {
        Messages: msgs.map((m) => ({ MessageId: m.id, ReceiptHandle: m.id, Body: m.body })),
      });
    }
    if (target === "DeleteMessage" || target === "DeleteMessageBatch") {
      const parsed = JSON.parse(body || "{}");
      for (const h of parsed.Entries?.map((e) => e.ReceiptHandle) ?? [parsed.ReceiptHandle]) {
        if (h) queue.delete(h);
      }
      return reply(200, {});
    }
    if (target === "GetQueueAttributes" || target === "GetQueueUrl") {
      return reply(200, { Attributes: {}, QueueUrl: "http://localhost/queue" });
    }

    // Loud, not empty. A new SDK call that silently 200s would look like it
    // worked and would be found weeks later, which is the failure mode this
    // whole dev server exists to shorten.
    console.error(`dev-aws-stubs: unimplemented ${req.method} ${req.url} target=${target || "-"}`);
    reply(501, { __type: "UnimplementedInDevStub", message: `${req.method} ${req.url} ${target ?? ""}` });
  });

  await new Promise((r) => server.listen(0, r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  process.env.AWS_ENDPOINT_URL_SESV2 = endpoint;
  process.env.AWS_ENDPOINT_URL_SES = endpoint;
  process.env.AWS_ENDPOINT_URL_SQS = endpoint;
  process.env.AWS_ENDPOINT_URL_SCHEDULER = endpoint;
  process.env.SEND_QUEUE_URL ??= `${endpoint}/queue`;

  return { queue, outboxPath, endpoint, close: () => server.close() };
}
