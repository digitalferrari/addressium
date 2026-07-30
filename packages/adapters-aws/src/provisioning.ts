/**
 * AWS implementation of the domain ProvisioningProviders (docs/ARCHITECTURE.md
 * §4.11). Links (never creates) the operator's subscriber Cognito pool, creates
 * an asymmetric KMS signing key (ES256, tagged app=addressium so IAM grants
 * scope to it), and the SES domain identity + configuration set with DKIM.
 * Public-key export → JWKS is the tokens service's job (KmsJwksProvider); here
 * we just mint the key + kid.
 */
import { KMSClient, CreateKeyCommand, CreateAliasCommand } from "@aws-sdk/client-kms";
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  UpdateConfigurationSetEventDestinationCommand,
  PutConfigurationSetSuppressionOptionsCommand,
  PutConfigurationSetDeliveryOptionsCommand,
  PutEmailIdentityMailFromAttributesCommand,
  type EventDestinationDefinition,
} from "@aws-sdk/client-sesv2";
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type {
  ProvisioningProviders,
  SesIdentity,
  SigningKey,
  SubscriberPoolSpec,
} from "@addressium/domain";
import { mailFromDomainFor, mailFromMxHostFor } from "@addressium/domain";

/** Stable name so re-provisioning updates the same destination (#208). */
const EVENT_DESTINATION_NAME = "addressium-sns";

export class AwsProvisioningProviders implements ProvisioningProviders {
  constructor(
    private readonly kms = new KMSClient({}),
    private readonly ses = new SESv2Client({}),
    private readonly cognito = new CognitoIdentityProviderClient({}),
  ) {}

  /**
   * Link the operator's existing pool. addressium never CREATES a user pool: a
   * pool carries far more configuration than we can sensibly own, and it is the
   * operator's own directory (§4.10).
   *
   * We used to know the pool was email-addressable because we created it that
   * way; for a linked pool that is an assumption, and every subscriber account
   * is created with the normalized email as the Cognito `Username`. So prove it
   * here — a wrong pool fails once, at configuration time, with a fix in the
   * message, instead of once per subscriber as an opaque AdminCreateUser error.
   */
  async linkSubscriberPool(_orgId: string, spec: SubscriberPoolSpec): Promise<{ poolId: string }> {
    const res = await this.cognito.send(new DescribeUserPoolCommand({ UserPoolId: spec.poolId }));
    const emailAddressable =
      (res.UserPool?.UsernameAttributes ?? []).includes("email") ||
      (res.UserPool?.AliasAttributes ?? []).includes("email");
    if (!emailAddressable) {
      throw new Error(
        `user pool ${spec.poolId} is not email-addressable: addressium addresses subscriber ` +
          `accounts by email, so the pool must be created with UsernameAttributes ["email"] ` +
          `(or have "email" as an alias attribute). Neither is changeable after pool creation — ` +
          `link a pool that has it, or create one that does.`,
      );
    }
    return { poolId: spec.poolId };
  }

  async createSigningKey(orgId: string): Promise<SigningKey> {
    const res = await this.kms.send(
      new CreateKeyCommand({
        KeySpec: "ECC_NIST_P256",
        KeyUsage: "SIGN_VERIFY",
        Description: `addressium magic-link signing key for ${orgId}`,
        Tags: [
          { TagKey: "app", TagValue: "addressium" },
          { TagKey: "orgId", TagValue: orgId },
        ],
      }),
    );
    const arn = res.KeyMetadata?.Arn;
    const keyId = res.KeyMetadata?.KeyId;
    if (!arn || !keyId) throw new Error("KMS did not return a key");
    await this.kms.send(
      new CreateAliasCommand({ AliasName: `alias/addressium-${orgId}-magiclink`, TargetKeyId: keyId }),
    );
    // kid is the key id; the JWKS publishes the public half under this kid.
    return { kmsKeyArn: arn, kid: keyId };
  }

