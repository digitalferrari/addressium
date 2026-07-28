/**
 * Admin team management (docs/ARCHITECTURE.md §9.1, #226).
 *
 * ARCHITECTURE promises operators "invite the rest of the team through the
 * console". There was no such console surface and no such API, and the only way
 * a member was ever created was the deploy-time seed — which hard-codes
 * `custom:role = developer_admin` and `custom:orgs = "*"`.
 *
 * So the four-role matrix was enforced server-side while exactly one role, at
 * global scope, was reachable. A correctly-built authorization system that can
 * only ever issue root is not an authorization system, and offboarding had no
 * in-product answer at all: revoking access meant an AWS console operation
 * against the Cognito pool.
 *
 * The AWS calls sit behind `AdminDirectory` so these rules stay pure and
 * testable; the adapter does no validation of its own.
 */
import { ROLES, type Capability, type RoleName } from "@addressium/rbac";

export interface TeamMember {
  /** Cognito username — stable, unlike the email. */
  username: string;
  email: string;
  role: RoleName;
  /** Orgs this member may act on. `"*"` means every org (bootstrap only). */
  orgs: string[];
  enabled: boolean;
  status?: string;
}

/** The Cognito side effects, injected so the rules below stay unit-testable. */
export interface AdminDirectory {
  list(): Promise<TeamMember[]>;
  invite(input: { email: string; role: RoleName; orgs: string[] }): Promise<TeamMember>;
  setAccess(username: string, input: { role: RoleName; orgs: string[] }): Promise<TeamMember>;
  setEnabled(username: string, enabled: boolean): Promise<void>;
}

export const ROLE_NAMES = Object.keys(ROLES) as RoleName[];

/** Capabilities a role grants — for the console to explain what it is handing out. */
export function capabilitiesOf(role: RoleName): Capability[] {
  return [...(ROLES[role] ?? new Set<Capability>())];
}

export class TeamError extends Error {}

/**
 * Validate an access grant before it reaches Cognito.
 *
 * The wildcard is the important one. `custom:orgs = "*"` is what the bootstrap
 * seed writes so the first operator can reach the org they are about to create;
 * it is not something the product should ever hand out again. #168 was filed
 * about exactly this wildcard being honoured, and re-introducing a UI that can
 * issue it would undo that fix from the other direction.
 */
export function assertGrantable(input: { role: string; orgs: string[] }): {
  role: RoleName;
  orgs: string[];
} {
  if (!ROLE_NAMES.includes(input.role as RoleName)) {
    throw new TeamError(`unknown role: ${input.role}`);
  }
  const orgs = input.orgs.map((o) => o.trim()).filter((o) => o !== "");
  if (orgs.length === 0) {
    // A member scoped to nothing can sign in and see nothing, which reads as a
    // broken account rather than a deliberate one. Disable them instead.
    throw new TeamError("at least one organization is required");
  }
  if (orgs.includes("*")) {
    throw new TeamError(
      'the "*" org scope is reserved for the bootstrap administrator and cannot be granted in-app',
    );
  }
  if (new Set(orgs).size !== orgs.length) throw new TeamError("duplicate organization");
  return { role: input.role as RoleName, orgs };
}

/**
 * Refuse to leave the deployment with no one who can administer it.
 *
 * Disabling or demoting the last `developer_admin` locks everybody out of team
 * management permanently — the only recovery is the AWS console, which is the
 * dependency this feature exists to remove.
 */
export function assertNotLastAdmin(
  members: TeamMember[],
  username: string,
  next: { role?: RoleName; enabled?: boolean },
): void {
  const target = members.find((m) => m.username === username);
  if (!target) throw new TeamError("no such member");

  const stillAdmin =
    (next.role ?? target.role) === "developer_admin" && (next.enabled ?? target.enabled);
  if (stillAdmin) return;

  const others = members.filter(
    (m) => m.username !== username && m.role === "developer_admin" && m.enabled,
  );
  if (others.length === 0) {
    throw new TeamError(
      "this is the last enabled developer admin — promote someone else first, or you will lock everyone out",
    );
  }
}

export async function listTeam(dir: AdminDirectory): Promise<TeamMember[]> {
  return dir.list();
}

export async function inviteMember(
  dir: AdminDirectory,
  input: { email: string; role: string; orgs: string[] },
): Promise<TeamMember> {
  const { role, orgs } = assertGrantable(input);
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new TeamError("a valid email address is required");
  const existing = await dir.list();
  if (existing.some((m) => m.email.toLowerCase() === email)) {
    throw new TeamError("that address is already a member");
  }
  return dir.invite({ email, role, orgs });
}

export async function setMemberAccess(
  dir: AdminDirectory,
  username: string,
  input: { role: string; orgs: string[] },
): Promise<TeamMember> {
  const { role, orgs } = assertGrantable(input);
  assertNotLastAdmin(await dir.list(), username, { role });
  return dir.setAccess(username, { role, orgs });
}

export async function setMemberEnabled(
  dir: AdminDirectory,
  username: string,
  enabled: boolean,
): Promise<void> {
  assertNotLastAdmin(await dir.list(), username, { enabled });
  await dir.setEnabled(username, enabled);
}
