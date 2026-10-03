/**
 * session-native.ts — PURE: this machine's NATIVE sessions (the engine's `ses_…`) as rows of the
 * `sessions` tab's fleet (SS-01). The fleet's poller knows only harness processes; the native ones
 * live in the engine's store and come from the code host (`recentSessions`).
 *
 * State, honestly: a native session whose latest run is running is `working`; otherwise there is NO
 * process — it is a conversation on disk that `enter` reopens in the `code` tab, which is exactly the
 * fleet's `closed` ("not running at all, can usually be reopened"). It is never `needs you` from a
 * guess: a stale open session from yesterday would otherwise ask for the person forever.
 */
import type { CodeRecentSession } from './code-types'
import type { ControlSession } from './types'

export const NATIVE_HARNESS = 'agentistics'

export function isNativeRow(s: Pick<ControlSession, 'harness'>): boolean {
  return s.harness === NATIVE_HARNESS
}

export function nativeFleetRows(
  recent: readonly CodeRecentSession[],
  labels: { working: string; idle: string; ended: string },
): ControlSession[] {
  return recent.map(r => {
    const ms = Date.parse(r.updatedAt) || undefined
    const cwd = r.cwd ?? ''
    const project = cwd.split('/').filter(Boolean).pop() ?? ''
    const state = r.running ? 'working' as const : 'closed' as const
    const taskTitle = r.task?.replace(/^t-[0-9a-f]{4,} /, '')
    return {
      id: r.sessionId,
      title: r.title,
      harness: NATIVE_HARNESS,
      cwd,
      project,
      model: r.model,
      // The fleet names a task by its TITLE (that is what groups and filters it); the code host's
      // `t-xxxx Title` carries the short handle in front, which would make a second group of one task.
      ...(taskTitle ? { task: taskTitle } : {}),
      searchFields: { name: r.title, folder: cwd, harness: NATIVE_HARNESS, note: '', task: r.task ?? '', prompt: '' },
      state,
      stateLabel: r.running ? labels.working : r.status === 'open' ? labels.idle : labels.ended,
      actionable: true,
      attached: false,
      ...(ms ? (r.running ? { startedAt: ms } : { endedAt: ms }) : {}),
    } as ControlSession
  })
}