  async ensureSesDomainIdentity(
    orgId: string,
    domain: string,
    dedicatedIpPoolName?: string,
  ): Promise<SesIdentity> {
    const configSet = `addressium-${orgId}`;
    const transactionalConfigSet = `addressium-${orgId}-transactional`;
    try {
      await this.ses.send(
        new CreateConfigurationSetCommand({
          ConfigurationSetName: configSet,
          // Account-level suppression, scoped to this org's config set (#200).
          //
          // addressium already suppresses in its own store, so this is belt and
          // braces — but the two catch different things. Ours only knows about
          // bounces this deployment has SEEN and processed; SES's list is what
          // stops a send at the API boundary, before it becomes a bounce, which
          // covers the window between a bounce arriving and our handler
          // recording it, and covers any path that bypasses our suppression
          // check. Repeatedly mailing an address SES already knows is dead is a
          // direct reputation cost.
          SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
        }),
      );
    } catch (e) {
      if ((e as { name?: string }).name !== "AlreadyExistsException") throw e;
      // An org provisioned before #200 has a config set with no suppression
      // options; re-provisioning must bring it up to date rather than skip it.
      await this.ses.send(
        new PutConfigurationSetSuppressionOptionsCommand({
          ConfigurationSetName: configSet,
          SuppressedReasons: ["BOUNCE", "COMPLAINT"],
        }),
      );
    }
    await this.ensureEventDestination(configSet);

    // A SECOND configuration set for transactional mail (#237). Reputation and
    // metrics are per-config-set, so sharing one meant a marketing complaint
    // spike dragged double opt-in confirmations down with it — and confirmation
    // mail failing is what stops new subscribers arriving, so the reputation
    // problem ate its own recovery path.
    //
    // Same suppression and the same event destination: the class changes WHOSE
    // reputation a message affects, never whether a bounce is recorded.
    try {
      await this.ses.send(
        new CreateConfigurationSetCommand({
          ConfigurationSetName: transactionalConfigSet,
          SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
        }),
      );
    } catch (e) {
      if ((e as { name?: string }).name !== "AlreadyExistsException") throw e;
      await this.ses.send(
        new PutConfigurationSetSuppressionOptionsCommand({
          ConfigurationSetName: transactionalConfigSet,
          SuppressedReasons: ["BOUNCE", "COMPLAINT"],
        }),
      );
    }
    await this.ensureEventDestination(transactionalConfigSet);

    let dkimTokens: string[] = [];
    let verified = false;
    try {
      const existing = await this.ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      dkimTokens = existing.DkimAttributes?.Tokens ?? [];
      verified = existing.VerifiedForSendingStatus === true;
    } catch (e) {
      if ((e as { name?: string }).name !== "NotFoundException") throw e;
      const created = await this.ses.send(
        new CreateEmailIdentityCommand({
          EmailIdentity: domain,
          ConfigurationSetName: configSet,
          Tags: [{ Key: "app", Value: "addressium" }],
        }),
      );
      dkimTokens = created.DkimAttributes?.Tokens ?? [];
    }

    // Assign the operator's dedicated IP pool, if they created one (#237).
    // addressium does not CREATE pools: a dedicated IP is a standing ~$25/month
    // charge that needs a deliberate warm-up plan, and provisioning one as a
    // side effect of a checkbox would bill an operator for infrastructure they
    // did not knowingly ask for — the same reasoning as WebACLs in #225.
    const pool = dedicatedIpPoolName?.trim();
    if (pool) {
      for (const set of [configSet, transactionalConfigSet]) {
        try {
          await this.ses.send(
            new PutConfigurationSetDeliveryOptionsCommand({
              ConfigurationSetName: set,
              SendingPoolName: pool,
            }),
          );
        } catch (e) {
          // Loud but not fatal: mail still goes out on shared IPs. Silence here
          // would recreate exactly the defect being fixed — a record claiming
          // "dedicated" with nothing behind it.
          console.error("provisioning: could not assign dedicated IP pool — sending stays on shared IPs", {
            configSet: set,
            pool,
            error: (e as Error).message,
          });
        }
      }
    }

    const mailFromDomain = mailFromDomainFor(domain);
    await this.ensureMailFrom(domain, mailFromDomain);

    return {
      configSet,
      transactionalConfigSet,
      dkimTokens,
      verificationStatus: verified ? "verified" : "pending",
      mailFromDomain,
      mailFromMxHost: mailFromMxHostFor(await this.region()),
    };
  }

