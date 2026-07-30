/**
 * Segment engine (docs/ARCHITECTURE.md §5, "Segmentation strategy").
 *
 * The engine lives behind an interface so the v1 GSI + materialized-tag
 * implementation can be swapped for an OpenSearch Serverless mirror (#28) when
 * an operator needs full ad-hoc segmentation — without touching callers.
 */
import type { OrgId, Subscriber, Subscription, SubscriberId } from "@addressium/core";
import type { Stores } from "@addressium/domain";

/** A predicate is a set of conditions over attributes + engagement. */
export type Condition =
  | { field: "list"; op: "in"; value: string }
  | { field: "entitlement"; op: "eq"; value: "free" | "paid" }
  | { field: "status"; op: "eq"; value: string }
  | { field: "last_open_at"; op: "before" | "after"; value: string }
  | { field: string; op: "eq" | "neq" | "exists"; value?: string };

/** A rule-based audience: conditions over attributes, entitlement and engagement. */
export interface RulePredicate {
  match: "all" | "any";
  conditions: Condition[];
}

/**
 * A hand-enumerated cohort (#203) — "exactly these subscribers".
 *
 * Kept as a separate kind rather than squeezed into `conditions`, because
 * expressing "exactly these five" as a rule means inventing a marker attribute
 * and hoping it stays unique. Members are subscriber ids: an address is mutable,
 * so a subscriber who changed their email would silently drop out of the cohort.
 */
export interface ExplicitPredicate {
  match: "explicit";
  subscriberIds: SubscriberId[];
}

export type SegmentPredicate = RulePredicate | ExplicitPredicate;

export function isExplicit(p: SegmentPredicate): p is ExplicitPredicate {
  return (p as ExplicitPredicate).match === "explicit";
}

export interface SegmentEngine {
  /** Stream matching subscriber ids for a send (org-scoped). */
  resolve(orgId: OrgId, predicate: SegmentPredicate): AsyncIterable<SubscriberId>;
  /** Estimated match count for the builder preview. */
  estimate(orgId: OrgId, predicate: SegmentPredicate): Promise<number>;
}

/**
 * v1 implementation: a `list in <listId>` condition selects the base set
 * (confirmed members) via a GSI query, then attribute/entitlement conditions
 * filter it. Engagement-recency predicates (`last_open_at`) are out of scope for
 * v1 — use the OpenSearch mirror (#28).
 */
export * from "./opensearch.js";

export const GSI_NO_BASE_LIST = "v1 segment engine requires a `list in <listId>` base condition";
export const GSI_NO_ENGAGEMENT =
  "engagement predicates are not supported by the v1 segment engine (#28)";

/**
 * Why the v1 GSI engine cannot resolve this predicate, or undefined if it can
 * (#246).
 *
 * Extracted from `resolve` so the SAVE path can ask the same question the SEND
 * path answers, from the same code. It matters that these are one function: the
 * console offers engagement recency in its segment builder and the save schema
 * accepts it, so before #246 an operator could store a predicate that was
 * guaranteed to throw — and find out mid-campaign, from a send that had already
 * claimed itself. Two copies of this rule would put that failure back the first
 * time one of them changed.
 *
 * The OpenSearch engine has neither limitation, which is exactly why the answer
 * depends on which engine the deployment actually runs.
 */
export function gsiEngineLimitation(predicate: SegmentPredicate): string | undefined {
  // An explicit cohort names its members outright — no engine resolves it by
  // query, so neither engine's limits apply.
  if (isExplicit(predicate)) return undefined;
  if (predicate.conditions.some((c) => c.field === "last_open_at")) return GSI_NO_ENGAGEMENT;
  // `match: "any"` fans out per condition and needs no base set; only the
  // intersecting form ranges over one list.
  if (predicate.match === "any") return undefined;
  const hasBase = predicate.conditions.some((c) => c.field === "list" && c.op === "in");
  return hasBase ? undefined : GSI_NO_BASE_LIST;
}

export class GsiSegmentEngine implements SegmentEngine {
  constructor(private readonly stores: Stores) {}

