/**
 * SNS implementation of the AlertPublisher port (docs/ARCHITECTURE.md §4.18).
 *
 * Publishes deliverability alerts to the org's operator-owned SNS topic. The
 * message is JSON so subscribers (email, Lambda, PagerDuty) can route on the
 * `action` (warned/halted) and per-metric breaches.
 */
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type { AlertMessage, AlertPublisher } from "@addressium/domain";

export class SnsAlertPublisher implements AlertPublisher {
  private readonly client: SNSClient;
  constructor(client?: SNSClient) {
    this.client = client ?? new SNSClient({});
  }

  async publish(topicArn: string, message: AlertMessage): Promise<void> {
    const halted = message.action === "halted";
    await this.client.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: `[addressium] ${message.orgId} deliverability ${message.action}`.slice(0, 100),
        Message: JSON.stringify(message),
        MessageAttributes: {
          action: { DataType: "String", StringValue: message.action },
          severity: { DataType: "String", StringValue: halted ? "critical" : "warning" },
        },
      }),
    );
  }
}
