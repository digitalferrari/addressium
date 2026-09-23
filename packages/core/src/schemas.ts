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
 * An import batch id (#242).
 *
 * Validated because it is a KEY in two systems: it becomes the S3 object key the
 * async job reads (`imports/<org>/<batchId>`) and the sort key of the batch
 * record. Unvalidated, a caller could put `../`, control characters or an
 * unbounded string into both. S3 treats keys as opaque bytes so this never
 * escaped the org prefix at the storage layer — but the segment lands in a URL
 * PATH, where an intermediary normalising `..` would turn a same-tenant nuisance
 * into a cross-tenant read, and the same value could clobber the status of any
 * batch in the caller's own org.
 *
 * Slightly wider than `idSchema` because the ids this route issues carry an ISO
 * timestamp: `imp_2026-07-30T12:00:00.000Z_ab12cd34`.
 */
export const batchIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must be alphanumeric with `.`, `_`, `:` or `-`, and start with a letter or digit",
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
 * One ad-slot fill as it arrives on a series payload (§4.16).
 *
 * `html` is inserted VERBATIM and never tracked (see `AdSlotFill`), so it is
 * deliberately not sanitized here — an ad tag is a third-party script snippet
 * whose whole value is being passed through untouched. That is why writing one
 * needs `campaigns:manage` rather than a weaker grant.
 *
 * `binding` is omitted from the wire shape on purpose: a fill saved through a
 * series route is series-bound by construction, and `saveCampaignSeries` stamps
 * the binding from the series it is being saved on. Accepting a caller-supplied
 * binding would let a payload claim a fill belongs to some OTHER series — a
 * cross-series write disguised as a field.
 */
export const adSlotFillSchema = z.object({
  slot: z.string().min(1).max(64),
  html: z.string().max(20000),
  version: z.number().int().nonnegative().default(1),
});
export type AdSlotFillInput = z.infer<typeof adSlotFillSchema>;

/**
 * Create or update a recurring campaign series (§4.6).
 *
 * `seriesId` is `idSchema` because it becomes a DynamoDB sort key
 * (`SERIES#<id>`) and an EventBridge schedule-name segment (`scheduleName`),
 * exactly the reasoning in #196.
 *
 * `adSlotFills` defaults to `[]` rather than being optional so that a caller
 * who omits it gets "no fills", not `undefined` — `CampaignSeries.adSlotFills`
 * is a required array and a stored `undefined` would break every reader.
 * Editing fills is a whole-array replace, which is why the Ad tags screen sends
 * the full set: a merge would make removing one fill impossible to express.
 */
export const saveCampaignSeriesSchema = z.object({
  orgId: idSchema,
  seriesId: idSchema,
  name: z.string().min(1).max(200),
  cadence,
  templateId: idSchema,
  adSlotFills: z.array(adSlotFillSchema).max(20).default([]),
});
export type SaveCampaignSeriesInput = z.infer<typeof saveCampaignSeriesSchema>;

/** Create/update an RSS, Atom or JSON Feed source for recurring editions. */
export const saveFeedSchema = z.object({
  orgId: idSchema,
  feedId: idSchema,
  url: z.string().url().refine((value) => value.startsWith("https://"), "feed URL must use https"),
  format: z.enum(["rss", "atom", "json"]),
  targetListId: idSchema,
  fieldMap: z.record(z.string(), idSchema).default({}),
  pullIntervalMins: z.number().int().min(5).max(10080).default(60),
});
export type SaveFeedInput = z.infer<typeof saveFeedSchema>;

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

export const mergeTagSource = z.enum(["profile", "feed", "system", "token_claim"]);
export const mergeTagScope = z.enum(["per_recipient", "per_campaign", "token_claim"]);

/**
 * A merge-tag name as it appears inside `{{…}}`.
 *
 * Bounded for the same reason `idSchema` is (#196): the name becomes a DynamoDB
 * sort key (`MERGETAG#<name>`), so anything that can carry a `#` or whitespace
 * can shape the key rather than occupy it. Lowercase snake_case also matches
 * what every template in the repo already writes, so the bound costs an
 * operator nothing they were actually doing.
 *
 * Deliberately NOT where reserved names are refused — a `.refine` here becomes a
 * ZodError, which `fail()` answers with one generic sentence (#265), and
 * "unsubscribe_url is reserved" is precisely the sentence the operator needs.
 * `saveMergeTag` throws `InvalidInputError` instead.
 */
export const mergeTagNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "merge tag names are lowercase letters, digits and underscores");

