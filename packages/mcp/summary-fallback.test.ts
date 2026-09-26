import { test, expect } from "bun:test";
import { calcCost } from "@agentistics/core";
import { statsCacheTotals } from "./session-tokens";

const modelUsage = {
  "claude-sonnet-4-6": {
    inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 3000, cacheCreationInputTokens: 40,
    webSearchRequests: 0, costUSD: 0,
  },
  "claude-opus-4-6": {
    inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 30, cacheCreationInputTokens: 4,
    webSearchRequests: 0, costUSD: 0,
  },
};

test("no sessions + populated modelUsage: fallback returns modelUsage totals, not 0", () => {
  const t = statsCacheTotals({ modelUsage });
  expect(t.input).toBe(101);
  expect(t.output).toBe(202);
  expect(t.cacheRead).toBe(3030);
  expect(t.cacheWrite).toBe(44);
  expect(t.tokens).toBe(101 + 202 + 3030 + 44);
  const expected = Object.entries(modelUsage).reduce(
    (a, [m, u]) => a + calcCost({ ...u }, m), 0);
  expect(t.cost).toBeCloseTo(expected, 10);
  expect(t.cost).toBeGreaterThan(0);
  expect(t.topModel).toBe("claude-sonnet-4-6");
});

test("missing/empty statsCache yields zeros", () => {
  expect(statsCacheTotals(undefined).tokens).toBe(0);
  expect(statsCacheTotals({}).topModel).toBeNull();
});
