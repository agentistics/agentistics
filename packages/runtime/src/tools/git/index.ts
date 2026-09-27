/**
 * tools/git/index.ts — B3.6: `git.status` / `git.diff` / `git.log`, the read-only git tools
 * (spec docs/superpowers/specs/2026-09-20-runtime-b3-tool-catalogue.md §3 catalogue row, D-T6).
 *
 * ## `kind: 'other'`, not `'shell'`
 *
 * `ToolKind` has no dedicated `'git'` entry, so the choice is between `'shell'` and `'other'`.
 * `'shell'` is wrong: D-T3's permission model for a shell call is "parse the command into
 * segments and judge each one" (`PolicySubject`'s `{ action: 'shell'; command: string }`), which
 * exists because a shell command is an arbitrary, unbounded string. These three tools are the
 * opposite of that by construction — the argv is FIXED (`spawn.ts`'s `GIT_SAFE_ARGS` plus each
 * verb's own flags), the model can influence only a `repo`, a validated `rev`, a boolean and a
 * path list, and the policy subject is `{ action: 'git-read', repo, verb }` (`contract.ts`), a
 * shape `ToolPolicy` can decide on directly without parsing anything. Marking them `'shell'` would
 * also fold their call counts into shell-usage metrics/dashboards elsewhere in this product that
 * already treat `'shell'` as "the model ran an arbitrary command" — which is not what happened
 * here. `'other'` is the same choice `task.plan` / `ask.user` make for a tool whose kind is neither
 * a file op, a search, an MCP bridge, a browser action nor an agent spawn.
 *
 * ## Read verbs only (D-T6, decided 2026-09-25)
 *
 * `git.commit` / `git.branch` / `git.worktree` (write verbs) are v2, explicitly out of scope here.
 */

import type { Tool } from '../contract.ts'
import type { GitDiffInput } from './diff.ts'
import { createGitDiffTool } from './diff.ts'
import type { GitLogInput } from './log.ts'
import { createGitLogTool } from './log.ts'
import type { GitStatusInput } from './status.ts'
import { createGitStatusTool } from './status.ts'
import type { GitToolsRuntimeOptions } from './spawn.ts'

export interface GitTools {
  status: Tool<GitStatusInput>
  diff: Tool<GitDiffInput>
  log: Tool<GitLogInput>
}

export function createGitTools(opts: GitToolsRuntimeOptions = {}): GitTools {
  return {
    status: createGitStatusTool(opts),
    diff: createGitDiffTool(opts),
    log: createGitLogTool(opts),
  }
}

export type { GitToolsRuntimeOptions } from './spawn.ts'
export type { GitSpawner, GitSpawnOptions, GitSpawnOutcome } from './spawn.ts'
export { defaultGitSpawner, classifyGitFailure, GIT_SAFE_ARGS, GIT_DIFF_SAFE_ARGS } from './spawn.ts'
export type { GitStatusInput, GitStatusResult, GitStatusBucket } from './status.ts'
export { createGitStatusTool, parseGitStatusInput, parseStatusPorcelainV2 } from './status.ts'
export type { GitDiffInput, GitDiffResult, DiffStatSummary } from './diff.ts'
export { createGitDiffTool, parseGitDiffInput, parseDiffStat } from './diff.ts'
export type { GitLogInput, GitLogResult, GitLogCommit } from './log.ts'
export { createGitLogTool, parseGitLogInput, parseLogOutput, GIT_LOG_DEFAULT_MAX_COUNT, GIT_LOG_HARD_CAP } from './log.ts'
export { isSafeRev } from './rev.ts'
export { buildGitEnv } from './env.ts'
export { boundText } from './output.ts'
export type { BoundedText } from './output.ts'
