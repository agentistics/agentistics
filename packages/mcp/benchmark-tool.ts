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
  history?: { tasks: unknown[]; [k: string]: unknown };
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

/** Rows kept in the tool answer (most expensive first, as the page orders them); `tasksTotal` says how many exist. */
const TOOL_TASK_ROWS = 100;

/** The page's per-piece history, same numbers, with the ids dropped (they identify work) and the task list capped. */
function historyForTool(h: NonNullable<Observed["history"]>) {
  const noId = (v: unknown): unknown => Array.isArray(v) ? v.map(noId)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "id").map(([k, x]) => [k, noId(x)])) : v;
  return {
    note: "Pieces are subtasks done or in review with a linked session; size is by lines changed (<100 S, <500 M, else L); cost is tokens × price per session, never an allocation, and only priced sessions count (costPartial = some sessions have no price); null = not measured. Each task carries `sides` (keys qa and sessions): the two sides of that comparison per column, [A, B] medians per piece, null = nothing measured on that side (defects and accepted are never recorded yet); each comparison's per-size pair carries its `ratio` (B ÷ A). Observed and biased: it says what happened, not that a method pays off.",
    ...(noId({ ...h, tasks: h.tasks.slice(0, TOOL_TASK_ROWS) }) as object),
    tasksTotal: h.tasks.length,
  };
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
    ...(body.history ? { history: historyForTool(body.history) } : {}),
  };
}
