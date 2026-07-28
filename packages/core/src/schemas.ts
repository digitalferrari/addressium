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

/**
 * Reusable address validator. RFC 5321 bounds an address at 254 octets, and it
 * matters here: `Subscriber.email` becomes the Cognito `Username` when an
 * account is provisioned, so anything wider fails at the directory instead of
 * at our boundary. Shared so adapters validate identically to ingest rather
 * than hand-rolling a regex (see redos.test.ts for why we don't).
 */
export const emailSchema = z.string().email().max(254);

/**
 * A tenant-supplied identifier — `orgId`, `listId`, `campaignId`, `segmentId`,
 * `templateId`, `sequenceId` (#196).
 *
 * DynamoDB is not the reason for this. The key design there is sound: composite
 * partitions have disjoint sort-key namespaces, so no cross-tenant item
 * collision was constructible. These ids leak into OTHER namespaces that are not
 * prefix-disjoint and are not ours — EventBridge Scheduler names, S3 keys,
 * Secrets Manager names, OpenSearch indices, the magic-link `issuer`, and the
 * send-claim key. `z.string().min(1)` let `#`, `/`, `:` and whitespace through
 * to all of them.
 *
 * The charset deliberately excludes `.`, `#` and `/`, which is what makes those
 * three usable as unambiguous delimiters downstream — see `scheduleName` and the
 * send-claim key. Widening this charset silently reintroduces every collision it
 * closes, so it is the single place to change and the tests say so.
 *
 * 64 characters is the EventBridge Scheduler name limit less its prefix, and
 * comfortably under every other limit in play.
 */
export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    "must be lowercase a-z, 0-9, `_` or `-`, and start with a letter or digit",
  );

/**
 * Subscriber attributes (#196).
 *
 * `z.record(z.string(), z.string())` bounded nothing, and `POST /signup` is
 * unauthenticated — so an anonymous caller could write a subscriber item up to
 * DynamoDB's 400 KB ceiling, once per address, and every later read of that
 * subscriber pays for it. The caps are generous for the real use (a handful of
 * merge tags: city, plan, first name) and cheap to raise deliberately.
 */
export const attributesSchema = z
  .record(z.string().min(1).max(64), z.string().max(1024))
  .refine((a) => Object.keys(a).length <= 32, {
    message: "at most 32 attributes",
  });

export const consentSchema = z.object({
  timestamp: z.string().datetime(),
  ip: z.string(),
  sourceUrl: z.string().url(),
});

