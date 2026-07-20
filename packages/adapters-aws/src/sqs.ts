/**
 * SQS implementation of the SendQueue port. The sender Lambda drains this queue
 * (docs/ARCHITECTURE.md §4.4).
 */
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SendDescriptor, SendQueue } from "@addressium/domain";

export class SqsSendQueue implements SendQueue {
  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    client?: SQSClient,
  ) {
    this.client = client ?? new SQSClient({});
  }

  async enqueue(descriptor: SendDescriptor): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(descriptor),
      }),
    );
  }
}
