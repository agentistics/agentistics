/**
 * editor-directory.ts — PURE: which directory does a session's repository tree root at?
 *
 * The decision mirrors `sessionGitPaths` (`git.ts`) — "a session's own last directory, project as
 * the fallback" — extended with a LIVE row on top, because a running session's registry `cwd` is
 * more current than anything the consolidate store has written. Order:
 *
 *  1. A live managed/external fleet row's own `cwd` (the same source `readFleetArtifact` /
 *     `readFleetPullRequests` already use).
 *  2. Otherwise the store: `SessionMeta.current_cwd`, then `project_path` — this is what makes the
 *     tab work for a CLOSED session too, which no other aside tab needs to do today.
 *
 * This module takes already-gathered FACTS and decides; the IO that gathers them (`host.sessions()`,
 * `loadConsolidated()`, a `stat`) lives in `editor-fs.ts`. Same split as `shell-spec.ts`'s
 * `ShellOpenFacts` / `planShellOpen`.
 */

export interface SessionDirFacts {
  /** True when the id resolved to SOMETHING — a live fleet row, or a store record — even if that
   *  something records no directory. Distinguishes "this session has no folder" from "this
   *  machine has never heard of this session". */
  sessionKnown: boolean
  /** A live fleet row's `cwd`, when one was found. */
  liveCwd: string | undefined
  /** `SessionMeta.current_cwd || SessionMeta.project_path`, when a store record was found. */
  storeDir: string | undefined
  /** Does the chosen directory (`liveCwd || storeDir`) exist on disk right now? Meaningless when
   *  neither is set. */
  dirExists: boolean
}

export type SessionDirRefusal =
  /** Neither a live row nor a store record names this id at all. */
  | 'unknown-session'
  /** The session is known, but records no directory anywhere. */
  | 'no-cwd'
  /** It records one, and that directory is gone — the removed-worktree case. */
  | 'cwd-missing'

export type SessionDirPlan =
  | { ok: true; dir: string }
  | { ok: false; reason: SessionDirRefusal }

export function planSessionDirectory(f: SessionDirFacts): SessionDirPlan {
  const dir = f.liveCwd || f.storeDir
  if (!dir) return { ok: false, reason: f.sessionKnown ? 'no-cwd' : 'unknown-session' }
  if (!f.dirExists) return { ok: false, reason: 'cwd-missing' }
  return { ok: true, dir }
}
