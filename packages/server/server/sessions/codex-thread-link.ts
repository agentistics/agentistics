/**
 * codex-thread-link.ts — PURE. Which Codex thread a running `codex` process is driving, read off Codex's
 * OWN state (`~/.codex/state_<n>.sqlite`, table `threads`) rather than off an open file.
 *
 * Why not the rollout fd: codex 0.161 keeps `state_5.sqlite` open and appends to the rollout without holding
 * it, so an externally started TUI named no conversation, fell to "latest in this cwd", and a takeover could
 * reopen the wrong one (or none). The `threads` row carries `id`, `cwd` and `created_at_ms`, written when the
 * run starts — the same pairing `opencode-run-link.ts` makes: the thread created in THIS process's cwd within
 * `START_SKEW_MS` of ITS start time.
 *
 * Every ambiguity is no answer (a link is treated as exact downstream): two candidate threads for one process,
 * or one thread that is the candidate of two processes → nobody gets it. Archived threads and threads a
 * managed row already drives (`taken`) are not candidates.
 */

/** Wide on purpose (WSL2 wall-clock jumps, see `opencode-run-link.ts`): it only ever refuses more. */
export const START_SKEW_MS = 60_000

export interface CodexThread {
  id: string
  cwd: string
  /** `created_at_ms` (epoch ms). */
  createdMs: number
  archived: boolean
}

export interface CodexProcessRef {
  pid: number
  cwd: string
  /** The kernel's start time (epoch ms). Without it a process can be paired with nothing. */
  startedMs?: number
}

export function linkCodexProcesses(
  procs: readonly CodexProcessRef[],
  threads: readonly CodexThread[],
  skewMs: number = START_SKEW_MS,
  taken: ReadonlySet<string> = new Set(),
): Map<number, string> {
  const candidateOf = new Map<number, CodexThread>()
  const claimants = new Map<string, number>()
  for (const p of procs) {
    if (p.startedMs === undefined) continue
    const hits = threads.filter(t => !t.archived && !taken.has(t.id) && t.cwd === p.cwd
      && Math.abs(t.createdMs - p.startedMs!) <= skewMs)
    if (hits.length !== 1) continue
    candidateOf.set(p.pid, hits[0]!)
    claimants.set(hits[0]!.id, (claimants.get(hits[0]!.id) ?? 0) + 1)
  }
  const out = new Map<number, string>()
  for (const [pid, t] of candidateOf) if (claimants.get(t.id) === 1) out.set(pid, t.id)
  return out
}
