/**
 * "Open the plan-usage popup" from somewhere that has no footer button to hover — the phone's
 * "Go to" sheet. The popup lives in `PlanUsageFootButton.tsx`; the App subscribes once with the
 * phone sheet and the sheet's action calls `requestPlanUsagePopup()`. Same bus shape as
 * `usagePageRequests.ts` (the callers sit far from where the popup is mounted).
 */
const listeners = new Set<() => void>()
export function requestPlanUsagePopup(): void { for (const fn of listeners) fn() }
export function subscribePlanUsagePopup(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }
