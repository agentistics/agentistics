import {
  calcCost, sessionCostUSD, unpricedTokens, sumTokens, totalTokens, usageTokens, usageTokenTotal, type ModelUsage,
  surfaceHarnesses, type SurfaceHarnessId,
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

/** Every harness the MCP may name — the adapters, plus the native `agentistics` one ONLY while the native
 *  runtime is visible (`nativeVisibleFrom` over the server's `GET /api/engine`). The native harness is
 *  experimental: with the flag off the tools must not offer it, exactly as before v2.103. */
export function harnessIds(nativeVisible: boolean): SurfaceHarnessId[] {
  return surfaceHarnesses(nativeVisible);
}

export function harnessParam(nativeVisible: boolean) {
  const ids = harnessIds(nativeVisible);
  return {
    type: "string",
    enum: ["all", ...ids],
    description: `Scope to one harness (${ids.join(" | ")}), or 'all' (default) for the unified view across every harness.`,
  };
}

/** The tool list with every `harness` parameter re-derived for this gate answer. Pure: never mutates `tools`. */
export function toolsForGate<T extends { inputSchema: { properties?: Record<string, unknown> } }>(tools: readonly T[], nativeVisible: boolean): T[] {
  const param = harnessParam(nativeVisible);
  return tools.map(t => {
    const props = t.inputSchema.properties;
    if (!props || !("harness" in props)) return t;
    return { ...t, inputSchema: { ...t.inputSchema, properties: { ...props, harness: param } } };
  });
}

/**
 * Who started each session, from the fleet rows: keyed by the session's conversation id AND its
 * managed id, so a metrics row (which carries the conversation id) finds it. The parent's title is
 * resolved against the same rows; a parent no longer in the fleet is still named by id.
 */
export function startedByIndex(
  rows: ReadonlyArray<{ id: string; conversationId?: string; title?: string; parentSessionId?: string; parentConversationId?: string }>,
): Map<string, { id: string; title?: string }> {
  const out = new Map<string, { id: string; title?: string }>();
  for (const r of rows) {
    if (!r.parentSessionId) continue;
    const parent = (r.parentConversationId ? rows.find(p => p.conversationId === r.parentConversationId) : undefined)
      ?? rows.find(p => p.id === r.parentSessionId || p.conversationId === r.parentSessionId);
    const who = { id: parent?.id ?? r.parentSessionId, ...(parent?.title ? { title: parent.title } : {}) };
    out.set(r.id, who);
    if (r.conversationId) out.set(r.conversationId, who);
  }
  return out;
}
