/**
 * tools/git/run-git.ts — the one place `status.ts` / `diff.ts` / `log.ts` invoke the spawner and
 * turn its outcome into either a successful `{stdout, stderr, exitCode}` or an already-classified
 * `ToolError` — so the three tools do not each reinvent "git missing" vs "not a repository" vs
 * "git failed for some other reason" detection.
 */

import type { ToolError } from '../contract.ts'
import { classifyGitFailure, looksLikeMissingGit, type GitSpawner, type GitSpawnOptions } from './spawn.ts'

export interface GitCallSuccess {
  ok: true
  stdout: string
  stderr: string
  exitCode: number
}

export interface GitCallFailure {
  ok: false
  error: ToolError
}

export type GitCallResult = GitCallSuccess | GitCallFailure

const MAX_DETAIL_CHARS = 200

/**
 * Runs `argv` through `spawner`. A thrown error is either "git is not installed here"
 * (`unavailable`) or some other spawn-time failure (`internal`) — never left to propagate, because
 * `defineTool`'s `run` is documented to report `internal` on an uncaught throw, and doing the
 * classification here keeps that sentence SPECIFIC instead of the gate's generic fallback.
 */
export async function runGit(spawner: GitSpawner, argv: string[], opts: GitSpawnOptions): Promise<GitCallResult> {
  let outcome
  try {
    outcome = await spawner(argv, opts)
  } catch (err) {
    if (looksLikeMissingGit(err)) {
      return { ok: false, error: { class: 'unavailable', detail: 'git is not available on this machine.' } }
    }
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: { class: 'internal', detail: `git could not be started: ${message.slice(0, MAX_DETAIL_CHARS)}` },
    }
  }
  if (outcome.exitCode !== 0) {
    const { errorClass, sentence } = classifyGitFailure(outcome.stderr)
    return { ok: false, error: { class: errorClass, detail: sentence } }
  }
  return { ok: true, stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode }
}
