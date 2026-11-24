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
 *  - `heavy-lock` — a process of the session is WAITING in the heavy-job queue (`heavyLock: 'waiting'`,
 *                   decided by the host from /proc — passed in, never read here). First, because the
 *                   open Bash IS that `flock`: it reads "queued", not "running".
 *  - `tool`       — a tool call is open: the transcript wrote the `tool_use` and nothing came after it
 *                   (`ChatTurn.pending`).
 *  - `task`       — a background task of the session is still running (`ChatTurn.task.running`).
 *  - `heavy-hold` — a process of the session HOLDS the heavy-job lock and is running its job.
 *  - `output`     — the screen/transcript moved since the previous observation (`outputMoved`).
 *
 * `null` means NONE holds. That is the only state a stall alert may be raised from.
 */
import type { ChatTurn } from './chatTurn'

export type ActivitySignal = 'tool' | 'task' | 'heavy-lock' | 'heavy-hold' | 'output'

export interface ActiveEvidence {
  signal: ActivitySignal
  /** Epoch ms the activity began, when the evidence says (a pending turn's own time). Absent = unknown. */
  sinceMs?: number
}

export interface ActivityInput {
  turns?: readonly ChatTurn[]
  /** A process of this session waits on (`true` / `'waiting'`) or holds (`'holding'`) the heavy lock. */
  heavyLock?: boolean | 'waiting' | 'holding'
  /** Output grew since the last observation. */
  outputMoved?: boolean
}

const parse = (at: string | undefined): number | undefined => {
  if (!at) return undefined
  const t = Date.parse(at)
  return Number.isFinite(t) ? t : undefined
}

/** A finished session is never active: its stale `pending` turn describes a call nobody is making. */
export function activityApplies(status: string | undefined): boolean {
  return status !== 'closed' && status !== 'exited' && status !== 'lost'
}

export function activeEvidence(i: ActivityInput): ActiveEvidence | null {
  const turns = i.turns ?? []
  const last = turns.at(-1)
  const pendingSince = last?.pending ? parse(last.at) : undefined
  const since = (s: number | undefined) => s !== undefined ? { sinceMs: s } : {}
  if (i.heavyLock === true || i.heavyLock === 'waiting') return { signal: 'heavy-lock', ...since(pendingSince) }
  if (last?.pending) return { signal: 'tool', ...since(pendingSince) }
  const task = [...turns].reverse().find(t => t.task?.running)
  if (task) return { signal: 'task', ...since(parse(task.at)) }
  if (i.heavyLock === 'holding') return { signal: 'heavy-hold' }
  if (i.outputMoved) return { signal: 'output' }
  return null
}

/** The sidebar's right-hand label for a row with evidence: "rodando há 33 min" / "running 33 min". */
export function runningLabel(e: ActiveEvidence, now: number, pt: boolean, span: (ms: number, pt: boolean) => string): string {
  const queued = e.signal === 'heavy-lock'
  if (e.sinceMs === undefined) return queued ? (pt ? 'na fila' : 'queued') : (pt ? 'rodando' : 'running')
  const s = span(now - e.sinceMs, pt)
  if (queued) return pt ? `na fila há ${s}` : `queued ${s}`
  return pt ? `rodando há ${s}` : `running ${s}`
}

/**
 * The state a LIVE surface (the Live board) draws for a row, from the row's own state and the same
 * `activeSignal` the sidebar and the stall alert read. A row at its prompt (`waiting`/`idle`) with
 * evidence of activity is `working`; one blocked on a person, ended or lost keeps its state. `queued`
 * is the heavy-lock wait: it counts as working (it is not stalled) but is worded "na fila", never "rodando".
 */
export function activityState<S extends string>(state: S, signal: ActivitySignal | null | undefined): { state: S | 'working'; queued: boolean } {
  if (!signal || (state !== 'waiting' && state !== 'idle')) return { state, queued: false }
  return { state: 'working', queued: signal === 'heavy-lock' }
}

/**
 * A terminal frame with its CLOCKS blanked: `12:34`, `1h 2m 3s`, `45s`, `3m`. A harness that repaints
 * an elapsed-time counter on an idle screen moves the frame without producing anything, and "output
 * moved" must not read that as work. Only time-shaped tokens are blanked — any other change still counts.
 */
export function withoutClocks(lines: readonly string[]): string[] {
  return lines.map(l => l
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?\b/gi, '#')
    .replace(/\b\d+\s?h(?:\s?\d+\s?m)?(?:\s?\d+\s?s)?\b/g, '#')
    .replace(/\b\d+\s?m(?:in)?(?:\s?\d+\s?s)?\b/g, '#')
    .replace(/\b\d+(?:\.\d+)?\s?s\b/g, '#'))
}
