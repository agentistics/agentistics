/**
 * lineStatus.ts — PURE: which state ICON a sidebar row wears, and the full sentence its tooltip says.
 *
 * Owner, 2026-11-26: the activity TEXT on the right of a row ("rodando há 1 min", "na fila") squeezed
 * the title into two lines and broke it mid-word ("Moto / r"). The approved shape (option A of the
 * prototype `leader/estado-icones`) is a coloured ICON in place of the old dot, the short time beside
 * it ("1 min") and the full sentence on hover / focus / tap of the icon.
 *
 * Only the PRESENTATION changes: the kind is read from the same `state` and `activeSignal` the
 * activity code already computes (`@agentistics/core/sessionActivity`) — nothing here infers a state
 * of its own. There is no queue POSITION on the row, so the queue icon carries none rather than an
 * invented one.
 */
import type { ActivitySignal } from '@agentistics/core'
import type { SessionState } from '@agentistics/tui/control/session-fleet'

export type LineStatusKind =
  /** Working, writing (no open command): the turn is in progress or the output moved. */
  | 'writing'
  /** A tool call is open or the session holds the heavy-job lock and runs its job. */
  | 'cmd'
  /** A background task of the session is still running. */
  | 'task'
  /** Waiting in the heavy-job queue. */
  | 'queue'
  /** A dialog (question / approval) is open on the session. */
  | 'approval'
  /** The turn ended: the session is at its prompt, waiting for a person. */
  | 'you'
  /** The turn ended and the session waits on busy workers it started: nothing for a person to answer. */
  | 'workers'
  /** Alive and quiet (`idle`, `unknown`). */
  | 'idle'
  /** Finished (`exited`, `closed`). */
  | 'ended'
  /** The machine says it fell (`lost`, or the fell section). */
  | 'fell'

/** The icon's colour per kind — the prototype's palette, on the product's own tokens where they exist. */
export const LINE_STATUS_COLOR: Record<LineStatusKind, string> = {
  writing: '#22c55e',
  cmd: '#58a6ff',
  task: '#2bc4b4',
  queue: '#f0a020',
  approval: '#b48cff',
  you: '#b48cff',
  // Calm on purpose: nothing is asked of the person.
  workers: 'var(--accent-cyan)',
  idle: 'var(--text-tertiary)',
  ended: 'var(--text-tertiary)',
  fell: 'var(--accent-red)',
}

/** The kind a row wears. `fell` is the caller's knowledge (the machine said so); everything else is the row's. */
export function lineStatusKind(state: SessionState, signal: ActivitySignal | null | undefined, fell = false, waitingOnWorkers = 0): LineStatusKind {
  if (fell || state === 'lost') return 'fell'
  if (state === 'exited' || state === 'closed') return 'ended'
  // A dialog outranks activity evidence, the same precedence `liveAge` applies.
  if (state === 'waiting-approval') return 'approval'
  if (signal === 'heavy-lock') return 'queue'
  if (signal === 'tool' || signal === 'heavy-hold') return 'cmd'
  if (signal === 'task') return 'task'
  if (signal === 'output' || state === 'working') return 'writing'
  if (state === 'waiting') return waitingOnWorkers > 0 ? 'workers' : 'you'
  return 'idle'
}

const BASE: Record<LineStatusKind, { pt: string; en: string }> = {
  writing: { pt: 'trabalhando', en: 'working' },
  cmd: { pt: 'rodando', en: 'running' },
  task: { pt: 'tarefa em segundo plano rodando', en: 'background task running' },
  queue: { pt: 'na fila de trabalho pesado', en: 'queued for heavy work' },
  approval: { pt: 'esperando sua resposta (pergunta ou aprovação)', en: 'waiting for your answer (question or approval)' },
  you: { pt: 'esperando você', en: 'waiting for you' },
  workers: { pt: 'esperando workers', en: 'waiting on workers' },
  idle: { pt: 'parada', en: 'idle' },
  ended: { pt: 'encerrada', en: 'ended' },
  fell: { pt: 'caiu', en: 'fell' },
}

/** The state's word alone ("na fila de trabalho pesado") — the icon's accessible name. */
export function lineStatusWord(kind: LineStatusKind, pt: boolean, workers = 0): string {
  if (kind === 'workers' && workers > 0) {
    const noun = workers === 1 ? 'worker' : 'workers'
    return pt ? `esperando ${workers} ${noun}` : `waiting on ${workers} ${noun}`
  }
  return pt ? BASE[kind].pt : BASE[kind].en
}

/**
 * The tooltip's full sentence: the state word plus the short time the row shows, joined so it reads
 * ("rodando há 1 min", "trabalhando agora", "encerrada · 14:30", "caiu há 3 h"). Never "rodando há
 * agora": a span under a minute is "agora" and is said as such.
 */
export function lineStatusText(kind: LineStatusKind, time: string | null | undefined, pt: boolean, workers = 0): string {
  const base = lineStatusWord(kind, pt, workers)
  if (!time) return base
  // Ended rows carry a clock time / "ontem"; fallen rows already carry "há 3 h" / "3 h ago".
  if (kind === 'ended') return `${base} · ${time}`
  if (kind === 'fell') return `${base} ${time}`
  if (time === 'agora' || time === 'now') return `${base} ${time}`
  return pt ? `${base} há ${time}` : `${base} for ${time}`
}
