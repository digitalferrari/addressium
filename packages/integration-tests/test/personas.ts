/**
 * Persona fixtures — the test actors documented in PERSONAS.md.
 *
 * A persona is a PERSON WITH DUTIES; a grant is (role x org scope). Several
 * personas share one grant on purpose: a sales rep and a marketing analyst are
 * both `analyst`, they differ in what they walk through the console to do, not
 * in what Cedar permits. So this module is keyed by persona, and RBAC
 * assertions that only care about the grant will see duplicates — that is the
 * point, not an oversight.
 *
 * `claims` is the shape the API Gateway JWT authorizer hands `grantFromClaims`
 * (an admin-pool Cognito ID token). `token_use: "id"` is explicit because the
 * server's token-type-confusion guard only fires when the claim is PRESENT
 * (roles.ts) — omitting it would silently skip the check these fixtures exist
 * to exercise.
 *
 * Non-staff personas carry `claims: null`: the public site and the preference
 * centre have no admin JWT at all. They authenticate (when they do) with a
 * magic-link token via @addressium/magiclink-verify, which is a different
 * credential on a different pool — never a role with fewer capabilities.
 *
 * Addresses are @example.com (RFC 2606). This stack sends real mail through
 * SES; a fixture must never name a deliverable address.
 */
import type { Capability, RoleName } from "@addressium/rbac";

/**
 * Whether the persona's org is fail-closed to an allowlist (dev) or may send to
 * a real list (live). Same grant, different expected send behavior — the pairing
 * is what stops a test blast reaching a live list from looking like a pass.
 *
 * "live" maps to the domain's `prod` environment; the persona vocabulary says
 * live because that is what a reviewer is being warned about.
 */
export type OrgType = "dev" | "live";

/** The org record the send path reads, for the persona's org type. */
export const orgRecordFor = (
  orgType: OrgType,
  devAllowlist: string[] = [],
): { environment: "dev" | "prod"; devAllowlist?: string[] } =>
  orgType === "dev"
    ? { environment: "dev", devAllowlist }
    : { environment: "prod" };

export interface StaffClaims {
  "custom:role": RoleName;
  /** "*" (all orgs) or a comma-separated org id list — never a list containing "*". */
  "custom:orgs": string;
  /** Always "id": access tokens carry no custom:* attributes and must be rejected. */
  token_use: "id";
}

export interface Persona {
  /** Stable key used by tests and by the review-log filenames. */
  id: string;
  /** Display name — the person, as PERSONAS.md describes them. */
  name: string;
  /** Job title / duty, which is what distinguishes personas sharing a grant. */
  job: string;
  /** Admin-pool ID token claims, or null for non-staff (no admin JWT). */
  claims: StaffClaims | null;
  /** Which app this persona actually uses. */
  surface: "admin-web" | "subscriber-web" | "public-web";
  /** Org ids the persona operates in; "*" means every org. */
  orgs: string[] | "*";
  /** Org character, for send-path expectations. Absent for non-staff. */
  orgType?: OrgType;
  email: string;
  /** Capabilities the persona MUST hold. */
  allowed: Capability[];
  /**
   * Capabilities the persona MUST NOT hold. The negative case is where the
   * interesting failures live — a hidden control whose endpoint still answers.
   */
  denied: Capability[];
}

/** Org ids used across the fixtures. `summit` and `vail` match existing tests. */
export const ORG_A = "summit";
export const ORG_B = "vail";

const staff = (
  role: RoleName,
  orgs: string[] | "*",
): StaffClaims => ({
  "custom:role": role,
  "custom:orgs": orgs === "*" ? "*" : orgs.join(","),
  token_use: "id",
});

