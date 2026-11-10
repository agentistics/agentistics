import { describe, expect, test } from "bun:test";
import { legacyHarnesses, legacyProjects, legacySummary } from "./legacy-analytics";

const session = (id: string, project_path: string, input_tokens: number) => ({
  session_id: id, project_path, input_tokens, output_tokens: 0, model: "claude-sonnet-4-6", start_time: "2026-09-01T10:00:00Z",
});

describe("legacy MCP analytics: projects roll up to their root (A4.4 decision 2)", () => {
  const data = {
    sessions: [session("a", "/p/app", 10), session("b", "/p/app/.worktrees/f", 20), session("c", "/p/other", 1)],
    projects: [
      { name: "app", path: "/p/app", sessions: [{ sessionId: "a" }] },
      { name: "f", path: "/p/app/.worktrees/f", sessions: [{ sessionId: "b" }] },
      { name: "other", path: "/p/other", sessions: [{ sessionId: "c" }] },
    ],
    statsCache: {},
  };

  test("one row per root, named after the root, sessions counted together", () => {
    const rows = legacyProjects(data) as any[];
    expect(rows.map((r) => [r.name, r.path, r.sessions, r.inputTokens])).toEqual([["app", "/p/app", 2, 30], ["other", "/p/other", 1, 1]]);
  });

  test("the summary's top project is a root", () => {
    expect((legacySummary(data) as any).topProject).toBe("/p/app");
  });
});

describe("legacy MCP summary: a harness with no statsCache still has a streak", () => {
  test("an OpenCode-only machine with sessions today reads streak 1, not null", () => {
    const now = new Date().toISOString();
    const data = { sessions: [{ session_id: "o", harness: "opencode", project_path: "/w", input_tokens: 5, output_tokens: 1, model: "upx/modelo-interno", start_time: now }], statsCache: {} };
    const s = legacySummary(data, "opencode") as any;
    expect(s.currentStreak).toBe(1);
    expect(s.totalSessions).toBe(1);
  });
});

describe("legacy MCP summary: the unified view reads every harness", () => {
  const now = new Date().toISOString();
  const data = { sessions: [{ session_id: "o", harness: "opencode", project_path: "/w", input_tokens: 5, output_tokens: 1, model: "upx/modelo-interno", start_time: now }], statsCache: {} };
  test("an OpenCode-only machine has the same streak unfiltered as filtered", () => {
    expect((legacySummary(data) as any).currentStreak).toBe(1);
  });
  test("all-unpriced usage is a null cost with unpricedTokens, never 0", () => {
    const s = legacySummary(data) as any;
    expect(s.estimatedCostUSD).toBeNull();
    expect(s.unpricedTokens).toBe(6);
  });
});

describe("legacy MCP harnesses/projects: unpriced usage is a null cost", () => {
  const data = {
    harnesses: ["opencode"],
    sessions: [{ session_id: "o", harness: "opencode", project_path: "/w", input_tokens: 5, output_tokens: 1, model: "upx/modelo-interno", start_time: new Date().toISOString() }],
    projects: [{ name: "w", path: "/w", sessions: [{ sessionId: "o" }] }],
    statsCache: {},
  };
  test("harness row", () => {
    const r = (legacyHarnesses(data) as any[])[0];
    expect(r.estimatedCostUSD).toBeNull();
    expect(r.unpricedTokens).toBe(6);
  });
  test("project row", () => {
    const r = (legacyProjects(data) as any[])[0];
    expect(r.estimatedCostUSD).toBeNull();
    expect(r.unpricedTokens).toBe(6);
  });
});
