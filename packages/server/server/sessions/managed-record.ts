/**
 * managed-record.ts — PURE: which of the harness records claiming one of our panes is really ITS.
 *
 * Claude Code writes `tmux: "agentop-<id>:@w.%p"` into `~/.claude/sessions/<pid>.json`, and
 * `harness-sessions.ts` keys `byManagedId` on it. That field is read from the process's ENVIRONMENT
 * (`TMUX` / `TMUX_PANE`), and an environment is INHERITED: any claude started from inside the pane —
 * by a preview server the session launched, by a `claude -p` it ran through Bash — writes the very
 * same pane into its own record. Newest-wins then handed the row the child's conversation, and the
 * registry recorded it (`harness-session-file` is "exact"). Seen 2026-10-09 22h30: a claude started
 * by a preview server running in the engine leader's pane took over the leader's chat on the real
 * server (LINK.CROSSTALK).
 *
 * The record is only trustworthy together with the PROCESS TREE, which cannot be inherited:
 * - a live record nested under another live record of the same pane is that record's child → never;
 * - a live record whose process does not descend from the pane's own pid is not in the pane → never;
 * - a live record claiming a pane that does not exist (`panePid === null`) → never;
 * - a dead record is history (the name a person typed survives the process) and still answers;
 * - two live survivors → AMBIGUOUS → `undefined`: the caller keeps whatever link it already has.
 * Off Linux (`alive` unknown) nothing can be checked and newest-wins stays, as before.
 */
import type { HarnessSessionFile } from './harness-session-file'

export interface ManagedCandidate {
  file: HarnessSessionFile
  mtimeMs: number
  /** The process's ancestors, nearest first, as `/proc` reported them. Absent when unread. */
  ancestors?: readonly number[]
}

/**
 * @param panePid the row's pane pid; `null` when the pane list was read and this row has none;
 *   `undefined` when nothing is known about panes (the nesting rule alone applies).
 */
export function pickManagedRecord(
  candidates: readonly ManagedCandidate[],
  panePid: number | null | undefined,
): HarnessSessionFile | undefined {
  if (candidates.length === 0) return undefined
  const livePids = new Set(
    candidates.filter(c => c.file.alive === true && c.file.pid !== undefined).map(c => c.file.pid!),
  )
  const survivors = candidates.filter(c => {
    if (c.file.alive !== true) return true
    const up = c.ancestors ?? []
    if (up.some(p => livePids.has(p))) return false
    if (panePid === null) return false
    if (panePid !== undefined && c.ancestors && c.file.pid !== panePid && !up.includes(panePid)) return false
    return true
  })
  const live = survivors.filter(c => c.file.alive === true)
  if (live.length > 1) return undefined
  if (live.length === 1) return live[0]!.file
  let best: ManagedCandidate | undefined
  for (const c of survivors) if (!best || c.mtimeMs >= best.mtimeMs) best = c
  return best?.file
}
