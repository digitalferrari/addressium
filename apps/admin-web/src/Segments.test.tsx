/**
 * Segments — the structured predicate builder (#282 / ISSUES #256).
 *
 * The builder replaced a textarea that made the operator type the internal
 * predicate schema by hand. What these tests pin down is not the markup but the
 * two rules that decide what it may OFFER, because both are the difference
 * between a segment that sends and one that fails after claiming itself:
 *
 *  1. Engagement recency is offered only when the org reports the OpenSearch
 *     engine. The GSI engine rejects `last_open_at`; OpenSearch receives the
 *     provider-recorded timestamp in the subscriber projection.
 *
 *  2. An `ALL` rule must carry a base `list` condition. `SEGMENT_ENGINE` is read
 *     server-side and exposed on no route, so the console cannot know which
 *     engine is live and holds to the rule that resolves on both.
 *
 * A stored predicate the builder cannot represent must open in the RAW editor
 * rather than being flattened into rows — that is what keeps editing a segment
 * from silently rewriting its audience.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Segments } from "./screens/Segments.js";
import { api } from "./api.js";
import {
  fromPredicate,
  predicateProblem,
  rowProblem,
  toPredicate,
  newRow,
  type Row,
} from "./screens/segment-predicate.js";
import { GsiSegmentEngine, gsiEngineLimitation, GSI_NO_ANY, GSI_MULTIPLE_LISTS, type SegmentPredicate } from "@addressium/segment";

const LISTS = [
  { orgId: "acme", listId: "ledger", name: "The Morning Ledger" },
  { orgId: "acme", listId: "weekly", name: "Weekly Brief" },
];

beforeEach(() => {
  vi.spyOn(api, "segments").mockResolvedValue([]);
  vi.spyOn(api, "lists").mockResolvedValue(LISTS as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// What the builder offers — and what it refuses to offer.
// ---------------------------------------------------------------------------

test("engagement recency is hidden on the GSI deployment", async () => {
  render(<Segments org="acme" />);
  const picker = await screen.findByLabelText("Condition type");
  const offered = Array.from(picker.querySelectorAll("option")).map((o) => o.textContent);

  expect(offered).toEqual(["Subscribed to list", "Entitlement", "Attribute"]);
  // The specific thing #246 was about: nothing in the builder produces a
  // `last_open_at` condition, under any label.
  expect(offered.join(" ").toLowerCase()).not.toContain("open");
  expect(offered.join(" ").toLowerCase()).not.toContain("engagement");
});

test("engagement recency is offered and normalized on OpenSearch", async () => {
  vi.spyOn(api, "orgMeta").mockResolvedValue({ orgId: "acme", segmentEngine: "opensearch" } as never);
  render(<Segments org="acme" />);
  const picker = await screen.findByLabelText("Condition type");
  expect(Array.from(picker.querySelectorAll("option")).map((o) => o.textContent)).toContain("Last opened");
  const user = userEvent.setup();
  await user.selectOptions(picker, "last_open_at");
  await user.selectOptions(screen.getByLabelText("Recency operator"), "before");
  await user.type(screen.getByLabelText("Recency date"), "2026-01-01T00:00");
  expect(toPredicate([{ ...newRow("last_open_at"), op: "before", value: "2026-01-01T00:00" }])).toEqual({
    match: "all", conditions: [{ field: "last_open_at", op: "before", value: new Date("2026-01-01T00:00").toISOString() }],
  });
});

test("the list condition is a picker of real lists, not a typed id", async () => {
  render(<Segments org="acme" />);
  const list = await screen.findByLabelText("List");
  const options = Array.from(list.querySelectorAll("option")).map((o) => o.textContent);
  expect(options).toContain("The Morning Ledger (ledger)");
  expect(options).toContain("Weekly Brief (weekly)");
});

test("a failed list load is said plainly, never rendered as “no lists”", async () => {
  vi.spyOn(api, "lists").mockRejectedValue(new Error("boom"));
  render(<Segments org="acme" />);
  expect(await screen.findByText(/Could not load lists/)).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// The save path: rows in, schema-shaped predicate out.
// ---------------------------------------------------------------------------

test("building a rule saves the predicate shape the API expects", async () => {
  const user = userEvent.setup();
  const saveSegment = vi.spyOn(api, "saveSegment").mockResolvedValue({
    orgId: "acme", segmentId: "paid-ledger", name: "Paid ledger", predicate: {},
  } as never);
  render(<Segments org="acme" />);

  await user.type(screen.getByPlaceholderText("segment id"), "paid-ledger");
  await user.type(screen.getByPlaceholderText("Display name"), "Paid ledger");
  await user.selectOptions(await screen.findByLabelText("List"), "ledger");

  await user.click(screen.getByRole("button", { name: "+ Add condition" }));
  const types = screen.getAllByLabelText("Condition type");
  await user.selectOptions(types[1]!, "entitlement");
  await user.selectOptions(screen.getByLabelText("Entitlement"), "paid");

  await user.click(screen.getByRole("button", { name: "Save segment" }));

  await waitFor(() => expect(saveSegment).toHaveBeenCalled());
  expect(saveSegment.mock.calls[0]![3]).toEqual({
    match: "all",
    conditions: [
      { field: "list", op: "in", value: "ledger" },
      { field: "entitlement", op: "eq", value: "paid" },
    ],
  });
});

test("an ALL rule with no base list cannot be saved, and says why", async () => {
  const user = userEvent.setup();
  const saveSegment = vi.spyOn(api, "saveSegment").mockResolvedValue({} as never);
  render(<Segments org="acme" />);

  await user.type(screen.getByPlaceholderText("segment id"), "gold");
  await user.type(screen.getByPlaceholderText("Display name"), "Gold");
  // Turn the one base-list row into an attribute row, leaving no `list`.
  await user.selectOptions(await screen.findByLabelText("Condition type"), "attribute");
  await user.type(screen.getByLabelText("Attribute name"), "plan");
  await user.type(screen.getByLabelText("Value"), "gold");

  // The hint, not the picker option of the same name.
  expect(screen.getByText(/ranges over one list/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save segment" })).toBeDisabled();
  expect(saveSegment).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// The escape hatch.
// ---------------------------------------------------------------------------

test("the advanced editor opens seeded from the builder, and can come back", async () => {
  const user = userEvent.setup();
  render(<Segments org="acme" />);
  await user.selectOptions(await screen.findByLabelText("List"), "ledger");
  await user.click(screen.getByRole("button", { name: "Advanced (JSON)" }));

  const raw = screen.getByRole("textbox", { name: /Predicate/ }) as HTMLTextAreaElement;
  expect(JSON.parse(raw.value)).toEqual({
    match: "all",
    conditions: [{ field: "list", op: "in", value: "ledger" }],
  });

  await user.click(screen.getByRole("button", { name: "Back to builder" }));
  expect(screen.getByLabelText("Condition type")).toBeInTheDocument();
});

test("editing a predicate the GSI builder cannot express opens the raw editor, not lossy rows", async () => {
  vi.spyOn(api, "orgMeta").mockResolvedValue({ orgId: "acme", segmentEngine: "gsi" } as never);
  vi.spyOn(api, "segments").mockResolvedValue([
    {
      orgId: "acme", segmentId: "lapsed", name: "Lapsed",
      predicate: {
        match: "all",
        conditions: [
          { field: "list", op: "in", value: "ledger" },
          { field: "last_open_at", op: "before", value: "2026-01-01" },
        ],
      },
    },
  ] as never);
  const user = userEvent.setup();
  render(<Segments org="acme" />);
  await user.click(await screen.findByRole("button", { name: "Edit" }));

  const raw = screen.getByRole("textbox", { name: /Predicate/ }) as HTMLTextAreaElement;
  expect(JSON.parse(raw.value).conditions).toHaveLength(2);
  expect(raw.value).toContain("last_open_at");
  expect(screen.queryByLabelText("Condition type")).not.toBeInTheDocument();
});

test("editing a predicate the builder CAN express opens as rows", async () => {
  vi.spyOn(api, "segments").mockResolvedValue([
    {
      orgId: "acme", segmentId: "paid", name: "Paid",
      predicate: {
        match: "all",
        conditions: [
          { field: "list", op: "in", value: "ledger" },
          { field: "entitlement", op: "eq", value: "paid" },
        ],
      },
    },
  ] as never);
  const user = userEvent.setup();
  render(<Segments org="acme" />);
  await user.click(await screen.findByRole("button", { name: "Edit" }));

  expect(screen.getAllByLabelText("Condition type")).toHaveLength(2);
  expect((screen.getByLabelText("List") as HTMLSelectElement).value).toBe("ledger");
  expect((screen.getByLabelText("Entitlement") as HTMLSelectElement).value).toBe("paid");
});

// ---------------------------------------------------------------------------
// The model, directly.
// ---------------------------------------------------------------------------

test("a reserved attribute name is refused — it would match every subscriber (#195)", () => {
  const row: Row = { ...newRow("attribute"), field: "constructor", op: "exists" };
  expect(rowProblem(row)).toMatch(/reserved/);
});

test("`exists` needs no value; every other operator does", () => {
  expect(rowProblem({ ...newRow("attribute"), field: "plan", op: "exists" })).toBeNull();
  expect(rowProblem({ ...newRow("attribute"), field: "plan", op: "eq", value: "" })).toMatch(/value/);
  expect(toPredicate([{ ...newRow("attribute"), field: "plan", op: "exists" }])).toEqual({
    match: "all",
    conditions: [{ field: "plan", op: "exists" }],
  });
});

test("every rule the builder emits is ALL, and needs a base list", () => {
  const rows = [{ ...newRow("attribute"), field: "plan", op: "eq" as const, value: "gold" }];
  expect(predicateProblem(rows)).toMatch(/Subscribed to list/);
  expect(toPredicate(rows).match).toBe("all");
});

test("unsupported audiences fail the shared save/send guard without yielding recipients", async () => {
  const subscriber = {
    orgId: "o", sub: "s1", email: "a@example.com",
    entitlement: "free", status: "active", attributes: { plan: "silver" },
  };
  const stores = {
    subscriptions: { listConfirmed: vi.fn(async () => [{ subscriberId: "s1", listId: "ledger", status: "confirmed" }]) },
    subscribers: { get: async () => subscriber },
  };
  const engine = new GsiSegmentEngine(stores as never);
  const cases: [SegmentPredicate, string][] = [
    [{ match: "any", conditions: [{ field: "plan", op: "eq", value: "gold" }] }, GSI_NO_ANY],
    [{ match: "any", conditions: [
      { field: "list", op: "in", value: "ledger" },
      { field: "plan", op: "eq", value: "gold" },
    ] }, GSI_NO_ANY],
    [{ match: "all", conditions: [
      { field: "list", op: "in", value: "ledger" },
      { field: "list", op: "in", value: "weekly" },
    ] }, GSI_MULTIPLE_LISTS],
  ];
  for (const [predicate, error] of cases) {
    expect(gsiEngineLimitation(predicate)).toBe(error);
    const yielded: string[] = [];
    await expect((async () => {
      for await (const id of engine.resolve("o", predicate)) yielded.push(id);
    })()).rejects.toThrow(error);
    expect(yielded).toEqual([]);
    await expect(engine.estimate("o", predicate)).rejects.toThrow(error);
  }
  expect(stores.subscriptions.listConfirmed).not.toHaveBeenCalled();
});

test("subscription status is not offered — it is dead on both engines", async () => {
  render(<Segments org="acme" />);
  const picker = await screen.findByLabelText("Condition type");
  const offered = Array.from(picker.querySelectorAll("option")).map((o) => o.textContent);
  expect(offered.join(" ").toLowerCase()).not.toContain("status");

  // A stored status condition is therefore not representable, and must open raw
  // rather than being dropped from the rows.
  expect(fromPredicate({
    match: "all",
    conditions: [
      { field: "list", op: "in", value: "ledger" },
      { field: "status", op: "eq", value: "confirmed" },
    ],
  })).toBeNull();
});

test("fromPredicate refuses what it cannot round-trip", () => {
  // before/after — the operators with no builder control.
  expect(fromPredicate({
    match: "all", conditions: [{ field: "signup_at", op: "after", value: "2026-01-01" }],
  })).toBeNull();
  // An explicit cohort is a different kind entirely.
  expect(fromPredicate({ match: "explicit", subscriberIds: [] })).toBeNull();
  // A missing/typo'd `match` — the #195 failure — is not silently coerced.
  expect(fromPredicate({ conditions: [{ field: "list", op: "in", value: "x" }] })).toBeNull();
  expect(fromPredicate({ match: "sum", conditions: [] })).toBeNull();
  // `any` opens raw rather than being rewritten into an `all` rule, which would
  // change the audience of a segment the operator only meant to look at.
  expect(fromPredicate({
    match: "any", conditions: [{ field: "list", op: "in", value: "ledger" }],
  })).toBeNull();
});
