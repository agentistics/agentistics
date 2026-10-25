/**
 * The preview bug: a claude record reached the server while the Limits tab was OPEN, and the tab
 * kept saying "not reported". The browser's half of the fix: an SSE `plan-limits` signal makes the
 * one shared store read `/api/plan-limits` again, with no reload.
 */
import { afterAll, expect, test } from 'bun:test'
import type { UsageBudgetRow } from './usagePlan'
import type { PlanReadings } from './planLimits'

type Listener = (e: MessageEvent) => void
class FakeEventSource {
  static last: FakeEventSource | null = null
  readyState = 1
  listeners = new Map<string, Set<Listener>>()
  constructor(public url: string) { FakeEventSource.last = this }
  addEventListener(t: string, l: Listener) { (this.listeners.get(t) ?? this.listeners.set(t, new Set()).get(t)!).add(l) }
  removeEventListener(t: string, l: Listener) { this.listeners.get(t)?.delete(l) }
  close() { this.readyState = 2 }
  emit(t: string) { for (const l of this.listeners.get(t) ?? []) l(new MessageEvent(t, { data: '{}' })) }
}
const realES = (globalThis as { EventSource?: unknown }).EventSource
const realFetch = globalThis.fetch
;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
afterAll(() => { (globalThis as { EventSource?: unknown }).EventSource = realES; globalThis.fetch = realFetch })

let answer: unknown = { limits: [], registered: [{ harness: 'claude', plan: 'Max 5x' }] }
let calls = 0
globalThis.fetch = (async (url: string) => {
  calls++
  expect(String(url)).toBe('/api/plan-limits')
  return new Response(JSON.stringify(answer), { status: 200 })
}) as typeof fetch

const tick = () => new Promise(r => setTimeout(r, 5))

test('a plan-limits signal on the open stream refreshes the open tab without a reload', async () => {
  // A subscriber leaked by an earlier file in the same run would keep the shared socket open, and
  // this file's fake would never be constructed; start from a closed stream.
  const { eventStream } = await import('./eventStream')
  eventStream.reset?.()
  const { subscribePlanLimits, planLimitsSnapshot } = await import('./planLimits')
  let renders = 0
  const off = subscribePlanLimits(() => { renders++ }) // the Limits tab is open
  await tick()
  expect(planLimitsSnapshot().limits).toEqual([])
  expect(planLimitsSnapshot().budgets).toEqual([])
  expect(planLimitsSnapshot().readings).toEqual([])
  expect(planLimitsSnapshot().registered.map(r => r.harness)).toEqual(['claude'])

  // The server stored claude's record (another process wrote it) and signalled.
  const now = Date.now()
  answer = { limits: [{ harness: 'claude', account: 'default', windows: [{ kind: '5h', usedPct: 43, resetsAt: now + 3_600_000 }, { kind: 'week', usedPct: 37, resetsAt: now + 86_400_000 }], updatedAt: now, source: 'claude-stream' }], registered: [] }
  const budget: UsageBudgetRow = {
    harness: 'claude', account: 'default', accountLabel: 'Personal', plan: 'Max',
    fiveHourPct: 43, weekPct: 37, weekResetsAt: now + 86_400_000,
    daysToWeekReset: 1, dailyBudgetPct: 63, status: 'ok', updatedAt: now, stale: false,
    paceStatus: 'over', burnPctPerHour: 3, sustainablePctPerHour: 2.625,
    suggestedParallel: 0, note: '', freeSlots: 0, freeSlotsMeasured: true,
    liveSessions: [], pauseUntil: now + 60_000,
  }
  const budgets = [budget]
  const hiddenFromAgents: UsageBudgetRow[] = [{ ...budget, harness: 'codex', account: 'hidden', accountLabel: 'Work' }]
  const readings: PlanReadings[] = [{ harness: 'claude', account: 'default', points: [{ at: now, weekPct: 37, fiveHourPct: 43 }] }]
  answer = { ...answer as object, budgets, hiddenFromAgents, readings,
    registered: [{ harness: 'copilot', account: 'pending', plan: 'Pro', accountLabel: 'Copilot CLI #1' }] }
  const before = calls
  FakeEventSource.last!.emit('plan-limits')
  await tick()
  expect(calls).toBe(before + 1)
  expect(planLimitsSnapshot().limits!.map(l => l.harness)).toEqual(['claude'])
  expect(planLimitsSnapshot().registered).toEqual([{ harness: 'copilot', account: 'pending', plan: 'Pro', accountLabel: 'Copilot CLI #1' }])
  expect(planLimitsSnapshot().budgets).toEqual([...budgets, ...hiddenFromAgents])
  expect(planLimitsSnapshot().readings).toEqual(readings)
  expect(planLimitsSnapshot().accountLabels).toEqual({ default: 'Personal', hidden: 'Work', pending: 'Copilot CLI #1' })
  expect(renders).toBeGreaterThan(1)
  off()
})
