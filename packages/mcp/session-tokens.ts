import {
  calcCost, sessionCostUSD, unpricedTokens, sumTokens, totalTokens, usageTokens, usageTokenTotal, type ModelUsage,
  HARNESS_ORDER,
} from "@agentistics/core";

export type AnySession = Record<string, any>;

export function sessionHarness(s: AnySession): string {
  return (s.harness as string) ?? "claude";
}

/** Filter sessions to a single harness, or return all for undefined/'all'. */
export function filterSessions(sessions: AnySession[], harness?: string): AnySession[] {
  if (!harness || harness === "all") return sessions;
  return sessions.filter((s) => sessionHarness(s) === harness);
}

/**
 * Token + cost breakdown of one session.
 *
 * Cost is priced per model via `sessionCostUSD` (from `@agentistics/core`) — a session that used
 * more than one model (an Antigravity parent with its subagent children folded in carries a
 * `model_usage` breakdown) is charged each model at its own rate, never the whole session at the
 * dominant model's rate. A session with no model at all (`sessionCostUSD` returns null) falls
 * is UNPRICED (PRICE.UNKNOWN): cost 0 here, its tokens reported as `unpriced`.
 */
export function sessionTokens(s: AnySession) {
  const input = s.input_tokens ?? 0;
  const output = s.output_tokens ?? 0;
  const cacheRead = s.cache_read_input_tokens ?? 0;
  const cacheWrite = s.cache_creation_input_tokens ?? 0;
  const priced = {
    model: s.model,
    model_usage: s.model_usage,
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    // The TTL split, when recorded: 1h writes bill at twice the 5m rate. Dropping it priced every
    // write at 5m, so the MCP read lower than the dashboards' Costs (A4.4 parity).
    cache_creation_1h_input_tokens: s.cache_creation_1h_input_tokens,
    cache_creation_5m_input_tokens: s.cache_creation_5m_input_tokens,
  };
  // PRICE.UNKNOWN: a model the table does not know is UNPRICED — no blended default, no guess. Its tokens
  // are in `input`/`output`/…, its cost is not in `cost`, and `unpriced` says how many tokens that is so
  // a total can admit it is a floor.
  const cost = sessionCostUSD(priced) ?? 0;
  const unpriced = unpricedTokens(priced);
  return { input, output, cacheRead, cacheWrite, cost, unpriced };
}

export function sessionMessages(s: AnySession): number {
  return (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0);
}

/**
 * All-time Claude totals read off `statsCache.modelUsage` — the fallback for a scope with no
 * sessions on disk (Claude deletes transcripts after 30 days; the cache keeps the totals).
 * statsCache is Claude-only: callers must not use this for any other harness.
 * All four counters go through `@agentistics/core`'s tokens helpers; cost is `calcCost` per model.
 */
export function statsCacheTotals(sc: { modelUsage?: Record<string, Partial<ModelUsage>> } | undefined) {
  const entries = Object.entries(sc?.modelUsage ?? {});
  const b = sumTokens(entries.map(([, u]) => usageTokens(u)));
  let cost = 0;
  let top: { model: string; n: number } | null = null;
  for (const [model, u] of entries) {
    cost += calcCost({
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
      webSearchRequests: 0,
      costUSD: 0,
    }, model);
    const n = usageTokenTotal(u);
    if (!top || n > top.n) top = { model, n };
  }
  return { ...b, tokens: totalTokens(b), cost, topModel: top?.model ?? null };
}

export const HARNESS_IDS = HARNESS_ORDER;

export function harnessParam() {
  return {
    type: "string",
    enum: ["all", ...HARNESS_ORDER],
    description: `Scope to one harness (${HARNESS_ORDER.join(" | ")}), or 'all' (default) for the unified view across every harness.`,
  } as const;
}
