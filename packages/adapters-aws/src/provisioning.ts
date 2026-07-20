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
}
