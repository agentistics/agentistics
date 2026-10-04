/**
 * task-detail.ts — PURE: the `tasks` tab's detail pane (TK-02…TK-07, the prototype's `taskDetail`).
 * The host gathers the facts (`ControlHost.taskDetail`); this decides what each line SAYS.
 *
 * House rules: absent is N/A with the reason, never 0 (a task with no filed session has no cost, it
 * did not cost nothing); progress only when there are subtasks; read-only — the last line says where
 * editing happens.
 */
import type { SessionState } from './types'

export interface TaskDetailSession {
  id: string
  title: string
  harness: string
  state: SessionState
  stateLabel: string
  cost?: string
  /** It is running right now — what `enter` opens (TK-04). */
  live: boolean
}

export interface TaskDetailView {
  id: string
  ref: string
  title: string
  status: string
  statusLabel: string
  priority?: string
  due?: string
  repo?: string
  /** TK-05: why it is blocked, in words (its own reason, then what it waits on). */
  blocked?: string
  progress?: { done: number; total: number }
  /** TK-02: from the task's sessions (`task-rollup.ts`); `null` = none reported. */
  rollup: { cost: string | null; tokens: string | null; rounds: number | null; sessions: number }
  /** TK-03 */
  subtasks: { id: string; title: string; statusLabel: string; done: boolean; sessions: number }[]
  /** TK-04 */
  sessions: TaskDetailSession[]
  activity: string[]
  closed: boolean
}

export interface TaskDetailWords {
  priority: string
  due: string
  blocked: string
  subtasksOf: (done: number, total: number, pct: number) => string
  noSubtasks: string
  cost: string
  tokens: string
  rounds: string
  na: string
  fromSessions: (n: number) => string
  noSession: string
  subtasksHead: string
  subtaskSessions: (n: number) => string
  sessionsHead: string
  noSessions: string
  activityHead: string
  readOnly: string
}

export type TaskLine =
  | { kind: 'title'; text: string }
  | { kind: 'meta'; status: string; statusId: string; rest: string }
  | { kind: 'blocked'; text: string }
  | { kind: 'progress'; done: number; total: number; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'rollup'; text: string; right: string; na: boolean }
  | { kind: 'head'; text: string }
  | { kind: 'subtask'; done: boolean; title: string; right: string }
  | { kind: 'session'; session: TaskDetailSession; right: string }
  | { kind: 'blank' }
  | { kind: 'web'; text: string }

export function taskDetailLines(v: TaskDetailView, w: TaskDetailWords, webUrl: string | null): TaskLine[] {
  const out: TaskLine[] = [{ kind: 'title', text: `${v.ref} ${v.title}` }]
  const rest = [
    v.priority ? `${w.priority} ${v.priority}` : '',
    v.due ? `${w.due} ${v.due}` : '',
    v.repo ?? '',
  ].filter(Boolean).join('  ·  ')
  out.push({ kind: 'meta', status: v.statusLabel, statusId: v.status, rest })
  if (v.blocked) out.push({ kind: 'blocked', text: `${w.blocked}: ${v.blocked}` })
  out.push({ kind: 'blank' })
  if (v.progress && v.progress.total > 0) {
    const pct = Math.floor((v.progress.done / v.progress.total) * 100)
    out.push({ kind: 'progress', done: v.progress.done, total: v.progress.total, text: w.subtasksOf(v.progress.done, v.progress.total, pct) })
  } else out.push({ kind: 'note', text: w.noSubtasks })
  const r = v.rollup
  const any = r.cost !== null || r.tokens !== null || r.rounds !== null
  out.push({
    kind: 'rollup',
    text: `${w.cost} ${r.cost ?? w.na}   ${w.tokens} ${r.tokens ?? w.na}   ${w.rounds} ${r.rounds ?? w.na}`,
    right: r.sessions > 0 ? w.fromSessions(r.sessions) : w.noSession,
    na: !any,
  })
  out.push({ kind: 'blank' })
  if (v.subtasks.length > 0) {
    out.push({ kind: 'head', text: w.subtasksHead })
    for (const s of v.subtasks) out.push({ kind: 'subtask', done: s.done, title: `${s.title}`, right: `${s.statusLabel} · ${w.subtaskSessions(s.sessions)}` })
    out.push({ kind: 'blank' })
  }
  out.push({ kind: 'head', text: w.sessionsHead })
  if (v.sessions.length === 0) out.push({ kind: 'note', text: w.noSessions })
  for (const s of v.sessions) out.push({ kind: 'session', session: s, right: `${s.stateLabel} · ${s.cost ?? w.na}` })
  if (v.activity.length > 0) {
    out.push({ kind: 'blank' }, { kind: 'head', text: w.activityHead })
    for (const a of v.activity) out.push({ kind: 'note', text: a })
  }
  out.push({ kind: 'blank' }, { kind: 'web', text: webUrl ? `${w.readOnly} ${webUrl.replace(/\/$/, '')}/tasks/${v.id}` : w.readOnly })
  return out
}

/** TK-04: the session `enter` opens — the live one (native first: it opens in the code tab). */
export function liveSessionOf(v: TaskDetailView): TaskDetailSession | null {
  const live = v.sessions.filter(s => s.live)
  return live.find(s => s.harness === 'agentistics') ?? live[0] ?? null
}