/** Register or update one org-defined merge tag (§4.15). */
export const saveMergeTagSchema = z.object({
  orgId: idSchema,
  name: mergeTagNameSchema,
  source: mergeTagSource,
  scope: mergeTagScope,
  example: z.string().max(200).optional(),
  fallback: z.string().max(200).optional(),
});
export type SaveMergeTagInput = z.infer<typeof saveMergeTagSchema>;

/** Remove one org-defined merge tag. Reserved names are refused in the domain, not here. */
export const deleteMergeTagSchema = z.object({ orgId: idSchema, name: mergeTagNameSchema });
export type DeleteMergeTagInput = z.infer<typeof deleteMergeTagSchema>;

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
  /** Optional configured feed used to build each recurring edition. */
  feedId: idSchema.optional(),
  subject: z.string().min(1),
  /**
   * Inbox preview line (#302). Rendered as a hidden div at the top of the body,
   * so it shows in the inbox list next to the subject and nowhere in the email.
   *
   * Capped because clients only display the first ~100-150 characters, and a
   * long one just pushes real content into the preheader slot.
   */
  previewText: z.string().max(200).optional(),
  template: emailTemplateSchema,
  /**
   * What the operator was editing, kept so the campaign can be re-opened (#298).
   *
   * NEVER sent. MJML is compiled in the browser and only the compiled html
   * reaches `template`, so without this a re-opened MJML campaign would come
   * back as html and the operator's source would be silently lost.
   */
  editorSource: z
    .object({
      mode: z.enum(["blocks", "html", "mjml"]),
      mjml: z.string().max(400_000).optional(),
    })
    .optional(),
  /**
   * Replace a pending one-off with this campaign (#308).
   *
   * The old schedule is ARCHIVED, not paused: a paused one-off used to be
   * parked and re-enqueued on resume, so an operator resuming later would send
   * both versions. Archive is terminal and the sender's gate skips it.
   */
  supersedes: idSchema.optional(),
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

/**
 * Enroll one subscriber into one manual-trigger drip sequence (admin, #245).
 *
 * `enrollmentId` is an optional idempotency key. Absent, the handler uses the
 * current instant, so two clicks of "Enroll" are two enrollments — which is the
 * honest reading of a deliberate operator action, and the opposite of the signup
 * path, where the identity is the subscriber's own opt-in request and a
 * triple-clicked confirmation link must collapse to one. A console that wants
 * click-safety sends a key.
 */
export const enrollDripSequenceSchema = z.object({
  orgId: idSchema,
  sequenceId: idSchema,
  subscriberId: z.string().min(1).max(64),
  enrollmentId: z.string().min(1).max(128).optional(),
});
export type EnrollDripSequenceInput = z.infer<typeof enrollDripSequenceSchema>;

/** Replace a subscriber's merge-tag attributes from the console (#205). */
export const setSubscriberAttributesSchema = z.object({
  orgId: idSchema,
  sub: z.string().min(1).max(64),
  attributes: attributesSchema,
});
export type SetSubscriberAttributesInput = z.infer<typeof setSubscriberAttributesSchema>;

/**
 * Set one subscription's status from the console (#205).
 *
 * `acknowledgeManualConfirmation` is required for `confirmed` and is enforced
 * again in the domain — a flag that only the client checks is not a safeguard.
 * `bounced` and `complained` are deliberately absent: those are facts SES
 * reports about a delivery, not states an operator asserts, and letting a human
 * type one in would corrupt the deliverability signal the halt logic reads.
 */
export const setSubscriptionStatusSchema = z.object({
  orgId: idSchema,
  sub: z.string().min(1).max(64),
  listId: idSchema,
  status: z.enum(["pending", "confirmed", "unsubscribed"]),
  acknowledgeManualConfirmation: z.boolean().optional(),
});
export type SetSubscriptionStatusInput = z.infer<typeof setSubscriptionStatusSchema>;

/**
 * Manual suppression payload (admin, #247).
 *
 * `source` is optional and narrowed to the three an operator can meaningfully
 * pick: `manual` (no stated reason, stays org-scoped) or `bounce`/`complaint`
 * (an operator recording what SES would otherwise have told us — see
 * `scopeForSuppressionSource`, which is what actually decides the scope this
 * lands at). `unsubscribe` and `inactive` are system-written sources with no
 * "an admin typed this in" equivalent, so they are not offered here.
 */
