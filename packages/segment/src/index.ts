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
    const listCond = predicate.conditions.find(
      (c): c is { field: "list"; op: "in"; value: string } => c.field === "list" && c.op === "in",
    );
    if (!listCond) {
      throw new Error("v1 segment engine requires a `list in <listId>` base condition");
    }
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
          throw new Error("engagement predicates are not supported by the v1 segment engine (#28)");
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
