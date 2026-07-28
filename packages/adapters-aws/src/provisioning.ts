/**
 * AWS implementation of the domain ProvisioningProviders (docs/ARCHITECTURE.md
 * §4.11). Creates/links the subscriber Cognito pool, an asymmetric KMS signing
 * key (ES256, tagged app=addressium so IAM grants scope to it), and the SES
 * domain identity + configuration set with DKIM. Public-key export → JWKS is the
 * tokens service's job (KmsJwksProvider); here we just mint the key + kid.
 */
import { KMSClient, CreateKeyCommand, CreateAliasCommand } from "@aws-sdk/client-kms";
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  UpdateConfigurationSetEventDestinationCommand,
  type EventDestinationDefinition,
} from "@aws-sdk/client-sesv2";
import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  DescribeUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type {
  ProvisioningProviders,
  SesIdentity,
  SigningKey,
  SubscriberPoolSpec,
} from "@addressium/domain";

/** Stable name so re-provisioning updates the same destination (#208). */
const EVENT_DESTINATION_NAME = "addressium-sns";

export class AwsProvisioningProviders implements ProvisioningProviders {
  constructor(
    private readonly kms = new KMSClient({}),
    private readonly ses = new SESv2Client({}),
    private readonly cognito = new CognitoIdentityProviderClient({}),
  ) {}

  async ensureSubscriberPool(orgId: string, spec: SubscriberPoolSpec): Promise<{ poolId: string }> {
    if (spec.mode === "link") {
      if (!spec.poolId) throw new Error("link mode requires an existing poolId");
      // Validate the linked pool exists before we record it.
      await this.cognito.send(new DescribeUserPoolCommand({ UserPoolId: spec.poolId }));
      return { poolId: spec.poolId };
    }
    const res = await this.cognito.send(
      new CreateUserPoolCommand({
        PoolName: `addressium-${orgId}-subscribers`,
        UsernameAttributes: ["email"],
        AutoVerifiedAttributes: ["email"],
        UserPoolTags: { app: "addressium", orgId },
      }),
    );
    const poolId = res.UserPool?.Id;
    if (!poolId) throw new Error("Cognito did not return a pool id");
    return { poolId };
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

  async ensureSesDomainIdentity(orgId: string, domain: string): Promise<SesIdentity> {
    const configSet = `addressium-${orgId}`;
    try {
      await this.ses.send(new CreateConfigurationSetCommand({ ConfigurationSetName: configSet }));
    } catch (e) {
      if ((e as { name?: string }).name !== "AlreadyExistsException") throw e;
    }
    await this.ensureEventDestination(configSet);

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
    return { configSet, dkimTokens, verificationStatus: verified ? "verified" : "pending" };
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
      // counts; `REJECT`/`RENDERING_FAILURE`/`DELIVERY_DELAY` are recorded so a
      // silent drop is visible even before a domain recorder exists for them.
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
