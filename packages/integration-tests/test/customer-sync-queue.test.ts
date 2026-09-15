/**
 * The outbound customer-record handoff is FIFO by organization and
 * content-deduplicated by the durable transition id. Keep this contract close
 * to the adapter: a queue that accepts the message but loses either property
 * can silently reorder or duplicate subscription changes downstream.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SqsCustomerSyncQueue, type CustomerSyncEvent } from "@addressium/adapters-aws";

const event = (overrides: Partial<CustomerSyncEvent> = {}): CustomerSyncEvent => ({
  eventId: "summit/sub-1/ledger/2026-09-15T10:00:00.000Z/subscribed",
  type: "subscribed",
  orgId: "summit",
  subscriberId: "sub-1",
  externalId: "crm-42",
  email: "reader@example.test",
  listId: "ledger",
  occurredAt: "2026-09-15T10:00:00.000Z",
  ...overrides,
});

test("customer sync queue sends the event with org ordering and transition deduplication", async () => {
  const inputs: Record<string, unknown>[] = [];
  const fakeClient = {
    send: async (command: { input: Record<string, unknown> }) => {
      inputs.push(command.input);
      return {};
    },
  };
  // The adapter only calls `send`; keeping the fake local avoids an AWS client
  // or LocalStack dependency for this transport contract test.
  const queue = new SqsCustomerSyncQueue("https://sqs.example.test/customer.fifo", fakeClient as never);

  await queue.enqueue(event());

  assert.deepEqual(inputs, [{
    QueueUrl: "https://sqs.example.test/customer.fifo",
    MessageBody: JSON.stringify(event()),
    MessageGroupId: "summit",
    MessageDeduplicationId: "summit/sub-1/ledger/2026-09-15T10:00:00.000Z/subscribed",
  }]);
});

test("a different organization is a different FIFO group", async () => {
  const inputs: Record<string, unknown>[] = [];
  const fakeClient = {
    send: async (command: { input: Record<string, unknown> }) => {
      inputs.push(command.input);
      return {};
    },
  };
  const queue = new SqsCustomerSyncQueue("https://sqs.example.test/customer.fifo", fakeClient as never);

  await queue.enqueue(event({ orgId: "northwind", eventId: "northwind/event-1" }));

  assert.equal(inputs[0]?.MessageGroupId, "northwind");
  assert.equal(inputs[0]?.MessageDeduplicationId, "northwind/event-1");
});
