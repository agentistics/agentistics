/**
 * tools/git/spawn.ts — the FIXED argv every git-read call runs with, the injectable spawner, and
 * the pure classifier that turns a failed call into a `ToolErrorClass` (spec docs/superpowers/
 * specs/2026-09-20-runtime-b3-tool-catalogue.md §3, §4, D-T6).
 *
 * ## Why a fixed argv at all
 *
 * `git.status` / `git.diff` / `git.log` are catalogued as READ, `permission: 'auto'` tools — the
 * model does not ask a person before calling them. That is only safe if they cannot be turned into
 * something else by the repository they are reading. A `.git/config` (or, for `diff.<driver>.
 * textconv`, a `.gitattributes` naming a driver plus a matching config entry) can make an ordinary
 * "read" spawn an ARBITRARY PROGRAM as a side effect of the read — a fsmonitor hook consulted by
 * `status`, an external diff driver or a textconv filter consulted by `diff` (and, for a `-p` log,
 * by `log` too). None of that is hypothetical; it is documented git behaviour, exactly the surface
 * this tool exists to close. Every flag below defeats one such path. `-c` on the COMMAND LINE
 * always wins over a value written in the repository's own `.git/config`, which is why the `-c`
 * overrides are effective even though the hostile setting was never removed from the file.
 *
 * - `-c core.fsmonitor=false` — a repo can point `core.fsmonitor` at an arbitrary script git
 *   consults (and RUNS) to speed up `status`/`diff` by asking "what changed since last time".
 *   Forcing it `false` means that script is never invoked by these calls, however the repo's own
 *   config names it.
 * - `-c core.pager=cat` — a repo (or the user's global config) can set `core.pager` to an arbitrary
 *   command. Belt-and-suspenders with `GIT_PAGER=cat` (`env.ts`) and the fact that stdout here is
 *   a pipe, not a tty, so git should not try to page at all — but a hostile config could still try.
 * - `-c color.ui=false` — every parser in this directory (`status.ts`'s porcelain reader, `diff.ts`'s
 *   `--stat` reader, `log.ts`'s field reader) expects plain text; forcing colour off is what keeps
 *   a repo-level `color.*` setting from injecting ANSI escapes into text these regexes read.
 * - `-c diff.external=` — a repo can set `diff.external` to an arbitrary command git runs INSTEAD
 *   of its own diff algorithm, for every file, on `git diff`. Setting it to the empty string here
 *   overrides that (command-line `-c` wins over the file); `--no-ext-diff` on the diff/log-specific
 *   argv below is the AUTHORITATIVE switch for the same thing and is kept as well because it is the
 *   documented, git-maintained way to disable it — the `-c` here is the uniform baseline shared by
 *   all three verbs, `status` included, even though `status` itself never runs an external diff.
 * - `-c core.hooksPath=/dev/null` — points git's hook directory somewhere that cannot hold an
 *   executable script, so a repo-local hook — none of which these three read-only verbs normally
 *   trigger, but a future git version or a plumbing command that DOES call one would otherwise run
 *   whatever the repository configured — can never fire as a side effect of a git-read call.
 * - `--no-optional-locks` — status/diff/log are reads; this stops git from writing the lock/refresh
 *   files it otherwise would as a housekeeping side effect (refreshing `.git/index`'s stat cache),
 *   so a read here can never race, or interfere, with something else touching the repository
 *   concurrently, and can never fail merely because it could not take a lock.
 *
 * `--no-ext-diff` / `--no-textconv` (diff and log only — `status` never diffs a file's content) are
 * the two flags that are THE authoritative disable for `diff.external`/`GIT_EXTERNAL_DIFF` and for
 * `diff.<driver>.textconv` respectively; `--end-of-options` (diff/log, right before the revision
 * argument) is documented in `rev.ts`'s header.
 */

import type { ToolEnv } from '../env.ts'
import type { ToolErrorClass } from '../contract.ts'

/** Shared by every git-read call, regardless of verb. */
export const GIT_SAFE_ARGS: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
  '-c', 'color.ui=false',
  '-c', 'diff.external=',
  '-c', 'core.hooksPath=/dev/null',
  '--no-optional-locks',
]

/** Appended for `diff` and `log` (which may show patch content); never needed by bare `status`. */
export const GIT_DIFF_SAFE_ARGS: readonly string[] = ['--no-ext-diff', '--no-textconv', '--no-color']

export interface GitSpawnOptions {
  cwd: string
  env: Record<string, string>
  signal?: AbortSignal
}

export interface GitSpawnOutcome {
  exitCode: number
  stdout: string
  stderr: string
}

/** Shared by `createGitStatusTool` / `createGitDiffTool` / `createGitLogTool` / `createGitTools`. */
export interface GitToolsRuntimeOptions {
  spawn?: GitSpawner
  /** What git sees (before `buildGitEnv` strips and pins). Default `MINIMAL_TOOL_ENV`. */
  env?: ToolEnv
}

/**
 * Runs `argv[0]` (always `'git'` here) with `argv.slice(1)` as its arguments. Injectable so a test
 * can prove a DENIED call never reaches here at all (a spy that records zero calls), and so
 * "git is not installed" can be exercised without needing an environment that actually lacks git.
 */
export type GitSpawner = (argv: string[], opts: GitSpawnOptions) => Promise<GitSpawnOutcome>

/**
 * `Bun.spawn` throws (synchronously, which an `async` function turns into a rejected promise) when
 * the executable cannot be found — that is how "unavailable" (spec's `TOOL_ERROR_CLASSES`, "no
 * git…") is told apart from a call that ran and failed. Never given `stdin`, so a git that expects
 * interactive input (which `GIT_TERMINAL_PROMPT=0` already discourages) reads EOF immediately
 * rather than hanging this call forever.
 */
export const defaultGitSpawner: GitSpawner = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    signal: opts.signal,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

const BAD_REVISION_PATTERN = /bad revision|unknown revision|ambiguous argument|fatal: bad object/i
const NOT_A_REPO_PATTERN = /not a git repository/i

/**
 * PURE. What a non-zero exit means, from the process's own stderr — never the raw text (bounded,
 * summarised to one short sentence, per D-T6's acceptance test). `stderr` is assumed to already be
 * plain, untranslated English (`env.ts`'s `LC_ALL=C`), which is what makes these patterns reliable.
 */
export function classifyGitFailure(stderr: string): { errorClass: ToolErrorClass; sentence: string } {
  if (NOT_A_REPO_PATTERN.test(stderr)) {
    return { errorClass: 'not-found', sentence: 'That directory is not a git repository (or none of its parents is).' }
  }
  if (BAD_REVISION_PATTERN.test(stderr)) {
    return { errorClass: 'invalid-input', sentence: 'git could not resolve the requested revision.' }
  }
  const firstLine = (stderr.split('\n').find(l => l.trim().length > 0) ?? 'git exited with an error').trim()
  const summary = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
  return { errorClass: 'internal', sentence: `git failed: ${summary}` }
}

/** True when `err` looks like the spawner could not find/start the `git` executable at all. */
export function looksLikeMissingGit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /enoent|no such file or directory|not found/i.test(message)
}
