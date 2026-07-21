/**
 * Runtime validation schemas (zod) for the domain model in entities.ts.
 *
 * API handlers validate untrusted input with these before touching DynamoDB.
 * Only the most commonly-validated shapes are defined here to start; expand as
 * handlers are implemented. Keep these in lockstep with entities.ts.
 */
import { z } from "zod";

export const entitlement = z.enum(["free", "paid"]);
export const optInPolicy = z.enum(["single", "double"]);
export const listVisibility = z.enum(["open", "closed"]);
export const listAccess = z.enum(["free", "paid"]);
export const cadence = z.enum(["one_off", "daily", "weekly", "biweekly", "monthly"]);
export const templateMode = z.enum(["visual", "mjml", "raw_html"]);

export const consentSchema = z.object({
  timestamp: z.string().datetime(),
  ip: z.string(),
  sourceUrl: z.string().url(),
});

/** Public signup payload (unauthenticated, per §4.2). */
export const signupSchema = z.object({
  orgId: z.string().min(1),
  email: z.string().email(),
  listId: z.string().min(1),
  attributes: z.record(z.string()).optional(),
  sourceUrl: z.string().url().optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

/** Multi-list signup from the "All newsletters" page — one double opt-in covers all (§4.2). */
export const signupManySchema = z.object({
  orgId: z.string().min(1),
  email: z.string().email(),
  listIds: z.array(z.string().min(1)).min(1),
  attributes: z.record(z.string()).optional(),
  sourceUrl: z.string().url().optional(),
});
export type SignupManyInput = z.infer<typeof signupManySchema>;

/** Create-newsletter payload (admin). */
export const createListSchema = z.object({
  orgId: z.string().min(1),
  listId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  optInPolicy,
  fromAddress: z.string().email(),
  replyTo: z.string().email().optional(),
  access: listAccess.default("free"),
  visibility: listVisibility.default("open"),
  // CAN-SPAM: every list carries its compliance footer + physical address (§6).
  complianceFooter: z.string().min(1),
  physicalAddress: z.string().min(1),
});
export type CreateListInput = z.infer<typeof createListSchema>;

/** Save-campaign-draft payload (admin). */
export const saveCampaignSchema = z.object({
  orgId: z.string().min(1),
  campaignId: z.string().min(1),
  type: z.enum(["one_off", "series_edition"]),
  seriesId: z.string().optional(),
  subject: z.string().min(1),
  previewText: z.string().optional(),
  templateId: z.string().min(1),
  audience: z.object({ listId: z.string().optional(), segmentId: z.string().optional() }),
});
export type SaveCampaignInput = z.infer<typeof saveCampaignSchema>;

/**
 * Email body blocks (mirror `EmailTemplate`/`Block` in @addressium/domain's
 * renderer): text (may hold {{merge}} tags), a tracked editorial link, or an
 * ad slot inserted verbatim. Kept in lockstep with render.ts.
 */
export const emailBlockSchema = z.union([
  z.object({ kind: z.literal("text"), html: z.string() }),
  z.object({ kind: z.literal("editorial"), label: z.string().min(1), url: z.string().url() }),
  z.object({ kind: z.literal("ad"), slot: z.string().min(1), html: z.string() }),
]);
export const emailTemplateSchema = z.object({ blocks: z.array(emailBlockSchema).min(1) });

/** Compose + schedule payload (§4.6): send now, at an instant, or recurring cron. */
export const scheduleCampaignSchema = z.object({
  orgId: z.string().min(1),
  campaignId: z.string().min(1),
  listId: z.string().min(1),
  subject: z.string().min(1),
  template: emailTemplateSchema,
  when: z.union([
    z.object({ type: z.literal("now") }),
    z.object({ type: z.literal("at"), at: z.string().min(1) }),
    z.object({ type: z.literal("recurring"), cron: z.string().min(1), timezone: z.string().optional() }),
  ]),
});
export type ScheduleCampaignInput = z.infer<typeof scheduleCampaignSchema>;

/** Create/update-segment payload (admin). */
export const saveSegmentSchema = z.object({
  orgId: z.string().min(1),
  segmentId: z.string().min(1),
  name: z.string().min(1),
  predicate: z.unknown(),
});
export type SaveSegmentInput = z.infer<typeof saveSegmentSchema>;

/** Manual suppression payload (admin). */
export const manualSuppressSchema = z.object({
  orgId: z.string().min(1),
  email: z.string().email(),
});
export type ManualSuppressInput = z.infer<typeof manualSuppressSchema>;

/** Inbound entitlement sync from the billing system of record (§4.3). */
export const entitlementSyncSchema = z.object({
  orgId: z.string().min(1),
  subscriberEmail: z.string().email(),
  entitlement,
  source: z.string().min(1),
  version: z.string().min(1),
});
export type EntitlementSyncInput = z.infer<typeof entitlementSyncSchema>;

/**
 * Inbound identity sync from the main user pool / system of record (§4.3).
 * One-directional (pool → addressium); addressium never writes back to the pool.
 * `externalId` is the immutable Cognito `sub`; email is a mutable attribute, so
 * an email change is an `upsert` with the same externalId and a new email.
 */
export const identitySyncSchema = z
  .object({
    orgId: z.string().min(1),
    externalId: z.string().min(1),
    action: z.enum(["upsert", "delete"]).default("upsert"),
    email: z.string().email().optional(),
    attributes: z.record(z.string()).optional(),
    source: z.string().min(1).default("user-pool"),
  })
  .refine((d) => d.action === "delete" || !!d.email, {
    message: "email is required for an upsert",
    path: ["email"],
  });
export type IdentitySyncInput = z.infer<typeof identitySyncSchema>;

/** Add-organization / provision-silo payload (§4.11). */
export const createOrgSchema = z.object({
  name: z.string().min(1),
  primaryDomain: z.string().min(1),
  siteDomain: z.string().min(1),
  region: z.string().default("us-east-1"),
  /** IANA time zone for recurring send scheduling + reporting (§4.16, §4.21). */
  defaultTimezone: z.string().default("UTC"),
  subscriberPool: z.union([
    z.object({ mode: z.literal("create") }),
    z.object({ mode: z.literal("link"), poolId: z.string().min(1) }),
  ]),
  dedicatedIp: z.boolean().default(false),
  suppressionScope: z.enum(["global", "org", "hybrid"]).default("hybrid"),
  /** `dev` marks a test silo (same workflows, labeled + excluded from cost rollups). */
  environment: z.enum(["prod", "dev"]).default("prod"),
  /** Dev-org send allowlist: exact emails or `@domain` suffixes. Fail-closed for dev orgs. */
  devAllowlist: z.array(z.string()).optional(),
});
export type CreateOrgInput = z.infer<typeof createOrgSchema>;
