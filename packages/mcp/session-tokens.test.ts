import { test, expect } from "bun:test";
import { calcCost, sessionCostUSD, type ModelUsage } from "@agentistics/core";
import { filterSessions, sessionHarness, sessionTokens } from "./session-tokens";

function usage(over: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    ...over,
  };
}

// An Antigravity-shaped session: Opus 4.7 as the parent, Gemini 3.6 Flash subagents folded in via
// `model_usage`. The dominant model by token volume is the Gemini one (it did more of the work),
// so pricing the whole session at Opus's rate would overcharge it — this is the shape measured in
// the wild at $4.50 flat vs $2.05 per-model (2.2x).
function multiModelSession() {
  return {
    session_id: "multi-1",
    harness: "antigravity",
    model: "gemini-3.6-flash",
    model_usage: {
      "claude-opus-4-7": usage({ inputTokens: 50_000, outputTokens: 20_000 }),
      "gemini-3.6-flash": usage({ inputTokens: 400_000, outputTokens: 150_000, cacheReadInputTokens: 900_000 }),
    },
    input_tokens: 450_000,
    output_tokens: 170_000,
    cache_read_input_tokens: 900_000,
    cache_creation_input_tokens: 0,
  };
}

function singleModelSession() {
  return {
    session_id: "single-1",
    harness: "claude",
    model: "claude-sonnet-4-6",
    input_tokens: 12_345,
    output_tokens: 6_789,
    cache_read_input_tokens: 1_000,
    cache_creation_input_tokens: 500,
  };
}

test("A1 — a multi-model session is priced per model, matching sessionCostUSD, not the dominant-model flat rate", () => {
  const s = multiModelSession();
  const { cost } = sessionTokens(s);

  const perModelExpected = sessionCostUSD(s)!;
  const flatAtDominantModel = calcCost(
    {
      inputTokens: s.input_tokens,
      outputTokens: s.output_tokens,
      cacheReadInputTokens: s.cache_read_input_tokens,
      cacheCreationInputTokens: s.cache_creation_input_tokens,
      webSearchRequests: 0,
      costUSD: 0,
    },
    s.model,
  );

  expect(cost).toBeCloseTo(perModelExpected, 12);
  expect(cost).not.toBeCloseTo(flatAtDominantModel, 6);
});

test("A2 — a single-model session prices identically to the pre-fix flat calculation", () => {
  const s = singleModelSession();
  const { cost } = sessionTokens(s);

  // The pre-fix behavior this unit replaces: calcCost() with the session's single `model` label
  // applied to the aggregated four counters. For a single-model session this must be byte-identical
  // to the new per-model path — any drift here means the fix changed something it should not have.
  const preFixFlat = calcCost(
    {
      inputTokens: s.input_tokens,
      outputTokens: s.output_tokens,
      cacheReadInputTokens: s.cache_read_input_tokens,
      cacheCreationInputTokens: s.cache_creation_input_tokens,
      webSearchRequests: 0,
      costUSD: 0,
    },
    s.model,
  );

  expect(cost).toBe(preFixFlat);
});

test("sessionTokens sums all four billed counters, never just input+output", () => {
  const s = singleModelSession();
  const { input, output, cacheRead, cacheWrite } = sessionTokens(s);
  expect(input).toBe(s.input_tokens);
  expect(output).toBe(s.output_tokens);
  expect(cacheRead).toBe(s.cache_read_input_tokens);
  expect(cacheWrite).toBe(s.cache_creation_input_tokens);
});

test("a session with no model at all is UNPRICED: cost 0 here, its tokens reported as unpriced (PRICE.UNKNOWN)", () => {
  const s = { session_id: "no-model", input_tokens: 1000, output_tokens: 500 };
  const { cost, unpriced } = sessionTokens(s);
  expect(cost).toBe(0);
  expect(unpriced).toBe(1500);
});

test("a model outside the table is unpriced too — never the Sonnet price", () => {
  const { cost, unpriced } = sessionTokens({ session_id: "ghost", model: "some-new-model", input_tokens: 1000, output_tokens: 500 });
  expect(cost).toBe(0);
  expect(unpriced).toBe(1500);
  expect(sessionTokens({ session_id: "ok", model: "claude-opus-4-6", input_tokens: 1000, output_tokens: 500 }).unpriced).toBe(0);
});

test("sessionHarness defaults missing/legacy sessions to claude", () => {
  expect(sessionHarness({})).toBe("claude");
  expect(sessionHarness({ harness: "codex" })).toBe("codex");
});

test("filterSessions passes everything through for undefined/'all'", () => {
  const sessions = [{ harness: "claude" }, { harness: "codex" }];
  expect(filterSessions(sessions, undefined)).toHaveLength(2);
  expect(filterSessions(sessions, "all")).toHaveLength(2);
  expect(filterSessions(sessions, "codex")).toHaveLength(1);
});

test("sessionTokens prices 1h cache writes at the 1h rate (the same figure as the dashboards' Costs)", () => {
  const s = {
    model: "claude-opus-5-5", input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300,
    cache_creation_input_tokens: 1_000_000, cache_creation_1h_input_tokens: 1_000_000, cache_creation_5m_input_tokens: 0,
  };
  const t = sessionTokens(s);
  expect(t.cost).toBeCloseTo(sessionCostUSD(s)!, 10);
  const without1h = sessionCostUSD({ ...s, cache_creation_1h_input_tokens: undefined, cache_creation_5m_input_tokens: undefined })!;
  expect(t.cost).toBeGreaterThan(without1h);
});