export const manualSuppressSchema = z.object({
  orgId: idSchema,
  email: z.string().email(),
  source: z.enum(["manual", "bounce", "complaint"]).optional(),
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

/** Per-organization engagement-based sunset / win-back policy. */
export const saveReengagementSchema = z
  .object({
    orgId: idSchema,
    enabled: z.boolean().default(false),
    coldAfterDays: z.number().int().min(1).max(3650),
    steps: z.number().int().min(1).max(10),
    stepIntervalDays: z.number().int().min(1).max(365),
    suppressScope: z.enum(["org", "global"]).default("org"),
    listId: idSchema.optional(),
  })
  .refine((value) => !value.enabled || !!value.listId, {
    message: "listId is required when re-engagement is enabled",
    path: ["listId"],
  });
export type SaveReengagementInput = z.infer<typeof saveReengagementSchema>;

/** Per-organization customer-record sync destination. */
export const saveCustomerSyncSchema = z.object({
  orgId: idSchema,
  endpoint: z.string().url().refine((value) => value.startsWith("https://"), "endpoint must use https"),
  tableName: z.string().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/, "table name may contain only letters, numbers, _, . or -"),
  secret: z.string().min(1).max(4096).optional(),
  enabled: z.boolean().default(true),
});
export type SaveCustomerSyncInput = z.infer<typeof saveCustomerSyncSchema>;

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
    /**
     * DMARC enforcement to publish (#200). Defaults to `none` — monitor only —
     * because turning on enforcement before you have read the aggregate reports
     * quarantines or rejects your own legitimate mail from senders you forgot
     * about. It is a starting point, not a resting point; the DNS guidance
     * returned by provisioning says so.
     */
    dmarcPolicy: z.enum(["none", "quarantine", "reject"]).default("none"),
    /**
     * An SES dedicated IP pool you have already created (#237). addressium does
     * not create pools — they are a standing charge and need a warm-up plan, so
     * provisioning one from a checkbox would bill you for infrastructure you did
     * not knowingly ask for. This REPLACES the old `dedicatedIp` boolean, which
     * set a field nothing read: no pool was ever created or assigned, so an org
     * marked "dedicated" sent on shared IPs with a record claiming otherwise.
     */
    dedicatedIpPoolName: z.string().min(1).optional(),
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

// ---- API keys (#280) ----

/**
 * A key's permission set (§4.12, #280). Mirrors `ApiKeyScope` in entities.ts as
 * a closed zod enum, so an unknown scope is refused at the boundary rather than
 * stored and silently never matched.
 */
export const apiKeyScope = z.enum([
  "subscribers:read",
  "subscribers:write",
  "entitlement:write",
  "campaigns:read",
  "suppression:write",
]);

/**
 * Issue one API key.
 *
 * `keyId` is `idSchema` for the same reason every other tenant id is: it becomes
 * a DynamoDB sort key (`APIKEY#<keyId>`), and an unvalidated one could shape the
 * key rather than occupy it.
 *
 * At least one scope is required. A key scoped to nothing is a credential that
 * authenticates and then may do nothing — it reads as a broken integration
 * rather than a deliberate one, exactly as `assertGrantable` argues for a member
 * scoped to no org. `.min(1)` here is a ZodError (a generic 400); the duplicate
 * check lives in `issueApiKey` as an `InvalidInputError` so the operator reads
 * WHICH scope repeated.
 */
export const issueApiKeySchema = z.object({
  orgId: idSchema,
  keyId: idSchema,
  name: z.string().min(1).max(120),
  scopes: z.array(apiKeyScope).min(1),
});
export type IssueApiKeyInput = z.infer<typeof issueApiKeySchema>;

/** Revoke one API key. Revocation keeps the row — see `ApiKeyStore`. */
export const revokeApiKeySchema = z.object({ orgId: idSchema, keyId: idSchema });
export type RevokeApiKeyInput = z.infer<typeof revokeApiKeySchema>;

export const saveSettingsSchema = z.object({
  orgId: idSchema,
  hourlyEnabled: z.boolean(),
});
export type SaveSettingsInput = z.infer<typeof saveSettingsSchema>;
