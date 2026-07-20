/**
 * Cognito subscriber-account provisioning (opt-in, #62).
 *
 * The ONE place addressium may write to a subscriber pool, used only when the
 * org sets `signupProtection.createAccountsOnConfirm`. Creates the user (with a
 * suppressed Cognito welcome email — addressium owns messaging) or, if it
 * already exists, resolves its `sub`. Returns the Cognito `sub` to stamp as the
 * subscriber's externalId.
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { SubscriberAccountProvisioner } from "@addressium/domain";

export class CognitoSubscriberAccounts implements SubscriberAccountProvisioner {
  constructor(private readonly cognito = new CognitoIdentityProviderClient({})) {}

  async ensureAccount(poolId: string, email: string): Promise<{ externalId: string }> {
    try {
      const res = await this.cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: poolId,
          Username: email,
          MessageAction: "SUPPRESS", // addressium sends its own confirmation, not Cognito's
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" }, // proven by the double opt-in click
          ],
        }),
      );
      const sub = res.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
      if (sub) return { externalId: sub };
    } catch (e) {
      if ((e as { name?: string }).name !== "UsernameExistsException") throw e;
    }
    // Already exists — resolve its sub.
    const got = await this.cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }));
    const sub = got.UserAttributes?.find((a) => a.Name === "sub")?.Value;
    if (!sub) throw new Error("could not resolve Cognito sub for existing user");
    return { externalId: sub };
  }
}
