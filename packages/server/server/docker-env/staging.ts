/**
 * DOCKER.AMBIENTES S2 (SPEC r4 §3.5 passo 1) — the STAGING directory the download container mounts INSTEAD of the
 * worktree. The host copies only a positive list — `package.json` of the root and of each workspace, the lockfile,
 * `pnpm-workspace.yaml` — and writes ONE `.npmrc` of its own. Nothing else of the repo exists there: no
 * `.pnpmfile.cjs`, `.npmrc`/`.yarnrc*`, `.pnp.*`, plugin or patch, so a package manager has no repo code to load
 * while it holds a registry grant or the shared (writable) cache.
 *
 * A lockfile that needs a file outside that list (`patches/`, `file:`, `link:`, `portal:`, `patch:`) is
 * `install_exige_arquivo_do_repo`: it NEVER falls back to a download with the worktree mounted.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NmSlot } from './plans'

export const STAGING_LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const
export const STAGING_WORKSPACE_FILES = ['pnpm-workspace.yaml'] as const

/** What a manifest or lockfile says when it needs a file the staging does not carry. */
const REPO_FILE_REF = /(^|["'\s:=@(,])(file|link|portal|patch):|patchedDependencies|\.pnpmfile/m

export const GENERATED_NPMRC = 'registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n'

export type StagingResult = { ok: true; copied: string[] } | { ok: false; code: 'install_exige_arquivo_do_repo'; reason: string }

/** PURE: does this text require a repo file the staging does not carry? */
export function needsRepoFile(text: string): string | null {
  const m = REPO_FILE_REF.exec(text)
  return m ? m[0].replace(/^[^A-Za-z.]/, '') : null
}

export function buildStaging(root: string, slots: readonly NmSlot[], dest: string): StagingResult {
  const picks: string[] = []
  for (const s of slots) { const rel = join(s.rel, 'package.json'); if (existsSync(join(root, rel))) picks.push(rel) }
  for (const f of [...STAGING_LOCKFILES, ...STAGING_WORKSPACE_FILES]) if (existsSync(join(root, f))) picks.push(f)
  for (const rel of picks) {
    const text = readFileSync(join(root, rel)).toString('latin1')
    const hit = needsRepoFile(text)
    if (hit) return { ok: false, code: 'install_exige_arquivo_do_repo', reason: `install_exige_arquivo_do_repo: ${rel} refers to "${hit}" (a file of the repository outside the staging list). The download never mounts the worktree: this install stays in the isolated namespace.` }
  }
  mkdirSync(dest, { recursive: true, mode: 0o700 })
  for (const rel of picks) {
    mkdirSync(join(dest, rel, '..'), { recursive: true, mode: 0o700 })
    copyFileSync(join(root, rel), join(dest, rel))
  }
  // The empty mount points of every node_modules (a read-only staging leaves the daemon no way to create them).
  for (const s of slots) mkdirSync(join(dest, s.rel, 'node_modules'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dest, '.npmrc'), GENERATED_NPMRC, { mode: 0o600 })
  return { ok: true, copied: [...picks, '.npmrc'] }
}
