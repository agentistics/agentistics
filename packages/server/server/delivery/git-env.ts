/**
 * delivery/git-env.ts — the ONE environment every git process spawned by the delivery guard (and its tests) runs under.
 *
 * Inside a git hook (husky's pre-commit) `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`, `GIT_PREFIX`… are exported and point at
 * the REAL repository. A child `git` that inherits them ignores its own cwd and acts on that repository — which is how a test
 * that ran `git init` in a temp directory once rewrote `core.bare` and renamed branches of the real checkout. So a spawn never
 * inherits ANY `GIT_*` variable: it gets the parent's environment minus those, plus the few settings it wants explicitly,
 * and always an explicit cwd (`-C`).
 */

/** The environment minus every inherited `GIT_*` key. Pure. */
export function cleanGitEnv(base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith('GIT_')) continue
    out[k] = v
  }
  return out
}

/** The environment of one spawn: clean, never prompting for credentials, plus explicit extras (which may be `GIT_*`). */
export function gitSpawnEnv(extra: Record<string, string> = {}, base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  return { ...cleanGitEnv(base), GIT_TERMINAL_PROMPT: '0', ...extra }
}
