/**
 * tools/git/env.ts — the environment every git call under git.status / git.diff / git.log runs
 * with (spec docs/superpowers/specs/2026-09-20-runtime-b3-tool-catalogue.md §3, D-T6).
 *
 * These are READ verbs, so they must be safe against a HOSTILE repository — a `.git/config` (or,
 * for `diff.<driver>.textconv`, a `.gitattributes` plus a matching config entry) that turns a
 * "read" into arbitrary code execution is a real, documented git surface, not a hypothetical one.
 * Two things decide what actually runs: the fixed `-c` overrides + flags in `spawn.ts`, and this
 * environment. Both are needed — a hostile setting can live in the repo's `.git/config` (overridden
 * by `-c`, which always wins over a config FILE) or be inherited from THIS PROCESS's own
 * environment (overridden here).
 *
 * `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` deserve special mention: they OUTRANK `-C <path>`
 * (and our `cwd`-based equivalent) entirely. The runtime process can itself be started from inside
 * a git worktree, a hook, or a directory someone has already `cd`ed into for an unrelated reason —
 * any of these inherited from the PARENT would silently point a git-read tool at a repository other
 * than the one the model actually named. So the whole `GIT_*` family that can redirect where git
 * looks is stripped from the base environment before the fixed values below are set, never merely
 * overridden by convention.
 */

/**
 * Every `GIT_*` variable that can change WHICH repository, WHICH objects, or WHICH external
 * program git consults for one of these calls — stripped from the inherited environment rather
 * than trusted. `GIT_ASKPASS` / `GIT_SSH` / `GIT_SSH_COMMAND` are included even though status/
 * diff/log rarely touch the network, because a hostile alias in the parent shell for these is the
 * same class of "the read becomes a command" defect the `-c` flags in `spawn.ts` exist to close.
 */
import { MINIMAL_TOOL_ENV, type ToolEnv } from '../env.ts'
const STRIP_GIT_ENV_VARS: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_ATTR_SOURCE',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS',
  'GIT_PAGER',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
]

/**
 * Builds the env for one git-read call from `base` (default `MINIMAL_TOOL_ENV`; the runtime never reads
 * its own environment — `../env.ts`).
 *
 * - `GIT_TERMINAL_PROMPT=0` — never let git open an interactive credential prompt; that would hang
 *   the child waiting on a tty this call never has.
 * - `GIT_OPTIONAL_LOCKS=0` — the environment twin of `spawn.ts`'s `--no-optional-locks`, for any
 *   internal path that only checks the variable.
 * - `GIT_PAGER=cat` — belt-and-suspenders with `-c core.pager=cat`: whichever one git consults
 *   first, the answer is the same, and output goes straight to our captured pipe.
 * - `LC_ALL=C` — every classifier here (`spawn.ts`'s `classifyGitFailure`, the porcelain/`--stat`
 *   parsers) reads git's stdout/stderr with fixed English patterns. `--porcelain`/`--format`
 *   output is documented as machine-readable only under the C locale; a translated git binary
 *   would defeat both the "not a git repository" detection and (in principle) any locale-sensitive
 *   formatting in the plumbing output.
 */
export function buildGitEnv(base: ToolEnv = MINIMAL_TOOL_ENV): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (STRIP_GIT_ENV_VARS.includes(key)) continue
    env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_PAGER = 'cat'
  env.LC_ALL = 'C'
  return env
}
