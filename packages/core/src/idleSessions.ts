/**
 * idleSessions.ts — which sessions the user has stopped talking to. PURE.
 *
 * "Idle" is the person's silence, not the process's: X time since the user's LAST MESSAGE and the
 * session stopped waiting on them. A session working on its own for hours is not idle, and one
 * asking for approval is BLOCKED on the user, which is a different notice. An unknown last message
 * is never a candidate — suggesting to end a session on a guessed clock is suggesting to end work.
 */
import { sessionIdentityKey } from './sessionGroups'

export interface IdleRowInput {
  id: string
  conversationId?: string
  state: string
  managed: boolean
  /** Epoch ms of the user's last message; absent = unknown. */
  lastUserMessageAt?: number
  taskId?: string
  taskDone?: boolean
  rssBytes?: number | null
  cpuPercent?: number | null
  contextFraction?: number | null
}

export interface IdleOptions {
  now: number
  thresholdMs: number
  pressureThresholdMs: number
  underPressure: boolean
  openSessionId?: string | null
  /** sessionIdentityKey -> epoch ms the user chose "keep". */
  kept: Readonly<Record<string, number>>
}

export type IdleReason = 'task-delivered' | 'context-full'

export interface IdleCandidate {
  row: IdleRowInput
  key: string
  idleMs: number
  reasons: IdleReason[]
}

export const CONTEXT_FULL_FRACTION = 0.85

export function idleCandidates(rows: readonly IdleRowInput[], o: IdleOptions): IdleCandidate[] {
  const threshold = o.underPressure ? o.pressureThresholdMs : o.thresholdMs
  const out: IdleCandidate[] = []
  for (const row of rows) {
    if (!row.managed || row.state !== 'waiting') continue
    if (typeof row.lastUserMessageAt !== 'number' || !Number.isFinite(row.lastUserMessageAt)) continue
    const idleMs = o.now - row.lastUserMessageAt
    if (idleMs < threshold) continue
    if (o.openSessionId && (o.openSessionId === row.id || o.openSessionId === row.conversationId)) continue
    const key = sessionIdentityKey(row)
    const keptAt = o.kept[key]
    if (typeof keptAt === 'number' && row.lastUserMessageAt <= keptAt) continue
    const reasons: IdleReason[] = []
    if (row.taskDone) reasons.push('task-delivered')
    if (typeof row.contextFraction === 'number' && row.contextFraction >= CONTEXT_FULL_FRACTION) reasons.push('context-full')
    out.push({ row, key, idleMs, reasons })
  }
  const mem = (c: IdleCandidate) => (typeof c.row.rssBytes === 'number' ? c.row.rssBytes : -1)
  return out.sort((a, b) =>
    Number(Boolean(b.row.taskDone)) - Number(Boolean(a.row.taskDone))
    || mem(b) - mem(a)
    || b.idleMs - a.idleMs,
  )
}

export type GroupSuggestion =
  | { kind: 'existing'; groupId: string; name: string }
  | { kind: 'new'; name: string }

export function suggestGroup(
  c: IdleCandidate,
  groups: readonly { id: string; name: string; sessionKeys: string[] }[],
  rows: readonly IdleRowInput[],
  taskName: string | undefined,
  today: string,
): GroupSuggestion {
  const taskId = c.row.taskId
  if (taskId) {
    const taskKeys = new Set(rows.filter(r => r.taskId === taskId).map(r => sessionIdentityKey(r)))
    let best: { id: string; name: string; n: number } | null = null
    // Ties go to the later group (groups are stored in creation order): a forward scan that
    // overwrites on `>=` naturally keeps the last one seen, with no index to track.
    for (const g of groups) {
      const n = g.sessionKeys.filter(k => taskKeys.has(k)).length
      if (n > 0 && (!best || n >= best.n)) best = { id: g.id, name: g.name, n }
    }
    if (best) return { kind: 'existing', groupId: best.id, name: best.name }
    if (taskName && taskName.trim()) return { kind: 'new', name: taskName.trim() }
  }
  const dated = `Idle · ${today}`
  const existing = groups.find(g => g.name === dated)
  return existing ? { kind: 'existing', groupId: existing.id, name: existing.name } : { kind: 'new', name: dated }
}

/**
 * PURE: the default "File & end" destination for one candidate — a session already sitting in a
 * user group MUST be offered THAT group first, ahead of `suggestGroup`'s task/date rules. Filing it
 * anywhere else would move it out of a place its owner put it on purpose, which the modal cannot
 * know is wrong (a group named after a task the row's own `taskId` no longer names, or one holding
 * work the owner is tracking by hand rather than by task).
 *
 * Delegates to `suggestGroup` outright when the candidate belongs to no group — this is a
 * precedence rule layered in FRONT of it, never a second implementation of it.
 */
export function defaultGroupFor(
  c: IdleCandidate,
  groups: readonly { id: string; name: string; sessionKeys: string[] }[],
  rows: readonly IdleRowInput[],
  taskName: string | undefined,
  today: string,
): GroupSuggestion {
  const current = groups.find(g => g.sessionKeys.includes(c.key))
  if (current) return { kind: 'existing', groupId: current.id, name: current.name }
  return suggestGroup(c, groups, rows, taskName, today)
}

/** One notification per BATCH: fire only when a session not already announced joins. */
export function idleNotifyStep(
  prevNotified: ReadonlySet<string>,
  candidates: readonly IdleCandidate[],
): { notify: boolean; next: Set<string> } {
  const now = new Set(candidates.map(c => c.key))
  const notify = [...now].some(k => !prevNotified.has(k))
  return { notify, next: now }
}

/** Memory the batch holds, or null when no candidate's memory is known (never a confident 0). */
export function freedBytes(candidates: readonly IdleCandidate[]): number | null {
  const known = candidates.map(c => c.row.rssBytes).filter((b): b is number => typeof b === 'number')
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0)
}
