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
  /** 0–100, rounded DOWN. `null` when there is nothing to be a fraction OF. */
  percent: number | null
  /** Every subtask closed, and there is at least one. */
  complete: boolean
}

export function taskProgress(done: number, total: number): TaskProgress {
  // A task with no subtasks has no progress — not 0%. "Nobody broke this up" and "nothing is done
  // yet" are different facts, and a 0% bar on every unbroken task would make the bar meaningless.
  if (total <= 0) return { done: 0, total: 0, percent: null, complete: false }
  const capped = Math.max(0, Math.min(done, total))
  return {
    done: capped,
    total,
    percent: Math.floor((capped / total) * 100),
    complete: capped === total,
  }
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
export function groupProgress(memberDone: readonly boolean[]): TaskProgress {
  return taskProgress(memberDone.filter(Boolean).length, memberDone.length)
}
