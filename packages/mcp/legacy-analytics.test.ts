import { describe, expect, test } from "bun:test";
import { legacyProjects, legacySummary } from "./legacy-analytics";

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
