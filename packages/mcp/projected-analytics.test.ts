import { describe, expect, test } from "bun:test";
// The server's own query over an in-memory reader: the projected tools are checked against the real
// `/api/runtime/metrics` contract, not a hand-written imitation of it (test-only import).
import { parseMetricsQuery, runMetricsQuery } from "../server/server/runtime-metrics-query";
import { costFact, fakeReader, runFact } from "../server/server/runtime-metrics-fixtures";
import {
  ProjectionUnavailable, projectedCosts, projectedHarnesses, projectedProjects, projectedRepos, projectedSummary, streakOf,
  type MetricsQueryFn,
} from "./projected-analytics";

function inProcess(reader: ReturnType<typeof fakeReader>): MetricsQueryFn & { calls: string[] } {
  const calls: string[] = [];
  const fn: MetricsQueryFn = async (p) => {
    calls.push(p.toString());
    const parsed = parseMetricsQuery(p);
    if (!parsed.ok) throw new Error(`bad query ${p}: ${JSON.stringify(parsed)}`);
    return { ok: true, body: await runMetricsQuery(reader, parsed.query) };
  };
  return Object.assign(fn, { calls });
}

const reader = () => fakeReader(
  [
    costFact({ sessionId: "s1", day: "2026-09-01" }),
    costFact({ sessionId: "s1", day: "2026-09-02", agentId: "sub-1", subagent: true, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, costUSD: 0.5 }),
    costFact({ sessionId: "s2", day: "2026-09-02", harness: "codex", model: "gpt-5.5", repo: "", project: "/home/u/other", costUSD: 2 }),
  ],
  [
    runFact({ sessionId: "s1", runId: "r1", day: "2026-09-01", messages: 3 }),
    runFact({ sessionId: "s2", runId: "r2", day: "2026-09-02", harness: "codex", model: "gpt-5.5", repo: "", project: "/home/u/other", messages: 4 }),
  ],
);

describe("projected MCP analytics (A4.4)", () => {
  test("harnesses: main-agent spend, subagents beside it, person turns not called messages", async () => {
    const rows = (await projectedHarnesses(inProcess(reader()))) as any[];
    expect(rows.map((r) => r.harness)).toEqual(["claude", "codex"]);
    const claude = rows[0];
    expect(claude).toMatchObject({
      sessions: 1, messages: null, personTurns: 3,
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40, totalTokens: 370,
      estimatedCostUSD: 1, subagentTokens: 4, subagentCostUSD: 0.5,
      lastActive: "2026-09-02", source: "projections",
    });
    expect(rows[1]).toMatchObject({ sessions: 1, estimatedCostUSD: 2, personTurns: 4, subagentTokens: 0 });
  });

  test("projects: keyed by path, named by basename, totalTokens is input+output as before", async () => {
    const rows = (await projectedProjects(inProcess(reader()))) as any[];
    expect(rows.map((r) => [r.name, r.path, r.totalTokens])).toEqual([["app", "/home/u/app", 30], ["other", "/home/u/other", 30]]);
    expect(rows[0].languages).toBeNull();
  });

  test("a harness scope filters every query", async () => {
    const q = inProcess(reader());
    const rows = (await projectedProjects(q, "codex")) as any[];
    expect(rows.map((r) => r.path)).toEqual(["/home/u/other"]);
    expect(q.calls.every((c) => c.includes("harness=codex"))).toBe(true);
  });

  test("repos: the unnamed bucket is 'unlinked' with remote null", async () => {
    const rows = (await projectedRepos(inProcess(reader()))) as any[];
    expect(rows.find((r) => r.repo === "unlinked")).toMatchObject({ remote: null, sessions: 1 });
    expect(rows.find((r) => r.repo === "github.com/org/app")).toMatchObject({ remote: "github.com/org/app" });
  });

  test("costs: per model, main agent", async () => {
    const rows = (await projectedCosts(inProcess(reader()))) as any[];
    expect(rows.find((r) => r.model === "claude-sonnet-5")).toMatchObject({ totalTokens: 370, estimatedCostUSD: 1, subagentCostUSD: 0.5 });
  });

  test("summary: totals, top model/project, active days and streak", async () => {
    const s = (await projectedSummary(inProcess(reader()), undefined, () => new Date("2026-09-02T10:00:00Z"))) as any;
    expect(s).toMatchObject({
      harness: "all", totalSessions: 2, totalInputTokens: 20, estimatedCostUSD: 3, subagentCostUSD: 0.5,
      activeDays: 2, currentStreak: 2, source: "projections",
    });
    expect(["claude-sonnet-5", "gpt-5.5"]).toContain(s.topModel);
  });

  test("a refusal throws ProjectionUnavailable (the caller falls back to legacy)", async () => {
    const off: MetricsQueryFn = async () => ({ ok: false, status: 404, error: "projections_disabled" });
    await expect(projectedHarnesses(off)).rejects.toBeInstanceOf(ProjectionUnavailable);
  });

  test("streak: today not over yet does not break it; a gap does", () => {
    expect(streakOf(["2026-09-01", "2026-09-02"], "2026-09-03")).toBe(2);
    expect(streakOf(["2026-09-01", "2026-09-03"], "2026-09-03")).toBe(1);
    expect(streakOf([], "2026-09-03")).toBe(0);
  });
});
