/** PURE: the query string (with its `?`, or empty) an `agentistics_delivery_calendar` call stands for. */
export const CALENDAR_STAGES = ["queue", "blocked", "running", "qa", "adjust", "leader", "merge", "ci", "published"] as const;
export const CALENDAR_PRIORITIES = ["urgent", "high", "medium", "low"] as const;

type Args = {
  task?: unknown; subtask?: unknown; version?: unknown; stage?: unknown; harness?: unknown; priority?: unknown;
  from?: unknown; to?: unknown; all?: unknown; confirmedOnly?: unknown; format?: unknown;
} | undefined;

/** A string or a list of strings → a comma list, keeping only members of `allowed` when one is given. */
function list(v: unknown, allowed?: readonly string[]): string {
  const items = (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
    .filter((x): x is string => typeof x === "string").map(x => x.trim()).filter(Boolean);
  return (allowed ? items.filter(x => allowed.includes(x)) : items).join(",");
}

export function deliveryCalendarQuery(a: Args): string {
  const q = new URLSearchParams();
  const task = typeof a?.task === "string" ? a.task.trim() : "";
  if (task) q.set("task", task);
  const subtask = typeof a?.subtask === "string" ? a.subtask.trim() : "";
  if (subtask) q.set("subtask", subtask);
  for (const [key, value] of [
    ["version", list(a?.version)], ["stage", list(a?.stage, CALENDAR_STAGES)], ["harness", list(a?.harness)],
    ["priority", list(a?.priority, CALENDAR_PRIORITIES)],
  ] as const) if (value) q.set(key, value);
  for (const key of ["from", "to"] as const) {
    const v = a?.[key];
    if (typeof v === "string" && v.trim()) q.set(key, v.trim());
  }
  if (a?.all === true) q.set("all", "1");
  if (a?.confirmedOnly === true) q.set("confirmed", "1");
  if (a?.format === "ics") q.set("format", "ics");
  return q.toString() ? `?${q}` : "";
}
