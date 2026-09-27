/**
 * gitTestEnv.ts — the environment every TEST in this repo that spawns `git` itself must use.
 *
 * Incident, 2026-09-27 16:58 BRT: this repo's pre-commit hook runs `bun test` from a LINKED
 * WORKTREE, and git fires a hook with `GIT_DIR` / `GIT_INDEX_FILE` (and friends) exported into its
 * environment, pointing at the outer checkout. `cwd` and `-C` do NOT override `GIT_DIR` — it still
 * wins repository discovery — so a test that meant to `git init`/`commit`/`config` a throwaway
 * directory, spawned with the INHERITED environment, does not touch that directory at all: it
 * operates on the REAL repository. Measured that day: 18-25 spurious commits landed on the branch
 * being committed, and a hostile-repository test wrote `diff.external` / `textconv` /
 * `core.fsmonitor` / `core.hooksPath` (plus `core.bare = true`) into the SHARED `.git/config` —
 * breaking every session on the machine at once, restored within about a minute.
 *
 * Two modules had already learned this the hard way, separately, before this one existed:
 * `packages/runtime/test/git-test-env.ts` (B3) and `packages/server/server/backup/repo-probe.ts`'s
 * own `gitEnv()` (a PRODUCTION function with a different job — see the note at the bottom). This
 * module is the ONE canonical TEST-side answer both packages import, so the lesson is structural
 * rather than copy-pasted per package.
 *
 * The variable list below is read from git's own documentation, not guessed — `git help
 * environment` (i.e. `man git`, § "The Git Repository" / "Git Commits" / "other") and `git help
 * config` (§ ENVIRONMENT), git 2.53.0. Every stripped variable is cited by category:
 *
 *  - **Repository location** (`git(1)` § "The Git Repository"): `GIT_DIR` ("a path to use instead
 *    of the default .git for the base of the repository"), `GIT_WORK_TREE` ("the path to the root
 *    of the working tree"), `GIT_INDEX_FILE` ("an alternate index file"), `GIT_COMMON_DIR`
 *    ("non-worktree files that are normally in $GIT_DIR will be taken from this path instead"),
 *    `GIT_OBJECT_DIRECTORY` (where new objects are written), `GIT_ALTERNATE_OBJECT_DIRECTORIES`
 *    (extra object search paths), `GIT_NAMESPACE` (`gitnamespaces(7)`), `GIT_CEILING_DIRECTORIES`
 *    / `GIT_DISCOVERY_ACROSS_FILESYSTEM` (bound repository discovery — a hook can widen or narrow
 *    which `.git` a bare `git` in a throwaway directory finds), `GIT_PREFIX` (the hook-exported
 *    subdirectory prefix a command was invoked from).
 *  - **A config source** (`git-config(1)` § ENVIRONMENT): `GIT_CONFIG` ("used ... as if it were
 *    provided via --file"), `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` ("take the configuration from
 *    the given files instead"), `GIT_CONFIG_COUNT` plus `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 *    ("added to the process's runtime configuration" — these OUTRANK a test's own `-c` flags),
 *    `GIT_CONFIG_PARAMETERS` (git's own internal wire form for `-c` pairs, propagated to children).
 *  - **An author/committer identity** (`git(1)` § "Git Commits"): `GIT_AUTHOR_NAME/EMAIL/DATE`,
 *    `GIT_COMMITTER_NAME/EMAIL/DATE` ("overrides the user.name and … configuration settings" —
 *    these outrank a test's own `-c user.name=`), and `EMAIL` (the fallback identity when nothing
 *    else is set).
 *  - **Behaviour that would hang or misdirect a test, not a repository pointer but just as
 *    dangerous inherited from a hook** (`git(1)` § "other"): `GIT_EDITOR` / `GIT_SEQUENCE_EDITOR`
 *    (would block on an interactive editor a test has no tty for) and `GIT_EXEC_PATH` (redirects
 *    which `git-*` helper binaries run, `--exec-path`'s environment form).
 *
 * On top of the strip: **`HOME` and `GIT_CONFIG_GLOBAL` are POINTED AT A THROWAWAY directory**,
 * not merely left deleted. Deleting `GIT_CONFIG_GLOBAL` alone still leaves git falling back to
 * `$HOME/.gitconfig` (`git(1)` § System: "HOME — specifies the path to the user's home
 * directory"), which is the DEVELOPER's real global config — their `user.name`/`user.email`,
 * aliases, a `credential.helper`, or a `core.hooksPath` none of this repo's tests should ever be
 * able to observe or trigger. Redirecting both to one fresh, never-written-to directory makes every
 * spawned `git` start from nothing, exactly like a clean CI runner would, regardless of whose
 * machine the test happens to run on.
 *
 * `GIT_CONFIG_NOSYSTEM=1` additionally skips the machine-wide `/etc/gitconfig`, and
 * `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=echo` guarantee a test can never block on a credential
 * prompt it has no tty to answer.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_POINTING_VARS = [
  // Repository location — git(1) § "The Git Repository"
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  // A config source — git-config(1) § ENVIRONMENT
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  // An author/committer identity — git(1) § "Git Commits"
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE', 'EMAIL',
  // Behaviour that would hang or misdirect a test — git(1) § "other"
  'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_EXEC_PATH',
] as const

// `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` are numbered, so they can't be listed by name.
const CONFIG_PAIR_RE = /^GIT_CONFIG_(KEY|VALUE)_\d+$/

// Lazily created once per process and reused: the path itself is a constant sentinel, never read
// back, so there is nothing to recompute per call the way the env STRIP is (see `gitEnv()` in
// `repo-probe.ts` for why that one is rebuilt every call instead).
let throwawayHome: string | null = null
function homeDir(): string {
  if (!throwawayHome) throwawayHome = mkdtempSync(join(tmpdir(), 'agentistics-git-test-home-'))
  return throwawayHome
}

/**
 * The process environment minus every variable that could point a spawned `git` at some OTHER
 * repository, inject configuration or an identity a test did not ask for, or hang waiting on a
 * prompt — plus `HOME`/`GIT_CONFIG_GLOBAL` redirected to a throwaway directory so a developer's own
 * `~/.gitconfig` can never leak into a test either.
 *
 * `base` defaults to `process.env` and exists so a caller can test the strip itself against a
 * planted fixture environment without mutating the real process env.
 */
export function gitTestEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue
    if ((REPO_POINTING_VARS as readonly string[]).includes(k)) continue
    if (CONFIG_PAIR_RE.test(k)) continue
    env[k] = v
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = 'echo'
  env.GIT_CONFIG_NOSYSTEM = '1'
  const home = homeDir()
  env.HOME = home
  env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig')
  return env
}
