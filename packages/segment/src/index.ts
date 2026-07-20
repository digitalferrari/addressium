/**
 * Segment engine (docs/ARCHITECTURE.md §5, "Segmentation strategy").
 *
 * The engine lives behind an interface so the v1 GSI + materialized-tag
 * implementation can be swapped for an OpenSearch Serverless mirror when an
 * operator needs full ad-hoc segmentation — without touching callers.
 */
import type { OrgId, SubscriberId } from "@addressium/core";

/** A predicate is a tree of conditions over attributes + engagement. */
export type Condition =
  | { field: string; op: "eq" | "neq" | "exists"; value?: string }
  | { field: "last_open_at"; op: "before" | "after"; value: string }
  | { field: "list"; op: "in"; value: string }
  | { field: "entitlement"; op: "eq"; value: "free" | "paid" };

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
 * v1 implementation: resolves predicates via DynamoDB GSIs and materialized
 * tags. Covers the large majority of real list filters at ~zero idle cost.
 *
 * TODO: implement against the DynamoDB table. Stubbed so the interface and
 * wiring compile.
 */
export class GsiSegmentEngine implements SegmentEngine {
  constructor(private readonly tableName: string) {}

  // eslint-disable-next-line require-yield
  async *resolve(_orgId: OrgId, _predicate: SegmentPredicate): AsyncIterable<SubscriberId> {
    throw new Error("GsiSegmentEngine.resolve not implemented");
  }

  async estimate(_orgId: OrgId, _predicate: SegmentPredicate): Promise<number> {
    throw new Error("GsiSegmentEngine.estimate not implemented");
  }
}
