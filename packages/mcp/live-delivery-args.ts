/** PURE: the query string (with its `?`, or empty) an `agentistics_live_delivery` call stands for. */
export const LIVE_STAGES = ["queue", "running", "qa", "adjust", "leader", "merge", "published"] as const;
/** The order a stage's cards are listed in — the same three the screen's "Ordenar" offers. */
export const LIVE_SORTS = ["priority", "time-in-stage", "recent"] as const;

export function liveDeliveryQuery(a: { task?: unknown; stage?: unknown; stalledOnly?: unknown; onlyActive?: unknown; showQueue?: unknown; sort?: unknown } | undefined): string {
  const q = new URLSearchParams();
  const task = typeof a?.task === "string" ? a.task.trim() : "";
  if (task) q.set("task", task);
  if (typeof a?.stage === "string" && (LIVE_STAGES as readonly string[]).includes(a.stage)) q.set("stage", a.stage);
  if (a?.stalledOnly === true) q.set("stalled", "1");
  // The screen's two switches default to ON; only an explicit `false` is forwarded (as `0`).
  if (a?.onlyActive === false) q.set("onlyActive", "0");
  if (a?.showQueue === false) q.set("showQueue", "0");
  if (typeof a?.sort === "string" && (LIVE_SORTS as readonly string[]).includes(a.sort)) q.set("sort", a.sort);
  return q.toString() ? `?${q}` : "";
}
