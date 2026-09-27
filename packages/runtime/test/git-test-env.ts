/**
 * git-test-env.ts — the environment every runtime TEST that runs `git` itself must use.
 *
 * This repo's pre-commit hook runs `bun test` from a linked worktree, and git exports `GIT_DIR`,
 * `GIT_INDEX_FILE` (and friends) into a hook's environment. A test that spawns `git init` / `git
 * commit` / `git config` in a throwaway directory with the inherited environment does NOT operate on
 * that directory — `cwd` and `-C` do not override `GIT_DIR`, which still wins — it operates on the
 * REAL repository. Measured 2026-09-27, the first time the B3 tests ran under the hook: dozens of
 * `init` commits landed on the branch being committed, and the hostile-repository test wrote its
 * `diff.external` / `textconv` / `core.fsmonitor` / `core.hooksPath` into the SHARED `.git/config`,
 * along with `core.bare = true` — breaking the main checkout and every worktree of every session.
 *
 * `server/backup/repo-probe.test.ts` had already learned this; this is the same rule, for the
 * runtime. The tools themselves are immune by construction (they spawn with `MINIMAL_TOOL_ENV` or a
 * caller's env, `../src/tools/env.ts`); only a test's own setup inherits the host's.
 *
 * It lives outside `src/` on purpose: `provider-secrets.lint.test.ts` forbids reading the process
 * environment anywhere in `src/`, and a test helper legitimately needs PATH and HOME.
 */

const REPO_POINTING_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  // `git commit` also exports the ident it is about to use into a hook's environment, and these
  // outrank a test's own `-c user.name=` — a throwaway repo's commits would carry the REAL author.
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
] as const

/** The process environment minus every variable that points git at some OTHER repository. */
export function gitTestEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue
    if ((REPO_POINTING_VARS as readonly string[]).includes(k)) continue
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue
    env[k] = v
  }
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}