/** Public signup payload (unauthenticated, per §4.2). */
export const signupSchema = z.object({
  orgId: idSchema,
  email: z.string().email(),
  listId: idSchema,
  attributes: attributesSchema.optional(),
  sourceUrl: z.string().url().optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

/** Multi-list signup from the "All newsletters" page — one double opt-in covers all (§4.2). */
export const signupManySchema = z.object({
  orgId: idSchema,
  email: z.string().email(),
  // Bounded (#196): the handler walks these sequentially, so an
  // unauthenticated POST with 50,000 ids was 50,000 round-trips from one
  // request. Nobody signs up to more newsletters than an org publishes.
  listIds: z.array(idSchema).min(1).max(50),
  attributes: attributesSchema.optional(),
  sourceUrl: z.string().url().optional(),
});
export type SignupManyInput = z.infer<typeof signupManySchema>;

/** Create-newsletter payload (admin). */
export const createListSchema = z.object({
  orgId: idSchema,
  listId: idSchema,
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
  orgId: idSchema,
  campaignId: idSchema,
  type: z.enum(["one_off", "series_edition"]),
  seriesId: z.string().optional(),
  subject: z.string().min(1),
  previewText: z.string().optional(),
  templateId: idSchema,
  audience: z.object({ listId: idSchema.optional(), segmentId: idSchema.optional() }),
});
export type SaveCampaignInput = z.infer<typeof saveCampaignSchema>;

/**
 * Email body blocks (mirror `EmailTemplate`/`Block` in @addressium/domain's
 * renderer): text (may hold {{merge}} tags), a tracked editorial link, or an
 * ad slot inserted verbatim. Kept in lockstep with render.ts.
 */
/**
 * Link URL restricted to safe schemes (#94). `z.string().url()` alone accepts
 * `javascript:`/`data:` (the URL constructor treats them as valid), and editorial
 * links bypass the raw-HTML sanitizer in blocks mode — so a bad scheme would
 * reach the rendered `<a href>`. Restrict to http(s)/mailto at the boundary.
 */
const safeLinkUrl = z
  .string()
  .url()
  .refine((u) => /^(https?:|mailto:)/i.test(u.trim()), {
    message: "url must be http(s) or mailto",
  });

export const emailBlockSchema = z.union([
  z.object({ kind: z.literal("text"), html: z.string() }),
  z.object({ kind: z.literal("editorial"), label: z.string().min(1), url: safeLinkUrl }),
  z.object({ kind: z.literal("ad"), slot: z.string().min(1), html: z.string() }),
]);
/**
 * A send body is one of: structured blocks, a raw-HTML string (hard-sanitized at
 * the API boundary), or `mjmlHtml` — HTML our SPA compiled from trusted MJML
 * source, which the API trusts as-is so MJML's Outlook conditional comments
 * survive (§4.15).
 */
export const emailTemplateSchema = z.union([
  z.object({ blocks: z.array(emailBlockSchema).min(1) }),
  z.object({ html: z.string().min(1) }),
  z.object({ mjmlHtml: z.string().min(1) }),
]);

/** Create/update a reusable template (§4.15). Source is MJML for visual/mjml, HTML for raw_html. */
export const saveTemplateSchema = z.object({
  orgId: idSchema,
  templateId: idSchema,
  name: z.string().min(1),
  mode: templateMode,
  source: z.string().min(1),
  mergeTags: z.array(z.string()).default([]),
  adSlots: z.array(z.string()).default([]),
});
export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;

/** Compose + schedule payload (§4.6): send now, at an instant, or recurring cron. */
export const scheduleCampaignSchema = z.object({
  orgId: idSchema,
  campaignId: idSchema,
  listId: idSchema,
  /**
   * Narrow the send to a segment's members (#203). The list is still required —
   * a segment targets WITHIN a list, and the list carries the from-address and
   * the CAN-SPAM footer every message needs.
   */
  segmentId: idSchema.optional(),
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
/**
 * Attribute names that must never be treated as a subscriber attribute (#195).
 *
 * `subscriber.attributes[field]` walks the prototype chain, so `constructor`
 * with `op: "exists"` returns `Object` — which is `!== undefined`, so the
 * condition matches EVERY subscriber. The engine also uses `Object.hasOwn` now;
 * rejecting these at save is the other half, so the segment cannot be stored in
 * the first place.
 */
const FORBIDDEN_FIELDS = ["__proto__", "constructor", "prototype"] as const;

const segmentCondition = z
  .object({
    field: z.string().min(1).max(128),
    op: z.enum(["in", "eq", "neq", "exists", "before", "after"]),
    value: z.string().optional(),
  })
  .refine((c) => !FORBIDDEN_FIELDS.includes(c.field as (typeof FORBIDDEN_FIELDS)[number]), {
    message: "field name is reserved and would match every subscriber",
    path: ["field"],
  })
  .refine((c) => c.op === "exists" || c.value !== undefined, {
    message: "value is required for every operator except `exists`",
    path: ["value"],
  });

/**
 * A segment predicate (#195). `match` is REQUIRED, which is the whole point.
 *
 * It used to be `z.unknown()`, interpreted later as
 * `predicate.match === "all" ? every : some` — so a missing or misspelled
 * `match` fell through to `some`, and combined with `case "list": return true`
 * every subscriber in the base set matched. An operator saving "paid VIPs" with
 * a typo saw a plausible preview and mailed the entire list, including the
 * recipients the segment existed to exclude.
 */
export const rulePredicateSchema = z.object({
  match: z.enum(["all", "any"]),
  // Bounded: an unbounded condition list is an amplification vector on a
  // per-subscriber evaluation loop.
  conditions: z.array(segmentCondition).min(1).max(50),
});

/**
 * An explicitly-enumerated cohort (#203) — "these five addresses", not a rule.
 *
 * The rule engine is the right tool for an audience defined by a property, and
 * the wrong one for a hand-curated test cohort: expressing "exactly these five"
 * as conditions means inventing a marker attribute and hoping nobody else has
 * it. This kind resolves to its listed members and nothing else.
 *
 * Members are subscriber ids, not addresses. An address is mutable — a
 * subscriber who changes their email would silently leave the cohort — and
 * storing addresses here would put PII in a second place with its own erasure
 * path. The console resolves address → id at add time.
 *
 * 1000 is a test-cohort bound. A segment big enough to need more is a rule.
 */
export const explicitPredicateSchema = z.object({
  match: z.literal("explicit"),
  subscriberIds: z.array(z.string().min(1).max(64)).max(1000),
});

export const segmentPredicateSchema = z.union([rulePredicateSchema, explicitPredicateSchema]);
export type SegmentPredicateInput = z.infer<typeof segmentPredicateSchema>;
export type ExplicitPredicateInput = z.infer<typeof explicitPredicateSchema>;

/** Add or remove one address from an explicit-membership segment (#203). */
export const segmentMemberSchema = z.object({
  orgId: idSchema,
  segmentId: idSchema,
  action: z.enum(["add", "remove"]),
  email: emailSchema,
});
export type SegmentMemberInput = z.infer<typeof segmentMemberSchema>;

export const saveSegmentSchema = z.object({
  orgId: idSchema,
  segmentId: idSchema,
  name: z.string().min(1),
  predicate: segmentPredicateSchema,
});
export type SaveSegmentInput = z.infer<typeof saveSegmentSchema>;

/** Create/update drip-sequence payload (admin, #104). */
export const saveDripSequenceSchema = z.object({
  orgId: idSchema,
  sequenceId: idSchema,
  name: z.string().min(1),
  trigger: z.union([
    z.object({ kind: z.literal("signup"), listId: idSchema }),
    z.object({ kind: z.literal("manual") }),
  ]),
  steps: z
    .array(
      z.object({
        stepId: idSchema,
        waitSeconds: z.number().int().min(0),
        listId: idSchema,
        templateId: idSchema,
        subject: z.string().min(1),
        requireEntitlement: entitlement.optional(),
      }),
    )
    .min(1),
});
export type SaveDripSequenceInput = z.infer<typeof saveDripSequenceSchema>;

/** Manual suppression payload (admin). */
export const manualSuppressSchema = z.object({
  orgId: idSchema,
  email: z.string().email(),
});
export type ManualSuppressInput = z.infer<typeof manualSuppressSchema>;

/** Inbound entitlement sync from the billing system of record (§4.3). */
export const entitlementSyncSchema = z.object({
  orgId: idSchema,
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
    orgId: idSchema,
    externalId: z.string().min(1),
    action: z.enum(["upsert", "delete"]).default("upsert"),
    email: z.string().email().optional(),
    attributes: attributesSchema.optional(),
    source: z.string().min(1).default("user-pool"),
  })
  .refine((d) => d.action === "delete" || !!d.email, {
    message: "email is required for an upsert",
    path: ["email"],
  });
export type IdentitySyncInput = z.infer<typeof identitySyncSchema>;

/** Add-organization / provision-silo payload (§4.11). */
/**
 * Deliverability thresholds (#217, §4.18). `haltAt` must not sit below `warnAt`
 * — inverted thresholds would halt before ever warning, which reads as a
 * mis-typed rule rather than an intended one.
 */
export const saveAlertConfigSchema = z.object({
  orgId: idSchema,
  snsTopicArn: z.string().optional(),
  rules: z
    .array(
      z
        .object({
          metric: z.enum(["complaint_rate", "bounce_rate", "send_failures", "reputation"]),
          warnAt: z.number().min(0),
          haltAt: z.number().min(0),
          enabled: z.boolean().default(true),
        })
        .refine((r) => r.haltAt >= r.warnAt, {
          message: "haltAt must be greater than or equal to warnAt",
          path: ["haltAt"],
        }),
    )
    .max(16),
  notifyTargets: z.array(z.string()).max(32).default([]),
});
export type SaveAlertConfigInput = z.infer<typeof saveAlertConfigSchema>;

export const createOrgSchema = z
  .object({
    name: z.string().min(1),
    primaryDomain: z.string().min(1),
    siteDomain: z.string().min(1),
    region: z.string().default("us-east-1"),
    /** IANA time zone for recurring send scheduling + reporting (§4.16, §4.21). */
    defaultTimezone: z.string().default("UTC"),
    /**
     * LINK an existing Cognito user pool. There is no "create" mode: a pool
     * carries far more configuration than addressium can sensibly own, and it
     * is the operator's own directory (§4.10). Only meaningful with
     * `magicLinks` on — see the refinement below.
     */
    subscriberPool: z.object({ poolId: z.string().min(1) }).optional(),
    /**
     * Per-recipient magic-link tokens: a per-org KMS signing key, a published
     * JWKS, and a signed token in every editorial link. Off by default — an org
     * that only wants email sent needs no pool, no key and no entitlement
     * plumbing (§4.9).
     */
    magicLinks: z.boolean().default(false),
    dedicatedIp: z.boolean().default(false),
    suppressionScope: z.enum(["global", "org", "hybrid"]).default("hybrid"),
    /** `dev` marks a test silo (same workflows, labeled + excluded from cost rollups). */
    environment: z.enum(["prod", "dev"]).default("prod"),
    /** Dev-org send allowlist: exact emails or `@domain` suffixes. Fail-closed for dev orgs. */
    devAllowlist: z.array(z.string()).optional(),
    /**
     * SNS topic for deliverability breach notifications (#217). Optional — the
     * org gets default halt thresholds either way; without a topic the halt is
     * silent rather than absent.
     */
    alertTopicArn: z.string().optional(),
  })
  // Pool present if and only if magic links are on. Enforced here, at the API
  // boundary, because neither half is any use without the other: a token has to
  // carry the pool's `sub` to be resolvable client-side, and a linked pool with
  // no tokens is a write to the operator's directory nobody asked for.
  .superRefine((v, ctx) => {
    if (v.magicLinks && !v.subscriberPool) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subscriberPool"],
        message: "magic links require a linked subscriber pool (the token carries the pool's sub)",
      });
    }
    if (!v.magicLinks && v.subscriberPool) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["magicLinks"],
        message: "a subscriber pool is only used for magic links — set magicLinks: true or drop subscriberPool",
      });
    }
  });
export type CreateOrgInput = z.infer<typeof createOrgSchema>;
