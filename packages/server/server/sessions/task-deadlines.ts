/**
 * DEADLINE REMINDERS — pure. Which tasks and subtasks should raise a reminder RIGHT NOW.
 *
 * A due date is a calendar DAY (`yyyy-MM-dd`, the owner's local day — the same shape the board's
 * date pickers write), so the thresholds are day arithmetic, not hour arithmetic:
 *
 *  - `soon`    — the due day is TOMORROW (the "24 h before" reminder);
 *  - `today`   — the due day is today;
 *  - `overdue` — the due day has passed (one reminder, not one per day).
 *
 * Only the CURRENT threshold of an item is ever considered, so a task first seen two days late gets
 * one `overdue` reminder and never a burst of the thresholds it already missed. Each reminder is
 * keyed by (kind, id, due, threshold): rescheduling an item (a new `due`) re-arms it, and the key
 * survives a restart because the caller persists the set of keys it has already raised.
 *
 * A closed item can never be late (`board.ts`'s rule: finished work cannot be overdue), so `done`
 * and `abandoned` tasks and `done` subtasks raise nothing. A group MEMBER is a subtask like any
 * other here — it has its own due date.
 */

export type DeadlineThreshold = 'soon' | 'today' | 'overdue'

export interface DeadlineReminder {
  /** Dedupe key — persist it once raised. */
  key: string
  threshold: DeadlineThreshold
  kind: 'task' | 'subtask'
  id: string
  taskId: string
  /** The item's own title. */
  title: string
  /** The parent task's title — equal to `title` for a task. */
  taskTitle: string
  due: string
}

interface DueTask { id: string; title: string; status: string; dueDate?: string }
interface DueSubtask { id: string; taskId: string; title: string; status: string; done?: boolean; dueDate?: string }

const CLOSED = new Set(['done', 'abandoned'])

/** `yyyy-MM-dd` of a Date in the machine's LOCAL clock — the day a person means by "today". */
export function localDay(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** Whole days from `from` to `to`, both `yyyy-MM-dd`; null when either is not a day. */
export function daysBetween(from: string, to: string): number | null {
  const re = /^\d{4}-\d{2}-\d{2}$/
  if (!re.test(from) || !re.test(to)) return null
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10))
  return Math.round((b - a) / 86_400_000)
}

export function thresholdFor(due: string, today: string): DeadlineThreshold | null {
  const d = daysBetween(today, due)
  if (d === null) return null
  if (d < 0) return 'overdue'
  if (d === 0) return 'today'
  if (d === 1) return 'soon'
  return null
}

export function planDeadlineReminders(
  tasks: readonly DueTask[],
  subtasks: readonly DueSubtask[],
  alreadySent: ReadonlySet<string>,
  now: Date,
): DeadlineReminder[] {
  const today = localDay(now)
  const out: DeadlineReminder[] = []
  const titleOf = new Map(tasks.map(t => [t.id, t.title]))
  const closedTasks = new Set(tasks.filter(t => CLOSED.has(t.status)).map(t => t.id))
  for (const t of tasks) {
    if (!t.dueDate || CLOSED.has(t.status)) continue
    const threshold = thresholdFor(t.dueDate, today)
    if (!threshold) continue
    const key = `task:${t.id}:${t.dueDate}:${threshold}`
    if (alreadySent.has(key)) continue
    out.push({ key, threshold, kind: 'task', id: t.id, taskId: t.id, title: t.title, taskTitle: t.title, due: t.dueDate })
  }
  for (const s of subtasks) {
    if (!s.dueDate || s.done === true || CLOSED.has(s.status) || closedTasks.has(s.taskId)) continue
    const threshold = thresholdFor(s.dueDate, today)
    if (!threshold) continue
    const key = `subtask:${s.id}:${s.dueDate}:${threshold}`
    if (alreadySent.has(key)) continue
    out.push({ key, threshold, kind: 'subtask', id: s.id, taskId: s.taskId, title: s.title, taskTitle: titleOf.get(s.taskId) ?? s.title, due: s.dueDate })
  }
  return out
}

/**
 * The keys worth remembering: those of items still on the board with the same due date. Anything
 * else (a deleted task, a rescheduled one) is dropped so the file cannot grow without bound.
 */
export function pruneSentKeys(
  sent: ReadonlySet<string>,
  tasks: readonly DueTask[],
  subtasks: readonly DueSubtask[],
): string[] {
  const live = new Set<string>()
  for (const t of tasks) if (t.dueDate) live.add(`task:${t.id}:${t.dueDate}:`)
  for (const s of subtasks) if (s.dueDate) live.add(`subtask:${s.id}:${s.dueDate}:`)
  return [...sent].filter(k => {
    const cut = k.lastIndexOf(':')
    return cut > 0 && live.has(k.slice(0, cut + 1))
  })
}
