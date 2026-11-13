/** The shape of `GET /api/benchmark/observed` this tool reads (structural: the MCP package stays standalone-publishable). */
interface Observed {
  label: string;
  period: unknown;
  deliveries: number;
  scope: unknown;
  metrics: Record<string, { missing?: unknown } & Record<string, unknown>>;
  coordinationShareRange: unknown;
  roleUnknownSessions: number;
  coverage: unknown;
  notStructured: unknown;
}

/** `from` / `to` as the route takes them: epoch milliseconds, or an ISO date. Anything else is dropped, never guessed. */
export function benchmarkQueryFromArgs(args: { from?: unknown; to?: unknown } | undefined): string {
  const asMs = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && v.trim()) { const t = Date.parse(v); return Number.isFinite(t) && t > 0 ? t : null; }
    return null;
  };
  const q = new URLSearchParams();
  const from = asMs(args?.from), to = asMs(args?.to);
  if (from !== null) q.set("from", String(from));
  if (to !== null) q.set("to", String(to));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * The `agentistics_benchmark_observed` answer, split out so it can be exercised without the stdio server.
 * It is the page's own read model (`GET /api/benchmark/observed`) with ONE removal: the lists of subtask and
 * session ids behind each figure (`missing`), which are large and identify work; the counts stay in `gaps`.
 * Numbers are passed through untouched — the same ones the screen shows, never recomputed here.
 */
export function benchmarkObservedTool(body: Observed) {
  const metrics = Object.fromEntries(Object.entries(body.metrics).map(([k, m]) => {
    const { missing: _missing, ...rest } = m;
    return [k, rest];
  }));
  return {
    label: body.label,
    note: "Observed history, biased by construction (hard work tends to take the heavier path): it describes the past and does not say a method pays off. A null value is NOT MEASURED, never zero; read gaps and n before quoting a figure.",
    period: body.period,
    deliveries: body.deliveries,
    scope: body.scope,
    metrics,
    coordinationShareRange: body.coordinationShareRange,
    roleUnknownSessions: body.roleUnknownSessions,
    coverage: body.coverage,
    notStructured: body.notStructured,
  };
}
