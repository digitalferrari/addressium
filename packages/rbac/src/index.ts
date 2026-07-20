/**
 * Role-based access control for the admin plane (docs/ARCHITECTURE.md §4.12).
 *
 * Enforcement is SERVER-SIDE and now runs through the Cedar policy engine (#30):
 * every mutating API handler calls `authorize()`, which evaluates the caller's
 * grant + required capability + target org against the Cedar policy set derived
 * from the ROLES matrix. The console mirrors `can`/`inScope` to hide/disable
 * controls, but that is convenience only — this module is the boundary.
 */
export {
  ForbiddenError,
  ROLES,
  can,
  grantFromClaims,
  inScope,
  type Capability,
  type Grant,
  type RoleName,
} from "./roles.js";
export { CedarAuthorizer, buildPolicySet } from "./cedar.js";

import { ForbiddenError, type Capability, type Grant } from "./roles.js";
import { CedarAuthorizer } from "./cedar.js";

// One authorizer per process — it compiles the policy set from ROLES once.
let _authorizer: CedarAuthorizer | undefined;
const authorizer = () => (_authorizer ??= new CedarAuthorizer());

/** Throws ForbiddenError unless the Cedar policy set permits the request. */
export function authorize(grant: Grant, capability: Capability, orgId: string): void {
  if (!authorizer().isAllowed(grant, capability, orgId)) {
    throw new ForbiddenError(capability, orgId);
  }
}