  /** The client's resolved region — needed for the MAIL FROM MX host (#200). */
  private async region(): Promise<string> {
    const r = this.ses.config.region;
    return typeof r === "function" ? await r() : r;
  }

  /**
   * Put the envelope sender on the publisher's own domain (#200).
   *
   * Without this the Return-Path stays `*.amazonses.com`. SPF authenticates the
   * ENVELOPE sender, so the SPF that passes belongs to Amazon and is unaligned
   * with the visible From — DMARC discards it, leaving DKIM as the message's
   * only authentication leg. That is survivable until a forwarder rewrites the
   * body and breaks the signature, at which point the message has nothing.
   *
   * `USE_DEFAULT_VALUE` rather than `REJECT_MESSAGE`: if the operator has not
   * published the MX record yet, SES falls back to the amazonses.com return path
   * instead of refusing to send. Choosing the other way would mean a DNS record
   * the operator has not got to yet silently halts the org's entire mail flow.
   * The trade is that a forgotten record degrades QUIETLY — which is why the DNS
   * guidance calls it out rather than listing it as one row among many.
   */
  private async ensureMailFrom(domain: string, mailFromDomain: string): Promise<void> {
    try {
      await this.ses.send(
        new PutEmailIdentityMailFromAttributesCommand({
          EmailIdentity: domain,
          MailFromDomain: mailFromDomain,
          BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
        }),
      );
    } catch (e) {
      // Not fatal: mail still sends on the default return path. Loud, because
      // the whole point of this call is an alignment gap nothing else reports.
      console.error("provisioning: could not set custom MAIL FROM — SPF will not align", {
        domain,
        mailFromDomain,
        error: (e as Error).message,
      });
    }
  }

  /**
   * Point the org's configuration set at the shared SES-events SNS topic.
   *
   * A configuration set with NO event destination publishes nothing — so
   * without this the entire event plane is dead at the source: no opens,
   * clicks, bounces or complaints ever reach the handler, counters stay zero,
   * suppression never auto-triggers, and the deliverability halt can never fire
   * (#208). Creating the config set alone was never enough.
   *
   * Idempotent: re-provisioning an existing org must not fail, so an
   * already-present destination is updated rather than re-created.
   */
  private async ensureEventDestination(configSet: string): Promise<void> {
    const topicArn = process.env.SES_EVENTS_TOPIC_ARN;
    if (!topicArn) {
      // Loud, because silence here is exactly the failure mode being fixed.
      console.error("provisioning: SES_EVENTS_TOPIC_ARN unset — event plane will be dead", {
        configSet,
      });
      return;
    }
    const destination: EventDestinationDefinition = {
      Enabled: true,
      SnsDestination: { TopicArn: topicArn },
      // All types SES can publish. `DELIVERY` matters for accurate delivered
      // counts (#210); `REJECT`/`RENDERING_FAILURE`/`DELIVERY_DELAY` each have
      // their own event type and counter as of #241 — subscribing here was
      // already right, and that issue supplied the consumer that had been
      // missing.
      //
      // `SEND` is subscribed but deliberately NOT consumed: the send path writes
      // its own `sent` event per recipient (send.ts), which is the one we can
      // count while a send is in flight. Acting on SES's copy too would double
      // every `sent` counter in the product. Kept in the subscription so the
      // Firehose analytics tier (§4.23) still sees the full stream.
      MatchingEventTypes: [
        "SEND",
        "DELIVERY",
        "BOUNCE",
        "COMPLAINT",
        "REJECT",
        "OPEN",
        "CLICK",
        "RENDERING_FAILURE",
        "DELIVERY_DELAY",
      ],
    };
    try {
      await this.ses.send(
        new CreateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: configSet,
          EventDestinationName: EVENT_DESTINATION_NAME,
          EventDestination: destination,
        }),
      );
    } catch (e) {
      if ((e as { name?: string }).name !== "AlreadyExistsException") throw e;
      await this.ses.send(
        new UpdateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: configSet,
          EventDestinationName: EVENT_DESTINATION_NAME,
          EventDestination: destination,
        }),
      );
    }
  }
}
