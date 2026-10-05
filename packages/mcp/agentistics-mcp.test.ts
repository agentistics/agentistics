import { test, expect } from "bun:test";
import { HARNESS_ORDER, SURFACE_HARNESS_ORDER, type HarnessId } from "@agentistics/core";
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
