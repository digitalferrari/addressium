/**
 * Amazon SES v2 implementation of the EmailSender port.
 *
 * Sends one message with the RFC 8058 one-click unsubscribe headers and the
 * org's configuration set (per-org metrics isolation, §4.11). Bulk batching via
 * SendBulkEmail is a later optimization; correctness/compliance first.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { EmailSender, SentMessage } from "@addressium/domain";

/** SES message-tag names carrying our correlation ids (#184). */
export const SES_TAG = {
  org: "addressiumOrg",
  campaign: "addressiumCampaign",
  subscriber: "addressiumSubscriber",
} as const;

/**
 * SES restricts message-tag values to `[A-Za-z0-9_-]{1,256}`. base64url uses
 * exactly that alphabet, so encoding is lossless for ids that legitimately
 * contain other characters — drip steps (`drip:seq#3`) and resend sub-campaigns
 * (`base#resend`) would otherwise be rejected or silently mangled.
 */
export const encodeTag = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
export const decodeTag = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

export class SesEmailSender implements EmailSender {
  private readonly client: SESv2Client;

  /**
   * @param configurationSetName the org's MARKETING configuration set.
   * @param client injected in tests.
   * @param transactionalConfigurationSetName the org's TRANSACTIONAL set (#237).
   *
   * Two sets, because reputation and metrics are per-configuration-set. Sharing
   * one meant a double opt-in confirmation carried the same reputation as a
   * marketing blast — so when the marketing complaint rate climbed it dragged
   * confirmation mail with it, and confirmation mail failing is exactly what
   * stops new subscribers arriving. The reputation problem would eat its own
   * recovery path.
   *
   * Absent, transactional falls back to the marketing set rather than to NO set:
   * a message sent with no configuration set publishes no events at all, and a
   * silent event plane is the failure mode #208 was.
   */
  constructor(
    private readonly configurationSetName?: string,
    client?: SESv2Client,
    private readonly transactionalConfigurationSetName?: string,
  ) {
    this.client = client ?? new SESv2Client({});
  }

  /** The configuration set this message goes out on (#237). */
  private configSetFor(emailClass: string | undefined): string | undefined {
    return emailClass === "transactional"
      ? (this.transactionalConfigurationSetName ?? this.configurationSetName)
      : this.configurationSetName;
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
        ConfigurationSetName: this.configSetFor(msg.emailClass),
        // Stamped onto every SES event for this message, which is the only way
        // the event feed can resolve a bounce back to a subscriber (#184).
        ...(msg.tags
          ? {
              EmailTags: [
                { Name: SES_TAG.org, Value: encodeTag(msg.tags.orgId) },
                { Name: SES_TAG.campaign, Value: encodeTag(msg.tags.campaignId) },
                { Name: SES_TAG.subscriber, Value: encodeTag(msg.tags.subscriberId) },
              ],
            }
          : {}),
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
