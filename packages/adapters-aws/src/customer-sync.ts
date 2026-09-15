import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

export interface CustomerSyncEvent {
  eventId: string;
  type: "subscribed" | "unsubscribed";
  orgId: string;
  subscriberId: string;
  externalId: string;
  email: string;
  listId: string;
  occurredAt: string;
}

/** Durable handoff for customer-record updates. The worker owns HTTP delivery. */
export class SqsCustomerSyncQueue {
  private readonly client: SQSClient;
  constructor(private readonly queueUrl: string, client?: SQSClient) {
    this.client = client ?? new SQSClient({});
  }
  async enqueue(event: CustomerSyncEvent): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(event),
      MessageGroupId: event.orgId,
      MessageDeduplicationId: event.eventId,
    }));
  }
}
