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

export interface SegmentPredicate {
  match: "all" | "any";
  conditions: Condition[];
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
          const attr = subscriber.attributes[c.field];
          if (c.op === "exists") return attr !== undefined;
          if (c.op === "neq") return attr !== c.value;
          return attr === c.value; // "eq"
        }
      }
    };
    return predicate.match === "all"
      ? predicate.conditions.every(test)
      : predicate.conditions.some(test);
  }
}
