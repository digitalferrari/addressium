/**
 * Client mirror of the server RBAC (convenience only — the API enforces).
 * Derives the caller's capabilities from the admin-pool JWT claims so the
 * console can hide/disable controls the role can't use.
 */
export type Capability =
  | "reports:view" | "campaigns:schedule" | "campaigns:manage" | "templates:manage"
  | "segments:manage" | "subscribers:manage" | "subscribers:delete" | "newsletters:close"
  | "branding:manage" | "suppression:manage" | "alerts:manage" | "identity:manage"
  | "apikeys:manage" | "team:manage";

type Role = "developer_admin" | "editor" | "analyst" | "support";

const EDITOR: Capability[] = ["reports:view","campaigns:schedule","campaigns:manage","templates:manage","segments:manage","subscribers:manage","branding:manage"];
const ROLES: Record<Role, Capability[]> = {
  developer_admin: ["reports:view","campaigns:schedule","campaigns:manage","templates:manage","segments:manage","subscribers:manage","subscribers:delete","newsletters:close","branding:manage","suppression:manage","alerts:manage","identity:manage","apikeys:manage","team:manage"],
  editor: EDITOR,
  analyst: ["reports:view"],
  support: ["reports:view","subscribers:manage"],
};

export interface Grant { role: Role; orgs: string[] | "*"; }

export function grantFromClaims(claims: Record<string, string>): Grant | null {
  const role = claims["custom:role"] as Role | undefined;
  if (!role || !(role in ROLES)) return null;
  const raw = (claims["custom:orgs"] ?? "").trim();
  const orgs = raw === "*" ? "*" : raw.split(",").map((o) => o.trim()).filter(Boolean);
  return { role, orgs };
}

export function can(grant: Grant | null, cap: Capability, org: string): boolean {
  if (!grant) return false;
  const inScope = grant.orgs === "*" || grant.orgs.includes(org);
  return inScope && ROLES[grant.role].includes(cap);
}
