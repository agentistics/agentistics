/** PURE: the query string (with its `?`, or empty) an `agentistics_live_delivery` call stands for. */
export const LIVE_STAGES = ["queue", "running", "qa", "adjust", "leader", "merge", "published"] as const;
/** The order a stage's cards are listed in — the same three the screen's "Ordenar" offers. */
export const LIVE_SORTS = ["priority", "time-in-stage", "recent"] as const;
/** The screen's tabs (Em andamento · Na fila · Publicado · Tudo) and the Publicado period. */
export const LIVE_TABS = ["active", "queue", "published", "all"] as const;
export const LIVE_PERIODS = ["24h", "7d", "30d", "all"] as const;

export function liveDeliveryQuery(a: { task?: unknown; stage?: unknown; stalledOnly?: unknown; tab?: unknown; period?: unknown; sort?: unknown } | undefined): string {
  const q = new URLSearchParams();
  const task = typeof a?.task === "string" ? a.task.trim() : "";
  if (task) q.set("task", task);
  if (typeof a?.stage === "string" && (LIVE_STAGES as readonly string[]).includes(a.stage)) q.set("stage", a.stage);
  if (a?.stalledOnly === true) q.set("stalled", "1");
  // The tab and the period are forwarded only when valid; the server falls back to its defaults otherwise.
  if (typeof a?.tab === "string" && (LIVE_TABS as readonly string[]).includes(a.tab)) q.set("tab", a.tab);
  if (typeof a?.period === "string" && (LIVE_PERIODS as readonly string[]).includes(a.period)) q.set("period", a.period);
  if (typeof a?.sort === "string" && (LIVE_SORTS as readonly string[]).includes(a.sort)) q.set("sort", a.sort);
  return q.toString() ? `?${q}` : "";
}
