/**
 * AGENTASK deadline reminders — the bell notification the server raised (`task.deadline.*`, once
 * per item per threshold) becomes Nay's floating card, the way a plan-limit notice does
 * (`planLimitNotice.ts`): the bell keeps the record, the card speaks it, do-not-disturb and a
 * hidden tab leave it in the bell (the toast then shows it instead).
 */
import type { AppNotification } from './notifications'
import { pushAlert } from './nayNotifyStore'
import { getNotificationSettings } from './sessionNotifications'
import type { NayAlert } from './nayNotify'

const PREFIX = 'task.deadline.'
const THRESHOLDS = ['soon', 'today', 'overdue'] as const

/** The card's payload from a notification's code + meta; null when it is not a usable reminder. */
export function deadlineOf(code: string | undefined, meta: Record<string, unknown> | undefined): NonNullable<NayAlert['deadline']> | null {
  if (!code?.startsWith(PREFIX)) return null
  const threshold = THRESHOLDS.find(t => t === code.slice(PREFIX.length))
  if (!threshold || !meta) return null
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const taskId = str(meta.taskId)
  if (!taskId) return null
  return { threshold, title: str(meta.title), task: str(meta.task), due: str(meta.due), taskId }
}

/** Queue the Nay card for a deadline reminder. False when it did not (the toast shows it then). */
export function pushDeadlineAlert(n: Pick<AppNotification, 'id' | 'code' | 'meta' | 'ts'>): boolean {
  const deadline = deadlineOf(n.code, n.meta)
  if (!deadline) return false
  if (getNotificationSettings().doNotDisturb) return false
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false
  return pushAlert({
    key: `task-deadline:${n.id}`,
    kind: 'task-deadline',
    sessionId: `task-deadline:${String(n.meta?.id ?? deadline.taskId)}`,
    name: deadline.title,
    sinceMs: n.ts,
    sinceKnown: true,
    deadline,
  })
}
