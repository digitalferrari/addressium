/**
 * Cognito subscriber-account provisioning (#62).
 *
 * The ONE place addressium may write to a subscriber pool. It runs on double
 * opt-in confirm for every org with magic links on — the token carries the
 * pool's `sub`, so there is nothing to opt into — and never at all for an org
 * with them off. Creates the user (with a suppressed Cognito welcome email —
 * addressium owns messaging) or, if it already exists, resolves its `sub`.
 * Returns the Cognito `sub` to stamp as the subscriber's externalId.
 */
import { randomInt } from "node:crypto";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { schemas } from "@addressium/core";
import type { SubscriberAccountProvisioner } from "@addressium/domain";

/**
 * One class per entry, so a generated password satisfies a default Cognito
 * password policy (upper + lower + digit + symbol) by construction rather than
 * by luck. Symbols are a conservative subset of the set Cognito accepts —
 * quotes and backslashes are left out so the value survives being pasted.
 */
const PASSWORD_CLASSES = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "!#$%&()*+,-.:;<=>?@[]^_{|}~",
];
/** Comfortably above every default policy minimum, and under Cognito's 256 cap. */
const PASSWORD_LENGTH = 32;

/** Uniform pick from `chars` using the CSPRNG — never Math.random for a credential. */
function pick(chars: string): string {
  return chars.charAt(randomInt(chars.length));
}

function randomPassword(): string {
  const all = PASSWORD_CLASSES.join("");
  const out = PASSWORD_CLASSES.map(pick);
  while (out.length < PASSWORD_LENGTH) out.push(pick(all));
  // Fisher-Yates: without it the first four positions would always be
  // upper/lower/digit/symbol in that order — a free hint at the shape.
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out.join("");
}

export class CognitoSubscriberAccounts implements SubscriberAccountProvisioner {
  constructor(private readonly cognito = new CognitoIdentityProviderClient({})) {}

  async ensureAccount(poolId: string, email: string): Promise<{ externalId: string }> {
    // Linked pools are email-addressable (asserted at link time in
    // provisioning.ts), so the normalized email IS the Cognito `Username` —
    // Cognito rejects any other Username shape on such a pool, which is why an
    // opaque/base64 username is not an option. Normalized exactly as every
    // ingest point does (signup.ts, identity.ts, importer.ts).
    const username = email.trim().toLowerCase();
    // Validate BEFORE any Cognito call. This string is written into a directory
    // addressium does not own, and it arrives from records that were not all
    // strictly validated (the CSV importer only requires an "@"), so this is the
    // trust boundary. Throwing is correct: the message retries and then lands in
    // the DLQ, where an unusable address is visible as the operator problem it
    // is rather than being papered over.
    if (!schemas.emailSchema.safeParse(username).success) {
      throw new Error("refusing to provision a Cognito account: not a valid email address");
    }

    try {
      const res = await this.cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: poolId,
          Username: username,
          MessageAction: "SUPPRESS", // addressium sends its own confirmation, not Cognito's
          UserAttributes: [
            { Name: "email", Value: username },
            { Name: "email_verified", Value: "true" }, // proven by the double opt-in click
          ],
        }),
      );
      // A created user sits in FORCE_CHANGE_PASSWORD with a Cognito-generated
      // temporary password that expires — an account the subscriber can never
      // use. A random PERMANENT password lands them CONFIRMED instead. It is
      // never stored, returned or logged: the subscriber reaches the account
      // through the operator's own reset/passwordless flow, exactly as they
      // would have if they had signed up on the main site.
      await this.cognito.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: poolId,
          Username: username,
          Password: randomPassword(),
          Permanent: true,
        }),
      );
      const sub = res.User?.Attributes?.find((a) => a.Name === "sub")?.Value;
      if (sub) return { externalId: sub };
    } catch (e) {
      if ((e as { name?: string }).name !== "UsernameExistsException") throw e;
    }
    // Already exists — resolve its sub. Deliberately NO password write on this
    // path: the user is the operator's, possibly a real signed-in reader, and
    // resetting their password would be a destructive write to someone else's
    // directory.
    const got = await this.cognito.send(
      new AdminGetUserCommand({ UserPoolId: poolId, Username: username }),
    );
    const sub = got.UserAttributes?.find((a) => a.Name === "sub")?.Value;
    if (!sub) throw new Error("could not resolve Cognito sub for existing user");
    return { externalId: sub };
  }
}
