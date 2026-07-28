/**
 * Client mirror of the server id charset (#196).
 *
 * The point of the mirror is that it never *permits* something the API rejects —
 * a divergence in that direction turns a form field the console described as
 * permanent into a 400 with a raw zod issue array. These cases are the same ones
 * asserted against `idSchema` in `packages/domain/test/id-hardening.test.ts`; if
 * one side moves, both tests have to.
 */
import { expect, test } from "vitest";
import { idProblem, isValidId, suggestId, ID_MAX } from "./ids.js";

test("accepts the ids an operator actually uses", () => {
  for (const ok of ["acme", "the-ledger", "ledger_weekly", "c1", "2026-review", "a".repeat(ID_MAX)]) {
    expect(isValidId(ok), ok).toBe(true);
    expect(idProblem(ok)).toBeNull();
  }
});

test("rejects exactly what the server rejects", () => {
  for (const bad of ["promo#0", "a.b", "a/b", "a:b", "a b", "Acme", "-lead", "a".repeat(ID_MAX + 1)]) {
    expect(isValidId(bad), bad).toBe(false);
    expect(idProblem(bad), bad).not.toBeNull();
  }
});

test("an empty field is not yet an error", () => {
  // Showing "invalid" the instant a form renders trains operators to ignore it.
  expect(idProblem("")).toBeNull();
  expect(isValidId("")).toBe(false); // …but it is not submittable either
});

test("suggestId always produces something the server will accept", () => {
  for (const name of [
    "The Ledger",
    "  Lakeside Ledger!!  ",
    "Årsrapport 2026",
    "N".repeat(200),
    "a---------b",
    "2026",
  ]) {
    const id = suggestId(name);
    expect(isValidId(id), `${name} -> ${JSON.stringify(id)}`).toBe(true);
  }
});

test("suggestId matches the server's own slug derivation", () => {
  expect(suggestId("Northwind Times")).toBe("northwind-times");
  expect(suggestId("  Lakeside Ledger!! ")).toBe("lakeside-ledger");
});

test("a name that slugs to nothing suggests nothing rather than an invalid id", () => {
  // The server throws on this; the console must not offer it as a one-click fix.
  expect(suggestId("!!!")).toBe("");
  expect(isValidId(suggestId("!!!"))).toBe(false);
});
