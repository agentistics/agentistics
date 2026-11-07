/**
 * delivery/calendar.ts — the IO half of the Delivery calendar. It gathers the four sources the screen, the
 * MCP tool (`agentistics_delivery_calendar`) and `agentop flow calendario` share — the Live line, the delivery
 * records, the board's tasks and the accounts' usage windows — and hands them to core's pure
 * `buildCalendar` / `filterCalendar`. It decides nothing: every rule (what is active, when a version ships,
 * what "confirmed" means) is `@agentistics/core`'s `deliveryCalendar.ts`.
 *
 * The accounts' renewals are read ONLY for accounts the agents may see (`budgets`, never
 * `hiddenFromAgents`) and carry the account's display label, never a login — the same boundary
 * `agentistics_plan_limits` keeps.
 */
import {
  buildCalendar, filterCalendar, type CalendarReply, type CalendarView, type CalFilters, type CalLiveInput,
  type CalRecordInput, type CalResetInput, type CalStage, type CalSubtaskInput, type CalTaskInput,
} from '@agentistics/core'

export interface CalendarSources {
  nowMs: number
  lives: CalLiveInput[]
  records: CalRecordInput[]
  tasks: CalTaskInput[]
  subtasks: CalSubtaskInput[]
  resets: CalResetInput[]
}

export async function readCalendarSources(): Promise<CalendarSources> {
  const nowMs = Date.now()
  const [{ liveDeliveries }, { deliveryService }, { loadTaskWorld }] = await Promise.all([
    import('../sessions/task-web'), import('./host'), import('../sessions/task-source'),
  ])
  const [view, records, world] = await Promise.all([liveDeliveries(), deliveryService().list(), loadTaskWorld()])
  const lives: CalLiveInput[] = view.deliveries.map(d => ({
    key: d.key, taskId: d.taskId, taskTitle: d.taskTitle, subtaskId: d.subtaskId, title: d.title,
    stage: d.stage as CalStage, startedAtMs: d.startedAtMs, stageSinceMs: d.stageSinceMs,
    harnesses: d.harnesses, models: d.models,
    eta: d.eta.kind === 'estimate' ? { kind: 'estimate', confidence: d.eta.confidence } : { kind: 'none', reason: d.eta.reason },
    stageEta: d.stageEta.kind === 'estimate' ? { kind: 'estimate', atMs: d.stageEta.atMs } : { kind: 'none', reason: d.stageEta.reason },
    publishEta: d.publishEta.kind === 'estimate' ? { kind: 'estimate', atMs: d.publishEta.atMs } : { kind: 'none', reason: d.publishEta.reason },
    deliveredAtMs: d.deliveredAtMs,
  }))
  return {
    nowMs, lives,
    records: records.map(r => ({
      subtaskId: r.subtaskId, taskId: r.taskId, phase: r.phase,
      ...(r.versionTarget ? { versionTarget: r.versionTarget } : {}),
      ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
      ...(r.tag ? { tag: r.tag } : {}),
    })),
    tasks: world.book.tasks.map(t => ({
      id: t.id, title: t.title, status: t.status,
      ...(t.priority ? { priority: t.priority } : {}),
      ...(t.dueDate ? { dueDate: t.dueDate } : {}),
    })),
    subtasks: world.book.subtasks.map(s => ({ id: s.id, taskId: s.taskId, title: s.title })),
    resets: await readResets(nowMs).catch(() => []),
  }
}

/** The renewals of every account the agents may see, one mark per window that has a reset time. */
async function readResets(nowMs: number): Promise<CalResetInput[]> {
  const [{ planLimitsPayload }, { readPreferences }] = await Promise.all([import('../plan-limits'), import('../preferences')])
  const prefs = await readPreferences()
  const p = await planLimitsPayload(prefs.billing, nowMs)
  const visible = new Map(p.budgets.map(b => [`${b.harness}:${b.account}`, b.accountLabel]))
  const out: CalResetInput[] = []
  for (const l of p.limits) {
    const label = visible.get(`${l.harness}:${l.account}`)
    if (!label) continue
    for (const w of l.windows) if (w.resetsAt > nowMs) out.push({ harness: l.harness, account: l.account, label, window: w.kind, resetsAt: w.resetsAt })
  }
  return out
}

export function calendarFrom(src: CalendarSources): CalendarReply {
  return buildCalendar(src)
}

/** Everything the calendar knows, unfiltered — what the screen holds and filters in the browser. */
export async function deliveryCalendar(): Promise<CalendarReply> {
  return calendarFrom(await readCalendarSources())
}

/** The filtered answer an agent asks for: the reply's header plus only what the filters leave. */
export function answerCalendar(reply: CalendarReply, f: CalFilters): CalendarReply & { filters: CalFilters; counts: { pieces: number; versions: number; marks: number } } {
  const v: CalendarView = filterCalendar(reply, f)
  return { ...reply, pieces: v.pieces, versions: v.versions, marks: v.marks, filters: f, counts: { pieces: v.pieces.length, versions: v.versions.length, marks: v.marks.length } }
}

const csv = (s: string | null): string[] | undefined => { const l = (s ?? '').split(',').map(x => x.trim()).filter(Boolean); return l.length ? l : undefined }
const instant = (s: string | null, endOfDay: boolean): number | undefined => {
  if (!s) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const start = Date.parse(`${s}T00:00:00.000Z`) + 3 * 3600_000 // 00:00 BRT
    return endOfDay ? start + 86_400_000 - 1 : start
  }
  const n = Date.parse(s)
  return Number.isFinite(n) ? n : undefined
}

/** PURE: the query string (`task`, `subtask`, `version`, `stage`, `harness`, `priority`, `from`, `to`, `all`, `confirmed`) → filters. */
export function calendarFiltersOf(q: URLSearchParams): CalFilters {
  const stages = csv(q.get('stage'))?.filter((s): s is CalStage => ['queue', 'blocked', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'published'].includes(s))
  const priorities = csv(q.get('priority'))?.filter((s): s is 'urgent' | 'high' | 'medium' | 'low' => ['urgent', 'high', 'medium', 'low'].includes(s))
  const fromMs = instant(q.get('from'), false), toMs = instant(q.get('to'), true)
  const versions = csv(q.get('version')), harnesses = csv(q.get('harness'))
  return {
    tasks: q.get('all') === '1' || q.get('tasks') === 'all' ? 'all' : 'active',
    ...(q.get('task') ? { task: q.get('task')! } : {}),
    ...(q.get('subtask') ? { subtaskId: q.get('subtask')! } : {}),
    ...(versions ? { versions } : {}),
    ...(stages?.length ? { stages } : {}),
    ...(harnesses ? { harnesses } : {}),
    ...(priorities?.length ? { priorities } : {}),
    ...(q.get('confirmed') === '1' ? { confirmedOnly: true } : {}),
    ...(fromMs !== undefined ? { fromMs } : {}),
    ...(toMs !== undefined ? { toMs } : {}),
  }
}
