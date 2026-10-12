/** "Open the plan-usage details modal" — one request, one mounted listener (App.tsx). Mirrors `nayDockRequests`. */
const listeners = new Set<() => void>()
export function requestPlanUsageModal(): void { for (const fn of listeners) fn() }
export function subscribePlanUsageModal(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }
