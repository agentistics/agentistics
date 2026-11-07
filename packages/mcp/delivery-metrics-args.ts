/** PURE: the query string (with its `?`, or empty) an `agentistics_delivery_metrics` call stands for. */
export const METRICS_STAGES = ["queue", "blocked", "running", "qa", "adjust", "leader", "merge", "ci", "published"] as const;
export const METRICS_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export const METRICS_QA = ["first_pass", "rejected_once", "rejected_many", "pending"] as const;
export const METRICS_GROUPS = ["day", "week", "version", "model"] as const;

type Args = {
  from?: unknown; to?: unknown; harness?: unknown; version?: unknown; stage?: unknown; model?: unknown;
  qa?: unknown; priority?: unknown; task?: unknown; groupBy?: unknown;
} | undefined;

/** A string or a list of strings → a comma list, keeping only members of `allowed` when one is given. */
function list(v: unknown, allowed?: readonly string[]): string {
  const items = (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
    .filter((x): x is string => typeof x === "string").map(x => x.trim()).filter(Boolean);
  return (allowed ? items.filter(x => allowed.includes(x)) : items).join(",");
}

export function deliveryMetricsQuery(a: Args): string {
  const q = new URLSearchParams();
  for (const key of ["from", "to"] as const) {
    const v = a?.[key];
    if (typeof v === "string" && v.trim()) q.set(key, v.trim());
  }
  for (const [key, value] of [
    ["harness", list(a?.harness)], ["version", list(a?.version)], ["stage", list(a?.stage, METRICS_STAGES)],
    ["model", list(a?.model)], ["qa", list(a?.qa, METRICS_QA)], ["priority", list(a?.priority, METRICS_PRIORITIES)],
  ] as const) if (value) q.set(key, value);
  const task = typeof a?.task === "string" ? a.task.trim() : "";
  if (task) q.set("task", task);
  if (typeof a?.groupBy === "string" && (METRICS_GROUPS as readonly string[]).includes(a.groupBy)) q.set("groupBy", a.groupBy);
  return q.toString() ? `?${q}` : "";
}
