import { describe, expect, test } from "bun:test";
import { compareObject, compareRows, sameValue } from "./surface-parity";

describe("surface parity", () => {
  test("counts and tokens must be equal; money within 0.1% or one cent", () => {
    expect(sameValue("sessions", 3, 3)).toBe(true);
    expect(sameValue("totalTokens", 100, 101)).toBe(false);
    expect(sameValue("estimatedCostUSD", 1000, 1000.9)).toBe(true);
    expect(sameValue("estimatedCostUSD", 1000, 1002)).toBe(false);
    expect(sameValue("estimatedCostUSD", 0.001, 0.009)).toBe(true);
  });

  test("rows on one side only are differences", () => {
    const r = compareRows("t", [{ k: "a", n: 1 }, { k: "b", n: 2 }], [{ k: "a", n: 1 }, { k: "c", n: 3 }], "k", ["n"]);
    expect(r).toMatchObject({ matchedRows: 1, onlyLegacy: ["b"], onlyProjected: ["c"], equal: false, diffs: [] });
  });

  test("field differences are listed by key and field", () => {
    const r = compareRows("t", [{ k: "a", n: 1, m: 2 }], [{ k: "a", n: 1, m: 5 }], "k", ["n", "m"]);
    expect(r.diffs).toEqual([{ key: "a", field: "m", legacy: 2, projected: 5 }]);
    expect(r.equal).toBe(false);
  });

  test("an object compares as one row", () => {
    expect(compareObject("s", { a: 1 }, { a: 1 }, ["a"]).equal).toBe(true);
  });
});
