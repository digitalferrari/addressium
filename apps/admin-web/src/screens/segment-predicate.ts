/**
 * The predicate model behind the structured segment builder (#282 / ISSUES #256).
 *
 * Kept out of the screen so the rules that decide what the builder may OFFER are
 * testable without rendering React. Those rules are not cosmetic: they are the
 * console's mirror of what the deployment can actually resolve at send time.
 *
 * WHAT THE BACKEND SUPPORTS, and what that means here:
 *
 * `segmentCondition` in packages/core/src/schemas.ts accepts six operators
 * (`in`, `eq`, `neq`, `exists`, `before`, `after`) over a free-text field. That
 * is the SAVE schema — deliberately wider than what any engine can RESOLVE. The
 * builder is sized to the resolvable subset instead, because a segment that
 * saves and then throws mid-campaign is the failure #246 was filed about.
 *
 * Resolvable, on both engines (offered as structured rows):
 *   list in <listId>        — the base set
 *   entitlement eq free|paid
 *   <attribute> eq|neq|exists <value>
 *
 * Still not offered on the GSI deployment. Each was checked against the engine rather than assumed:
 *
 *   last_open_at before|after — engagement recency. `gsiEngineLimitation`
 *     rejects it on the v1 GSI engine outright (GSI_NO_ENGAGEMENT). The
 *     OpenSearch engine can range over it; the subscriber projection now carries
 *     the provider-recorded last-open timestamp into the mirror.
 *
 *   status eq <subscription status> — dead on both engines, in opposite ways.
 *     On the GSI engine the base set is `subscriptions.listConfirmed(...)`, so
 *     every member is already confirmed: `eq confirmed` is a no-op and the other
 *     four values match nobody. On the OpenSearch engine `projectSubscriber`
 *     writes `status: subscriber.status`, and `Subscriber.status` is
 *     "active" | "suppressed" (entities.ts) — NOT `SubscriptionStatus` — so all
 *     five subscription values match nothing there either.
 *
 *   match: "any" — the builder emits `all` only. `gsiEngineLimitation` returns
 *     undefined for `any`, so the save path accepts it, and then:
 *       · with no `list` condition, `resolve` does
 *         `conditions.find(c => c.field === "list")!.value` and throws a
 *         TypeError mid-send — the #246 shape, a segment the product let them
 *         save that fails after the campaign claimed itself;
 *       · with a `list` condition, `matches` has `case "list": return true` and
 *         `any` is `conditions.some(test)`, so the list clause short-circuits
 *         every other condition to true and the segment mails the WHOLE list —
 *         the #195 shape.
 *     Both verified by driving `GsiSegmentEngine.resolve` directly. `any` stays
 *     in the raw editor, where the server answers for itself.
 *
 * Everything excluded here remains reachable from the advanced JSON editor. The
 * builder's job is to make the default path safe, not to be the only path.
 */

/** A subscriber attribute name the save schema refuses (#195). */
const FORBIDDEN_FIELDS = ["__proto__", "constructor", "prototype"];

export const ENTITLEMENT_VALUES = ["free", "paid"] as const;

/** Max conditions, mirroring `rulePredicateSchema`'s `.max(50)`. */
export const MAX_CONDITIONS = 50;

/**
 * One row in the builder.
 *
 * `kind` is the builder's own vocabulary, not the wire format — it picks which
 * editor the row renders. `toCondition` is what turns it into the schema shape.
 */
export type RowKind = "list" | "entitlement" | "attribute" | "last_open_at";

export interface Row {
  /** Stable across re-renders so React keys never reuse a deleted row's state. */
  id: string;
  kind: RowKind;
  /** Attribute name; only meaningful when `kind === "attribute"`. */
  field: string;
  /** Only `attribute` rows choose an operator; the rest are fixed by `kind`. */
  op: "eq" | "neq" | "exists" | "before" | "after";
  value: string;
}

let seq = 0;
export const newRow = (kind: RowKind = "attribute"): Row => ({
  id: `r${++seq}`,
  kind,
  field: "",
  op: "eq",
  value: "",
});

export interface Condition {
  field: string;
  /** The wire schema also supports date comparisons for engagement fields. */
  op: "in" | "eq" | "neq" | "exists" | "before" | "after";
  value?: string;
}

export interface RulePredicate {
  match: "all" | "any";
  conditions: Condition[];
}

/** The wire condition for one row, or null when the row is not yet complete. */
export function toCondition(row: Row): Condition | null {
  switch (row.kind) {
    case "list":
      return row.value ? { field: "list", op: "in", value: row.value } : null;
    case "entitlement":
      return row.value ? { field: "entitlement", op: "eq", value: row.value } : null;
    case "attribute": {
      const field = row.field.trim();
      if (!field) return null;
      // `exists` is the one operator the schema lets omit `value`, so an empty
      // box is complete here and incomplete everywhere else.
      if (row.op === "exists") return { field, op: "exists" };
      return row.value ? { field, op: row.op, value: row.value } : null;
    }
    case "last_open_at": {
      const value = row.value ? toDateWire(row.value) : null;
      return value ? { field: "last_open_at", op: row.op, value } : null;
    }
  }
}