/** Every capability in the matrix, so `denied` lists can be derived by difference. */
const ALL_CAPS: Capability[] = [
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

const except = (held: Capability[]): Capability[] =>
  ALL_CAPS.filter((c) => !held.includes(c));

const EDITOR_CAPS: Capability[] = [
  "reports:view",
  "campaigns:schedule",
  "campaigns:manage",
  "templates:manage",
  "segments:manage",
  "subscribers:manage",
  "branding:manage",
];

const SUPPORT_CAPS: Capability[] = ["reports:view", "subscribers:manage"];
const ANALYST_CAPS: Capability[] = ["reports:view"];

export const PERSONAS: Persona[] = [
  {
    id: "owner",
    name: "Dana Okafor",
    job: "Owner / operator — provisions orgs, manages the team and API keys",
    claims: staff("developer_admin", "*"),
    surface: "admin-web",
    orgs: "*",
    orgType: "live",
    email: "dana.okafor@example.com",
    allowed: ALL_CAPS,
    denied: [],
  },
  {
    id: "org-admin",
    name: "Rafael Nunes",
    job: "Org admin — full control of one tenant only",
    claims: staff("developer_admin", [ORG_A]),
    surface: "admin-web",
    orgs: [ORG_A],
    orgType: "live",
    email: "rafael.nunes@example.com",
    // Same capability set as the owner; the difference is scope, which is why
    // this persona exists — it proves `allOrgs` actually gates rather than the
    // role alone deciding.
    allowed: ALL_CAPS,
    denied: [],
  },
  {
    id: "campaign-editor",
    name: "Priya Raman",
    job: "Campaign editor — writes newsletters, builds templates, schedules sends",
    claims: staff("editor", [ORG_A]),
    surface: "admin-web",
    orgs: [ORG_A],
    orgType: "dev",
    email: "priya.raman@example.com",
    allowed: EDITOR_CAPS,
    denied: except(EDITOR_CAPS),
  },
  {
    id: "brand-editor",
    name: "Tom Whitfield",
    job: "Content & brand editor — branding and presentation across two orgs",
    claims: staff("editor", [ORG_A, ORG_B]),
    surface: "admin-web",
    orgs: [ORG_A, ORG_B],
    orgType: "live",
    email: "tom.whitfield@example.com",
    // Two orgs on purpose: the org switcher and any cross-org bleed only appear
    // at >= 2.
    allowed: EDITOR_CAPS,
    denied: except(EDITOR_CAPS),
  },
  {
    id: "sales-rep",
    name: "Marcus Ellery",
    job: "Sales rep — pulls campaign reports and per-link click maps for clients",
    claims: staff("analyst", [ORG_A]),
    surface: "admin-web",
    orgs: [ORG_A],
    orgType: "live",
    email: "marcus.ellery@example.com",
    allowed: ANALYST_CAPS,
    denied: except(ANALYST_CAPS),
  },
  {
    id: "marketing-analyst",
    name: "Wen Li",
    job: "Marketing analyst — cross-org reporting, usage and cost",
    claims: staff("analyst", "*"),
    surface: "admin-web",
    orgs: "*",
    orgType: "live",
    email: "wen.li@example.com",
    allowed: ANALYST_CAPS,
    denied: except(ANALYST_CAPS),
  },
  {
    id: "support-agent",
    name: "Aisha Bello",
    job: "Support agent — fixes subscriber records, cannot delete them",
    claims: staff("support", [ORG_A]),
    surface: "admin-web",
    orgs: [ORG_A],
    orgType: "live",
    email: "aisha.bello@example.com",
    allowed: SUPPORT_CAPS,
    // `subscribers:manage` WITHOUT `subscribers:delete` is the subtlest line in
    // the matrix; assert the gap explicitly.
    denied: except(SUPPORT_CAPS),
  },
  {
    id: "prospect",
    name: "Jordan Alvarez",
    job: "Prospect — finds the signup form and opts in",
    claims: null,
    surface: "public-web",
    orgs: [ORG_A],
    email: "jordan.alvarez@example.com",
    allowed: [],
    denied: ALL_CAPS,
  },
  {
    id: "subscriber",
    name: "Neve Carrington",
    job: "Subscriber — manages preferences without a password (magic link)",
    claims: null,
    surface: "subscriber-web",
    orgs: [ORG_A],
    email: "neve.carrington@example.com",
    allowed: [],
    denied: ALL_CAPS,
  },
  {
    id: "departing-subscriber",
    name: "Owen Bradlaw",
    job: "Departing subscriber — one-click unsubscribe, data export and erasure",
    claims: null,
    surface: "subscriber-web",
    orgs: [ORG_A],
    email: "owen.bradlaw@example.com",
    allowed: [],
    denied: ALL_CAPS,
  },
];

export const byId = (id: string): Persona => {
  const p = PERSONAS.find((x) => x.id === id);
  if (!p) throw new Error(`No persona fixture with id "${id}"`);
  return p;
};

/** Personas that hold an admin-pool token (the ones RBAC applies to). */
export const staffPersonas = (): (Persona & { claims: StaffClaims })[] =>
  PERSONAS.filter((p): p is Persona & { claims: StaffClaims } => p.claims !== null);

/** Personas with no admin JWT — public site and preference centre. */
export const endUserPersonas = (): Persona[] => PERSONAS.filter((p) => p.claims === null);

/**
 * Credential mutations applied ACROSS staff personas. These are a test axis, not
 * extra people: the same person presenting a broken or forged credential. Each
 * returns claims that `grantFromClaims` must reject.
 */
export const MUTATIONS: {
  id: string;
  why: string;
  mutate: (c: StaffClaims) => Record<string, string | undefined>;
}[] = [
  {
    id: "access-token",
    why: "An access token presented where the ID token belongs (token_use guard).",
    mutate: (c) => ({ ...c, token_use: "access" }),
  },
  {
    id: "wildcard-smuggle",
    why: '"*" inside a comma list must never widen scope to every org.',
    mutate: (c) => ({ ...c, "custom:orgs": `${ORG_A},*` }),
  },
  {
    id: "missing-role",
    why: "No role claim at all — deny by default.",
    mutate: (c) => ({ ...c, "custom:role": undefined }),
  },
  {
    id: "unknown-role",
    why: "A role outside the matrix must not fall through to a default.",
    mutate: (c) => ({ ...c, "custom:role": "wizard" }),
  },
  {
    id: "prototype-role",
    why: 'A prototype-chain name ("toString") must be rejected, not resolved.',
    mutate: (c) => ({ ...c, "custom:role": "toString" }),
  },
];

/**
 * Empty `custom:orgs` is deliberately NOT a rejected mutation: it parses into an
 * empty scope, which grants nothing at `authorize` time (deny by default) rather
 * than failing at parse time. Kept separate so the distinction stays visible —
 * it is enforced by its own test.
 */
export const EMPTY_ORGS = (c: StaffClaims): Record<string, string | undefined> => ({
  ...c,
  "custom:orgs": "",
});
