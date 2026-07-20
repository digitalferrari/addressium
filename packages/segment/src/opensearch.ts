/**
 * OpenSearch Serverless segment engine (docs/ARCHITECTURE.md §5, #28).
 *
 * The documented drop-in for full ad-hoc, arbitrary-attribute segmentation at
 * scale. DynamoDB is mirrored to OpenSearch via DynamoDB Streams (projection
 * below); this engine translates a SegmentPredicate into an OpenSearch bool
 * query and resolves/counts against the org's index. It supports everything the
 * v1 GSI engine can't — engagement recency (`last_open_at`) and arbitrary
 * attribute predicates without a base `list` condition. Opt-in (standing cost).
 *
 * The query builder + projection are pure so they're unit-tested; the transport
 * is an injected client, so no live cluster is needed to verify behavior.
 */
import type { OrgId, Subscriber, SubscriberId, Subscription } from "@addressium/core";
import type { Condition, SegmentEngine, SegmentPredicate } from "./index.js";

/** Minimal transport surface (a real @opensearch-project/opensearch client fits). */
export interface OpenSearchClient {
  search(index: string, body: unknown): Promise<{ hits: { hits: Array<{ _id: string }> } }>;
  count(index: string, body: unknown): Promise<{ count: number }>;
}

/** The document shape mirrored per subscriber. */
export interface SubscriberDoc {
  orgId: string;
  sub: string;
  email: string;
  entitlement: "free" | "paid";
  status: string;
  /** Confirmed list memberships (keyword array). */
  lists: string[];
  /** Flattened attributes under `attr.*`. */
  attr: Record<string, string>;
  /** Most recent open timestamp, if any (engagement recency). */
  last_open_at?: string;
}

export const indexForOrg = (orgId: string): string => `addressium-subscribers-${orgId}`;
export const docId = (orgId: string, sub: string): string => `${orgId}:${sub}`;

/** Project a subscriber + its confirmed subscriptions into the mirror document. */
export function projectSubscriber(
  subscriber: Subscriber,
  confirmedLists: string[],
  lastOpenAt?: string,
): SubscriberDoc {
  return {
    orgId: subscriber.orgId,
    sub: subscriber.sub,
    email: subscriber.email,
    entitlement: subscriber.entitlement,
    status: subscriber.status,
    lists: confirmedLists,
    attr: { ...subscriber.attributes },
    last_open_at: lastOpenAt,
  };
}

type Clause = { positive: unknown } | { negative: unknown };

function conditionClause(c: Condition): Clause {
  switch (c.field) {
    case "list":
      return { positive: { term: { lists: c.value } } };
    case "entitlement":
      return { positive: { term: { entitlement: c.value } } };
    case "status":
      return { positive: { term: { status: c.value } } };
    case "last_open_at":
      return { positive: { range: { last_open_at: { [c.op === "before" ? "lt" : "gt"]: c.value } } } };
    default: {
      const field = `attr.${c.field}`;
      if (c.op === "exists") return { positive: { exists: { field } } };
      if (c.op === "neq") return { negative: { term: { [field]: c.value } } };
      return { positive: { term: { [field]: c.value } } };
    }
  }
}

/** Translate a predicate into an OpenSearch bool query. */
export function buildQuery(predicate: SegmentPredicate): { query: unknown } {
  const clauses = predicate.conditions.map(conditionClause);
  if (predicate.match === "all") {
    return {
      query: {
        bool: {
          must: clauses.filter((c): c is { positive: unknown } => "positive" in c).map((c) => c.positive),
          must_not: clauses
            .filter((c): c is { negative: unknown } => "negative" in c)
            .map((c) => c.negative),
        },
      },
    };
  }
  // "any": each condition is a should clause; negations wrap in their own bool.
  const should = clauses.map((c) =>
    "positive" in c ? c.positive : { bool: { must_not: [c.negative] } },
  );
  return { query: { bool: { should, minimum_should_match: 1 } } };
}

/** An index/delete operation the stream consumer applies to OpenSearch. */
export type IndexOp =
  | { type: "index"; index: string; id: string; doc: SubscriberDoc }
  | { type: "delete"; index: string; id: string };

/**
 * Map a subscriber record (from a DynamoDB Streams event) to an OpenSearch op.
 * INSERT/MODIFY → index the projected doc; REMOVE → delete by id. The consumer
 * resolves confirmed lists + last-open before calling this (kept out so the
 * mapping stays pure/testable).
 */
export function subscriberToIndexOp(
  eventName: "INSERT" | "MODIFY" | "REMOVE",
  subscriber: Subscriber,
  confirmedLists: string[] = [],
  lastOpenAt?: string,
): IndexOp {
  const index = indexForOrg(subscriber.orgId);
  const id = docId(subscriber.orgId, subscriber.sub);
  if (eventName === "REMOVE") return { type: "delete", index, id };
  return { type: "index", index, id, doc: projectSubscriber(subscriber, confirmedLists, lastOpenAt) };
}

export class OpenSearchSegmentEngine implements SegmentEngine {
  constructor(private readonly client: OpenSearchClient) {}

  async *resolve(orgId: OrgId, predicate: SegmentPredicate): AsyncIterable<SubscriberId> {
    const body = { ...buildQuery(predicate), _source: false, size: 10_000 };
    const res = await this.client.search(indexForOrg(orgId), body);
    for (const hit of res.hits.hits) {
      // _id is `${orgId}:${sub}` — yield the subscriber id half.
      const sep = hit._id.indexOf(":");
      yield sep === -1 ? hit._id : hit._id.slice(sep + 1);
    }
  }

  async estimate(orgId: OrgId, predicate: SegmentPredicate): Promise<number> {
    const res = await this.client.count(indexForOrg(orgId), buildQuery(predicate));
    return res.count;
  }
}

// Re-export Subscription so callers building the projection have the type handy.
export type { Subscription };
