import { test, expect } from "bun:test";
import { HARNESS_ORDER, SURFACE_HARNESS_ORDER, type HarnessId } from "@agentistics/core";
import { planLimitsTool } from "./plan-limits-tool.js";
import { harnessIds, harnessParam } from "./session-tokens.js";

/**
 * Test that all HarnessIds are represented in the MCP server.
 *
 * CLAUDE.md forbids hardcoding harness lists anywhere in the codebase. This test ensures
 * that if a new harness is added to @agentistics/core, it's not silently missed.
 */
test("All HarnessIds from core must be in the MCP HARNESS_IDS", () => {
  const expectedHarnesses: HarnessId[] = ["claude", "codex", "gemini", "copilot", "antigravity", "kimi", "opencode"];

  // Every SURFACE harness while the native runtime is visible; the adapters alone while it is not.
  expect(harnessIds(true)).toEqual(SURFACE_HARNESS_ORDER);
  expect(harnessIds(false)).toEqual(HARNESS_ORDER);

  // HARNESS_ORDER should include all expected harnesses
  expect(HARNESS_ORDER).toContain("kimi");
  expect(HARNESS_ORDER).toHaveLength(expectedHarnesses.length);

  for (const harness of expectedHarnesses) {
    expect(HARNESS_ORDER).toContain(harness);
  }
});

test("harnessParam() includes all harnesses and 'all'", () => {
  const param = harnessParam(true);

  // Should have the correct shape
  expect(param.type).toBe("string");
  expect(param.enum).toBeDefined();
  expect(param.description).toBeDefined();

  // Should include 'all'
  expect(param.enum).toContain("all");

  // Should include kimi
  expect(param.enum).toContain("kimi");

  // Should include every surface harness, the native one included
  for (const harness of SURFACE_HARNESS_ORDER) {
    expect(param.enum).toContain(harness);
  }
});

test("plan limits MCP tool answers with a recommendation from the real payload shape", async () => {
  const { planBudget, planPace } = await import("@agentistics/core");
  const now = Date.parse("2026-10-10T00:00:00Z");
  const H = 3_600_000;
  const limits = {
    harness: "codex" as const, account: "default", plan: "Plus", updatedAt: now, source: "codex-rollout" as const,
    windows: [
      { kind: "5h" as const, usedPct: 11, resetsAt: now + 3 * H },
      { kind: "week" as const, usedPct: 35, resetsAt: now + 3 * 24 * H },
    ],
  };
  // The flat `{ ...budget, ...pace }` row, exactly as /api/plan-limits builds it.
  const budgets = [{ ...planBudget(limits as any, now), ...planPace(limits as any, now, []) }];
  const out = planLimitsTool({ kind: "spec-impl" }, { budgets, now });
  expect(out.budgets).toHaveLength(1);
  expect(out.recommendation?.harness).toBe("codex");
  expect(out.recommendation?.cadence.parallel).toBeGreaterThanOrEqual(1);
  expect(out.readAt).toBe(now);
  expect(planLimitsTool(undefined, { budgets, now }).recommendation).toBeUndefined();
});

test("plan limits MCP tool excludes unavailable harnesses and preserves their usage", async () => {
  const { planBudget, planPace } = await import("@agentistics/core");
  const now = Date.parse("2026-10-10T00:00:00Z");
  const limits = {
    harness: "codex" as const, account: "default", plan: "Plus", updatedAt: now, source: "codex-rollout" as const,
    windows: [{ kind: "5h" as const, usedPct: 11, resetsAt: now + 3_600_000 }],
  };
  const budget = {
    ...planBudget(limits, now), ...planPace(limits, now),
    spawnable: false, unavailableReason: "codex failed to start: update codex", freeSlots: 0, suggestedParallel: 0,
  };
  const out = planLimitsTool({ kind: "spec-impl" }, { budgets: [budget], now });
  expect(out.budgets[0].fiveHourPct).toBe(11);
  expect(out.budgets[0].spawnable).toBe(false);
  expect(out.freeSlots).toBe(0);
  expect(out.freeSlotsByHarness.codex).toBe(0);
  expect(out.recommendation).toMatchObject({ harness: null, alternatives: [], cadence: { parallel: 0 } });
});

test("plan limits MCP tool forwards availability without budget samples", () => {
  const harnesses = { codex: { spawnable: false, unavailableReason: "codex failed to start: update codex" } };
  const out = planLimitsTool(undefined, { budgets: [], harnesses });
  expect(out.budgets).toEqual([]);
  expect(out.harnesses).toEqual(harnesses);
});
