/**
 * Role-based access control for the admin plane (docs/ARCHITECTURE.md §4.12).
 *
 * Enforcement is SERVER-SIDE: every mutating API handler calls `authorize()`
 * with the caller's role, the required capability, and the target org. The
 * console mirrors this to hide/disable controls, but that is convenience only —
 * this module is the boundary.
 */

export type Capability =
  | "reports:view"
  | "campaigns:schedule" // schedule / resend / modify send times
  | "campaigns:manage" // create / edit / send
  | "templates:manage"
  | "segments:manage"
  | "subscribers:manage" // add / edit / manual unsubscribe
  | "subscribers:delete" // delete contacts (destructive)
  | "newsletters:close" // close / reopen (destructive)
  | "suppression:manage"
  | "alerts:manage"
  | "identity:manage" // pools, organizations
  | "apikeys:manage"
  | "team:manage";

export type RoleName = "developer_admin" | "editor" | "analyst" | "support";

const EDITOR: Capability[] = [
  "reports:view",
  "campaigns:schedule",
  "campaigns:manage",
  "templates:manage",
  "segments:manage",
  "subscribers:manage",
];

const ANALYST: Capability[] = ["reports:view"];

const SUPPORT: Capability[] = ["reports:view", "subscribers:manage"];

const ALL: Capability[] = [
  "reports:view",
  "campaigns:schedule",
  "campaigns:manage",
  "templates:manage",
  "segments:manage",
  "subscribers:manage",
  "subscribers:delete",
  "newsletters:close",
  "suppression:manage",
  "alerts:manage",
  "identity:manage",
  "apikeys:manage",
  "team:manage",
];

export const ROLES: Record<RoleName, ReadonlySet<Capability>> = {
  developer_admin: new Set(ALL),
  editor: new Set(EDITOR),
  analyst: new Set(ANALYST),
  support: new Set(SUPPORT),
};

/** A staff member's role plus the set of orgs it is scoped to. */
export interface Grant {
  role: RoleName;
  /** Org ids the role applies to; "*" means all orgs. */
  orgs: string[] | "*";
}

export function can(role: RoleName, capability: Capability): boolean {
  return ROLES[role].has(capability);
}

export function inScope(grant: Grant, orgId: string): boolean {
  return grant.orgs === "*" || grant.orgs.includes(orgId);
}

export class ForbiddenError extends Error {
  constructor(
    public readonly capability: Capability,
    public readonly orgId: string,
  ) {
    super(`Forbidden: missing ${capability} for org ${orgId}`);
    this.name = "ForbiddenError";
  }
}

/** Throws ForbiddenError unless the grant permits `capability` in `orgId`. */
export function authorize(grant: Grant, capability: Capability, orgId: string): void {
  if (!inScope(grant, orgId) || !can(grant.role, capability)) {
    throw new ForbiddenError(capability, orgId);
  }
}
