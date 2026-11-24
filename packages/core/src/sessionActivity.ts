/**
 * sessionActivity.ts — PURE: is this session DOING something right now, and what is the evidence?
 *
 * ONE source for "the session is not idle". The sidebar's right-hand time, the Live card and the
 * stalled-worker alert used to read three different things: the sidebar showed the age of the
 * person's LAST MESSAGE ("3 h" on a session whose Bash had been running for 33 minutes), and the
 * alert hashed the last chat turn, which a long-running tool call does not change — so a worker
 * waiting on `flock /tmp/agentistics-heavy.lock` or on a 40-minute test read as stalled.
 *
 * What counts as activity, in this order (the first that holds is the one reported):
 *  - `tool`       — a tool call is open: the transcript wrote the `tool_use` and nothing came after it
 *                   (`ChatTurn.pending`).
 *  - `task`       — a background task of the session is still running (`ChatTurn.task.running`).
 *  - `heavy-lock` — a process of the session holds or waits on the heavy-job lock (`heavyLock`,
 *                   decided by the host from /proc — passed in, never read here).
 *  - `output`     — the screen/transcript moved since the previous observation (`outputMoved`).
 *
 * `null` means NONE holds. That is the only state a stall alert may be raised from.
 */
import type { ChatTurn } from './chatTurn'

export type ActivitySignal = 'tool' | 'task' | 'heavy-lock' | 'output'

export interface ActiveEvidence {
  signal: ActivitySignal
  /** Epoch ms the activity began, when the evidence says (a pending turn's own time). Absent = unknown. */
  sinceMs?: number
}

export interface ActivityInput {
  turns?: readonly ChatTurn[]
  /** A process of this session holds or waits on the heavy lock. */
  heavyLock?: boolean
  /** Output grew since the last observation. */
  outputMoved?: boolean
}

const parse = (at: string | undefined): number | undefined => {
  if (!at) return undefined
  const t = Date.parse(at)
  return Number.isFinite(t) ? t : undefined
}

export function activeEvidence(i: ActivityInput): ActiveEvidence | null {
  const turns = i.turns ?? []
  const last = turns.at(-1)
  if (last?.pending) { const s = parse(last.at); return { signal: 'tool', ...(s !== undefined ? { sinceMs: s } : {}) } }
  const task = [...turns].reverse().find(t => t.task?.running)
  if (task) { const s = parse(task.at); return { signal: 'task', ...(s !== undefined ? { sinceMs: s } : {}) } }
  if (i.heavyLock) return { signal: 'heavy-lock' }
  if (i.outputMoved) return { signal: 'output' }
  return null
}

/** The sidebar's right-hand label for a row with evidence: "rodando há 33 min" / "running 33 min". */
export function runningLabel(e: ActiveEvidence, now: number, pt: boolean, span: (ms: number, pt: boolean) => string): string {
  if (e.sinceMs === undefined) return pt ? 'rodando' : 'running'
  const s = span(now - e.sinceMs, pt)
  return pt ? `rodando há ${s}` : `running ${s}`
}