  async *resolve(orgId: OrgId, predicate: SegmentPredicate): AsyncIterable<SubscriberId> {
    yield* this.matching(orgId, predicate);
  }

  async estimate(orgId: OrgId, predicate: SegmentPredicate): Promise<number> {
    let n = 0;
    for await (const _ of this.matching(orgId, predicate)) n++;
    return n;
  }

  private async *matching(orgId: OrgId, predicate: SegmentPredicate): AsyncIterable<SubscriberId> {
    if (isExplicit(predicate)) {
      // Deduplicated and existence-checked, in the stored order.
      //
      // An id that no longer resolves is skipped rather than yielded: a deleted
      // or erased subscriber must not reach the send path, where "unknown
      // subscriber" would burn a send claim before failing. This is also what
      // makes an erasure (#101) take effect on a test cohort without anyone
      // having to remember to prune it.
      //
      // Suppression is NOT checked here. It is enforced per recipient in
      // `mayMail` on the send path, which is the single place that has to be
      // right — a second check here would drift and imply the send path's was
      // optional. The segment test asserts the end-to-end behaviour.
      const seen = new Set<SubscriberId>();
      for (const id of predicate.subscriberIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        const subscriber = await this.stores.subscribers.get(orgId, id);
        if (subscriber) yield subscriber.sub;
      }
      return;
    }
    const limitation = gsiEngineLimitation(predicate);
    if (limitation) throw new Error(limitation);
    const listCond = predicate.conditions.find(
      (c): c is { field: "list"; op: "in"; value: string } => c.field === "list" && c.op === "in",
    )!;
    const base: Subscription[] = await this.stores.subscriptions.listConfirmed(orgId, listCond.value);
    for (const sub of base) {
      const subscriber = await this.stores.subscribers.get(orgId, sub.subscriberId);
      if (subscriber && this.matches(subscriber, sub, predicate)) {
        yield subscriber.sub;
      }
    }
  }

  private matches(
    subscriber: Subscriber,
    subscription: Subscription,
    predicate: SegmentPredicate,
  ): boolean {
    const test = (c: Condition): boolean => {
      switch (c.field) {
        case "list":
          return true; // base set already filtered by list membership
        case "entitlement":
          return subscriber.entitlement === c.value;
        case "status":
          return subscription.status === c.value;
        case "last_open_at":
          // Unreachable via `resolve`, which rejects the predicate up front via
          // `gsiEngineLimitation`. Kept as the second line for any caller that
          // reaches `matches` another way.
          throw new Error(GSI_NO_ENGAGEMENT);
        default: {
          // `Object.hasOwn`, not `attributes[field] !== undefined` (#195):
          // indexing walks the prototype chain, so `field: "constructor"` with
          // `op: "exists"` returns `Object` and matched EVERY subscriber. The
          // save schema rejects those names too — this is the second line, for
          // predicates already stored and for any caller that bypasses the API.
          if (!Object.hasOwn(subscriber.attributes, c.field)) {
            // An absent attribute is "not equal" to any value, which is what
            // `neq` should say — but it exists for nobody and equals nothing.
            return c.op === "neq";
          }
          const attr = subscriber.attributes[c.field];
          if (c.op === "exists") return true;
          if (c.op === "neq") return attr !== c.value;
          return attr === c.value; // "eq"
        }
      }
    };
    // Fail CLOSED on an unrecognised `match` (#195). The schema requires it, but
    // a predicate stored before that schema existed could still carry a typo,
    // and defaulting to `some` is what turned a narrow segment into the whole
    // list. `every` is the safe direction: too few recipients is a visible
    // mistake, too many is an unrecallable one.
    if (predicate.match !== "all" && predicate.match !== "any") {
      throw new Error(
        `segment predicate has an invalid \`match\`: ${JSON.stringify(predicate.match)} — expected "all" or "any"`,
      );
    }
    return predicate.match === "all"
      ? predicate.conditions.every(test)
      : predicate.conditions.some(test);
  }
}
