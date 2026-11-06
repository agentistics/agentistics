/** PURE: the query string (with its `?`, or empty) an `agentistics_live_delivery` call stands for. */
export const LIVE_STAGES = ["queue", "running", "qa", "adjust", "leader", "merge", "published"] as const;

export function liveDeliveryQuery(a: { task?: unknown; stage?: unknown; stalledOnly?: unknown } | undefined): string {
  const q = new URLSearchParams();
  const task = typeof a?.task === "string" ? a.task.trim() : "";
  if (task) q.set("task", task);
  // An unknown stage is dropped, not forwarded: asking for a stage that does not exist must not
  // read as "nothing is in it".
  if (typeof a?.stage === "string" && (LIVE_STAGES as readonly string[]).includes(a.stage)) q.set("stage", a.stage);
  if (a?.stalledOnly === true) q.set("stalled", "1");
  return q.toString() ? `?${q}` : "";
}