/**
 * Why this row cannot be saved, or null.
 *
 * Mirrors the server's own refusals so the operator reads them next to the input
 * that caused them rather than as a 400 after submitting. It never PERMITS
 * anything the server would reject — the server stays the boundary.
 */
export function rowProblem(row: Row): string | null {
  if (row.kind !== "attribute" && row.kind !== "last_open_at") {
    return row.value ? null : "choose a value";
  }
  if (row.kind === "last_open_at") {
    if (row.op !== "before" && row.op !== "after") return "choose before or after";
    return row.value && Number.isFinite(Date.parse(row.value)) ? null : "choose a valid date";
  }
  const field = row.field.trim();
  if (!field) return "name the attribute";
  if (field.length > 128) return "attribute name must be 128 characters or fewer";
  if (FORBIDDEN_FIELDS.includes(field)) {
    return "that name is reserved and would match every subscriber";
  }
  if (row.op !== "exists" && !row.value) return "value is required for this operator";
  return null;
}

/**
 * Whether the builder's rows form a predicate this deployment can resolve.
 *
 * The base-list rule is the interesting one. `gsiEngineLimitation` requires a
 * `list in` condition for `match: "all"` on the v1 GSI engine; the OpenSearch
 * engine has no such requirement. Which applies depends on `SEGMENT_ENGINE`,
 * which is read server-side in `segmentsHandler` and is NOT exposed on any
 * route the console can call — so the builder cannot know which deployment it
 * is talking to.
 *
 * It therefore holds the operator to the stricter rule, which is resolvable on
 * BOTH engines. The cost is that a mirror-enabled deployment cannot build a
 * base-list-free rule in the structured path; the raw editor still can, and the
 * server still decides. The alternative — letting the builder emit a predicate
 * only some deployments accept — moves the discovery of that to a 400 at save,
 * for a control the product presented as working.
 */
export function predicateProblem(rows: Row[], requireList = true): string | null {
  if (rows.length === 0) return "Add at least one condition.";
  if (rows.length > MAX_CONDITIONS) {
    return `A segment may have at most ${MAX_CONDITIONS} conditions.`;
  }
  if (rows.some((r) => rowProblem(r))) return "Finish every condition above.";
  if (requireList && !rows.some((r) => r.kind === "list")) {
    return "Add a “Subscribed to list” condition — the shipped v1 engine resolves a rule by ranging over one list.";
  }
  return null;
}

/**
 * The rows as the predicate the API expects. Only meaningful when valid.
 *
 * `match` is always "all". See the header: `any` is accepted by the save path
 * and then either throws mid-send or mails the whole list, so the builder does
 * not emit it.
 */
export function toPredicate(rows: Row[]): RulePredicate {
  const conditions: Condition[] = [];
  for (const row of rows) {
    const c = toCondition(row);
    if (c) conditions.push(c);
  }
  return { match: "all", conditions };
}

/**
 * Read a stored predicate back into builder rows, or null if the builder cannot
 * represent it faithfully.
 *
 * Null is the important return for predicates outside the structured subset.
 * Recency is part of the structured subset when the OpenSearch deployment is
 * active; the screen still falls back to RAW for it on GSI deployments.
 */
export function fromPredicate(predicate: unknown): { rows: Row[] } | null {
  if (!predicate || typeof predicate !== "object") return null;
  const p = predicate as RulePredicate;
  // `any` is not a builder shape — see the header. It opens raw, so the operator
  // sees the predicate they actually stored rather than an `all` rewrite of it.
  if (p.match !== "all") return null;
  if (!Array.isArray(p.conditions) || p.conditions.length === 0) return null;

  const rows: Row[] = [];
  for (const c of p.conditions) {
    if (!c || typeof c !== "object" || typeof c.field !== "string") return null;
    if (c.field === "list") {
      if (c.op !== "in" || !c.value) return null;
      rows.push({ ...newRow("list"), value: c.value });
    } else if (c.field === "entitlement") {
      const v = c.value;
      if (c.op !== "eq" || v === undefined) return null;
      if (!(ENTITLEMENT_VALUES as readonly string[]).includes(v)) return null;
      rows.push({ ...newRow("entitlement"), value: v });
    } else if (c.field === "status") {
      // The builder has no `status` control (dead on both engines), so a stored
      // status condition is not representable and belongs in the raw editor.
      return null;
    } else if (c.field === "last_open_at") {
      if ((c.op !== "before" && c.op !== "after") || typeof c.value !== "string") return null;
      rows.push({ ...newRow("last_open_at"), op: c.op, value: toDateInput(c.value) });
    } else {
      // Any attribute condition — but only the three operators the builder can
      // express. `before`/`after` fall through to the raw editor.
      if (c.op !== "eq" && c.op !== "neq" && c.op !== "exists") return null;
      if (c.op !== "exists" && typeof c.value !== "string") return null;
      rows.push({ ...newRow("attribute"), field: c.field, op: c.op, value: c.value ?? "" });
    }
  }
  return { rows };
}

/** `datetime-local` cannot display an ISO suffix; keep the wire value UTC. */
export function toDateInput(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 16) : value;
}

export function toDateWire(value: string): string | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
