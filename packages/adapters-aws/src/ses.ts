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
    const headers: Array<{ Name: string; Value: string }> = [
      { Name: "List-Unsubscribe", Value: msg.listUnsubscribe },
    ];
    // RFC 8058: the one-click POST header is only valid alongside an `https`
    // List-Unsubscribe URI. A `mailto:`-only value (e.g. transactional opt-in
    // confirmations) must NOT advertise one-click — previously it was stamped on
    // every message unconditionally, which is non-conformant.
    if (/^<https:\/\//i.test(msg.listUnsubscribe)) {
      headers.push({ Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" });
    }
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: msg.from,
        Destination: { ToAddresses: [msg.to] },
        ConfigurationSetName: this.configurationSetName,
        Content: {
          Simple: {
            Subject: { Data: msg.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: msg.html, Charset: "UTF-8" },
              // Include a plain-text alternative when the caller provides one.
              ...(msg.text ? { Text: { Data: msg.text, Charset: "UTF-8" } } : {}),
            },
            Headers: headers,
          },
        },
      }),
    );
  }
}
