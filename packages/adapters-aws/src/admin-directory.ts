/**
 * Cognito-backed admin directory (#226).
 *
 * The operator's ADMIN pool — distinct from the per-org subscriber pool this
 * application only ever links to. This one addressium does own: it is created
 * by the stack and holds the console's own users, so managing members here is
 * managing our own resource rather than reaching into the operator's directory.
 *
 * All validation lives in `@addressium/domain`'s team rules. This adapter
 * deliberately does none of its own — two places deciding who may be granted
 * what is how the two drift.
 */
import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AdminDirectory, TeamMember } from "@addressium/domain";
import type { RoleName } from "@addressium/rbac";

const attr = (u: UserType, name: string): string | undefined =>
  u.Attributes?.find((a) => a.Name === name)?.Value;

function toMember(u: UserType): TeamMember {
  return {
    username: u.Username ?? "",
    email: attr(u, "email") ?? "",
    // A member whose role attribute is missing or unrecognised is surfaced as
    // the least-privileged role rather than hidden: an account that exists but
    // renders nowhere is worse than one shown with narrow access.
    role: (attr(u, "custom:role") as RoleName) ?? "analyst",
    orgs: (attr(u, "custom:orgs") ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    enabled: u.Enabled ?? false,
    ...(u.UserStatus ? { status: u.UserStatus } : {}),
  };
}

export class CognitoAdminDirectory implements AdminDirectory {
  constructor(
    private readonly poolId: string,
    private readonly cognito = new CognitoIdentityProviderClient({}),
  ) {}

  async list(): Promise<TeamMember[]> {
    const out: TeamMember[] = [];
    let token: string | undefined;
    // Paginate: a truncated member list would silently hide someone's access,
    // and "who can reach this system" is exactly the question that must be
    // answered completely.
    do {
      const res = await this.cognito.send(
        new ListUsersCommand({ UserPoolId: this.poolId, Limit: 60, PaginationToken: token }),
      );
      for (const u of res.Users ?? []) out.push(toMember(u));
      token = res.PaginationToken;
    } while (token);
    return out;
  }

  async invite(input: { email: string; role: RoleName; orgs: string[] }): Promise<TeamMember> {
    const res = await this.cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: this.poolId,
        Username: input.email,
        // Cognito emails the invite with a temporary password. We deliberately
        // do NOT suppress it here, unlike subscriber accounts: this message is
        // the invitation, not marketing we own.
        UserAttributes: [
          { Name: "email", Value: input.email },
          { Name: "email_verified", Value: "true" },
          { Name: "custom:role", Value: input.role },
          { Name: "custom:orgs", Value: input.orgs.join(",") },
        ],
      }),
    );
    return toMember(res.User ?? { Username: input.email });
  }

  async setAccess(username: string, input: { role: RoleName; orgs: string[] }): Promise<TeamMember> {
    await this.cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: this.poolId,
        Username: username,
        UserAttributes: [
          { Name: "custom:role", Value: input.role },
          { Name: "custom:orgs", Value: input.orgs.join(",") },
        ],
      }),
    );
    const all = await this.list();
    const found = all.find((m) => m.username === username);
    if (!found) throw new Error(`member disappeared during update: ${username}`);
    return found;
  }

  async setEnabled(username: string, enabled: boolean): Promise<void> {
    await this.cognito.send(
      enabled
        ? new AdminEnableUserCommand({ UserPoolId: this.poolId, Username: username })
        : new AdminDisableUserCommand({ UserPoolId: this.poolId, Username: username }),
    );
  }
}
