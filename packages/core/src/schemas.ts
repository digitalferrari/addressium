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

/** Create-newsletter payload (admin). */
export const createListSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  optInPolicy,
  fromAddress: z.string().email(),
  replyTo: z.string().email().optional(),
  access: listAccess.default("free"),
  visibility: listVisibility.default("open"),
});
export type CreateListInput = z.infer<typeof createListSchema>;

/** Inbound entitlement sync from the billing system of record (§4.3). */
export const entitlementSyncSchema = z.object({
  orgId: z.string().min(1),
  subscriberEmail: z.string().email(),
  entitlement,
  source: z.string().min(1),
  version: z.string().min(1),
});
export type EntitlementSyncInput = z.infer<typeof entitlementSyncSchema>;

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
});
export type CreateOrgInput = z.infer<typeof createOrgSchema>;
