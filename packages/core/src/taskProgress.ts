/**
 * taskProgress.ts — how much of a task its subtasks say is done. Pure.
 *
 * One rule, in one place, because four surfaces draw this bar (the card, the table, the detail
 * header, the subtask grid) and a percentage that rounds differently in two of them reads as two
 * different facts about the same task.
 *
 * The rule is the one the context gauge already follows: **round DOWN**, so a task with 99 of 100
 * pieces closed never reads 100% — a bar that says finished while something is open is the one
 * error this figure cannot afford. The reverse (0% while one is done) is deliberately NOT corrected
 * to 1%: it rounds down too, and a task that has genuinely started shows a sliver of bar rather
 * than a number nobody can act on.
 */

export interface TaskProgress {
  done: number
  total: number
  /** Counts keyed by the board's status ids. */
  counts: Record<string, number>
  inProgress?: number
  /** 0–100, rounded DOWN. `null` when there is nothing to be a fraction OF. */
  percent: number | null
  /** Widths for the composed bar, rounded DOWN and capped to the available total. */
  donePercent?: number | null
  inProgressPercent?: number | null
  blocked?: number
  blockedPercent?: number | null
  /** Every subtask closed, and there is at least one. */
  complete: boolean
}

export function taskProgress(done: number, total: number, inProgress = 0, blocked = 0, statusCounts?: Readonly<Record<string, number>>): TaskProgress {
  const composed = arguments.length >= 3
  // A task with no subtasks has no progress — not 0%. "Nobody broke this up" and "nothing is done
  // yet" are different facts, and a 0% bar on every unbroken task would make the bar meaningless.
  if (total <= 0) return composed
    ? { done: 0, total: 0, counts: {}, inProgress: 0, blocked: 0, percent: null, donePercent: null, inProgressPercent: null, blockedPercent: null, complete: false }
    : { done: 0, total: 0, counts: {}, percent: null, complete: false }
  const raw = statusCounts ?? { done, in_progress: inProgress, blocked }
  const counts: Record<string, number> = {}
  let remaining = total
  for (const [id, value] of Object.entries(raw)) {
    const count = Math.max(0, Math.min(Math.floor(value || 0), remaining))
    if (count > 0) counts[id] = count
    remaining -= count
  }
  const capped = counts.done ?? 0
  const active = counts.in_progress ?? 0
  const blockedCount = counts.blocked ?? 0
  const percent = Math.floor((capped / total) * 100)
  return composed
    ? {
      done: capped, total, counts, inProgress: active, blocked: blockedCount, percent,
      donePercent: percent,
      inProgressPercent: Math.floor((active / total) * 100),
      blockedPercent: Math.floor((blockedCount / total) * 100),
      complete: capped === total,
    }
    : { done: capped, total, counts, percent, complete: capped === total }
}

/**
 * A subtask GROUP's own progress, from its members' `done` flags
 * (docs/superpowers/specs/2026-09-11-alm-session-linking-ux.md §F.1: a group's status is what its
 * members' statuses say, the same way a task's is what its subtasks say). This is the SAME
 * round-down, no-bar-without-anything-to-measure rule as `taskProgress`, read one hierarchy level
 * down — not a second rule, which is why it is a thin call into it rather than its own arithmetic.
 *
 * Takes plain booleans rather than `Subtask[]` so it stays reachable from both sides of the
 * server/web boundary: a server route holding real `Subtask` records and a future UI holding the
 * wire's mirror type can both pass `members.map(m => m.done)` through the one rule.
 */
export function groupProgress(memberStatuses: readonly (boolean | string)[]): TaskProgress {
  const counts: Record<string, number> = {}
  for (const status of memberStatuses) {
    const id = typeof status === 'boolean' ? (status ? 'done' : 'todo') : status
    counts[id] = (counts[id] ?? 0) + 1
  }
  return taskProgress(counts.done ?? 0, memberStatuses.length, 0, 0, counts)
}
