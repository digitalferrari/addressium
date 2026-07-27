/**
 * Cedar-backed authorization (docs/SECURITY.md §4.2, §10, #30).
 *
 * Enforcement moves from the hand-rolled capability check to the official Cedar
 * policy engine (@cedar-policy/cedar-wasm), keeping the exact same server-side
 * decision. The policy set is generated once from the ROLES matrix so roles and
 * capabilities stay the single source of truth; as rules grow (per-resource,
 * conditional) they become additional Cedar policies rather than more branching
 * code. Each capability is one `permit` scoped to the roles that hold it, with a
 * uniform org-scope condition (`*` or the resource's org).
 */
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { ROLES, type Capability, type Grant, type RoleName } from "./roles.js";

/** All capabilities that appear anywhere in the ROLES matrix. */
function allCapabilities(): Capability[] {
  const set = new Set<Capability>();
  for (const caps of Object.values(ROLES)) for (const c of caps) set.add(c);
  return [...set];
}

/** Roles that hold a given capability. */
function rolesWith(capability: Capability): RoleName[] {
  return (Object.keys(ROLES) as RoleName[]).filter((r) => ROLES[r].has(capability));
}

/** Generate the Cedar policy text from the ROLES matrix (one permit / capability). */
export function buildPolicySet(): string {
  return allCapabilities()
    .map((cap) => {
      const roles = rolesWith(cap).map((r) => `"${r}"`).join(", ");
      // permit when the principal's role holds the capability AND the principal
      // is scoped to all orgs ("*") or to this resource's org.
      // Scope is expressed as a dedicated boolean (`allOrgs`), never as a magic
      // "*" string inside the org set — a set-membership test would match a "*"
      // smuggled into a comma list and grant every tenant.
      return (
        `permit(principal, action == Action::"${cap}", resource)\n` +
        `when { [${roles}].contains(principal.role) &&\n` +
        `       (principal.allOrgs || principal.orgs.contains(resource.orgId)) };`
      );
    })
    .join("\n\n");
}

export class CedarAuthorizer {
  private readonly policies: string;
  constructor() {
    this.policies = buildPolicySet();
  }

  /** Cedar decision for (grant → capability on orgId). True = allow. */
  isAllowed(grant: Grant, capability: Capability, orgId: string): boolean {
    const allOrgs = grant.orgs === "*";
    // Defense in depth: even if a "*" reached the list form, it is just an org
    // id here and cannot satisfy the scope condition.
    const orgs = allOrgs ? [] : grant.orgs;
    const result = cedar.isAuthorized({
      principal: { type: "User", id: "caller" },
      action: { type: "Action", id: capability },
      resource: { type: "Org", id: orgId },
      context: {},
      policies: { staticPolicies: this.policies },
      entities: [
        { uid: { type: "User", id: "caller" }, attrs: { role: grant.role, orgs, allOrgs }, parents: [] },
        { uid: { type: "Org", id: orgId }, attrs: { orgId }, parents: [] },
      ],
    });
    return result.type === "success" && result.response.decision === "allow";
  }
}
