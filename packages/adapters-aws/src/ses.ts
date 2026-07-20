/**
 * Amazon SES v2 implementation of the EmailSender port.
 *
 * Sends one message with the RFC 8058 one-click unsubscribe headers and the
 * org's configuration set (per-org metrics isolation, §4.11). Bulk batching via
 * SendBulkEmail is a later optimization; correctness/compliance first.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { EmailSender, SentMessage } from "@addressium/domain";

export class SesEmailSender implements EmailSender {
  private readonly client: SESv2Client;

  constructor(
    private readonly configurationSetName?: string,
    client?: SESv2Client,
  ) {
    this.client = client ?? new SESv2Client({});
  }

  async send(msg: SentMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: msg.from,
        Destination: { ToAddresses: [msg.to] },
        ConfigurationSetName: this.configurationSetName,
        Content: {
          Simple: {
            Subject: { Data: msg.subject, Charset: "UTF-8" },
            Body: { Html: { Data: msg.html, Charset: "UTF-8" } },
            Headers: [
              { Name: "List-Unsubscribe", Value: msg.listUnsubscribe },
              { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
            ],
          },
        },
      }),
    );
  }
}
