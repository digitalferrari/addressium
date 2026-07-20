/**
 * Role / capability definitions and claim parsing (docs/ARCHITECTURE.md §4.12).
 *
 * The ROLES matrix is the single source of truth for who can do what; the Cedar
 * policy set (cedar.ts) is generated from it, and enforcement runs through Cedar
 * (index.ts `authorize`). `can`/`inScope` remain for the console to mirror the
 * decision when hiding/disabling controls — convenience only, never the boundary.
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
  | "branding:manage" // subscriber-site branding + presentation toggles
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
  "branding:manage",
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
  "branding:manage",
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

const ROLE_NAMES = new Set<RoleName>(["developer_admin", "editor", "analyst", "support"]);

/**
 * Build a Grant from admin-pool JWT claims (API Gateway JWT authorizer).
 * Expects `custom:role` (a RoleName) and `custom:orgs` ("*" or a comma-separated
 * list of orgIds). Throws if the role claim is missing/invalid.
 */
export function grantFromClaims(claims: Record<string, string | undefined>): Grant {
  const role = claims["custom:role"];
  if (!role || !ROLE_NAMES.has(role as RoleName)) {
    throw new ForbiddenError("reports:view", "*");
  }
  const orgsRaw = (claims["custom:orgs"] ?? "").trim();
  // Empty ⇒ no orgs (deny by default); "*" ⇒ all orgs.
  const orgs: string[] | "*" =
    orgsRaw === "*" ? "*" : orgsRaw.split(",").map((o) => o.trim()).filter(Boolean);
  return { role: role as RoleName, orgs };
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
