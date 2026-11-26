/**
 * autosave/autosave-plan.ts — PURE: every decision of an autosave round (machine-health spec §4, slice A1).
 *
 * The round itself (`autosave-io.ts`) runs git and moves files; this module decides WHAT it does:
 *
 * - which worktrees a set of repositories has (`parseWorktreeList`) and which of them need a look at all
 *   (`needsLook`: an uncommitted change or a commit no remote has);
 * - which UNTRACKED files may enter the save (`untrackedToSave`): never a secret-shaped name, never a file over
 *   `AUTOSAVE_MAX_UNTRACKED_BYTES`, never a nested repository. Tracked files are already in git and go as they are;
 * - whether a tree changed since its last save (`savedFingerprint` / `currentFingerprint`). The fingerprint is
 *   `<HEAD the save describes>:<tree>`, and the previous one is READ BACK FROM THE HIDDEN REF itself — so there
 *   is no state file that could disagree with what was actually saved, and a deleted bundle forces a new save;
 * - the names: the hidden ref (`refs/agentistics/autosave/<slug>`, outside `refs/heads`, so no branch list shows
 *   it), the bundle, its temp name and the daily snapshot;
 * - retention (`planRetention`): one current bundle per tree + the newest `keepDaily` daily snapshots.
 *
 * The leader's stopgap (`leader/wip/salvamento-auto.sh`) is the origin of every rule here; the secret pattern is
 * its `SECRET_RE`, widened with the key/keystore extensions it missed.
 */

import { createHash } from 'node:crypto'

/** An untracked file larger than this is left out of the save (the cron's 5242880). */
export const AUTOSAVE_MAX_UNTRACKED_BYTES = 5 * 1024 * 1024
/** Daily snapshots kept per tree (spec §4.1: "one daily snapshot kept 7 days"). */
export const AUTOSAVE_KEEP_DAILY = 7
/** A round is skipped below this much available memory — except the out-of-schedule `critical` round (§4.1.6). */
export const AUTOSAVE_MIN_MEM_BYTES = 1.5 * 1024 * 1024 * 1024
/** The hidden namespace. Never under `refs/heads`: an autosave is not a branch. */
export const AUTOSAVE_REF_PREFIX = 'refs/agentistics/autosave/'
export const BUNDLE_SUFFIX = '.bundle'
const SLUG_MAX = 100

/**
 * A secret-shaped path. The cron's `SECRET_RE` plus private-key and keystore extensions. Matched on the WHOLE
 * relative path, case-insensitively, so `config/.env.local` and `deploy/ID_RSA` are both refused.
 *
 * `.*` deliberately CROSSES `/`, exactly as the cron's does: a secret-named DIRECTORY refuses everything under it
 * (`secrets/prod.yaml`, `config/credentials/db.json`, `tokens/gh.txt`). A per-segment `[^/]*` was tried and let
 * those through (QA r1). The price is over-refusal (`src/tokens.ts` untracked stays out) — the safe direction:
 * a file left out of an autosave is still on disk, a secret carried off the VM is not recoverable.
 * `autosave-plan.test.ts` pins that this refuses everything the cron refuses.
 */
export const SECRET_RE = /(^|\/)(\.env(\..*)?|.*secret.*|.*credential.*|.*token.*|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)|id_(rsa|dsa|ecdsa|ed25519).*|\.npmrc|\.netrc|\.pgpass|\.git-credentials)$/is

export function isSecretPath(rel: string): boolean {
  return SECRET_RE.test(rel)
}

export type SkipReason = 'secret' | 'too-large' | 'unreadable' | 'nested-repo'
export interface UntrackedEntry { path: string; size: number | null }
export interface UntrackedPlan { keep: string[]; skipped: Array<{ path: string; reason: SkipReason }> }

/**
 * Untracked files (from `git ls-files -o --exclude-standard`, so `.gitignore` is already respected) → the ones the
 * save may carry. `size` is the file's own size (`lstat`), `null` when it could not be read. A path ending in `/`
 * is a nested repository git refuses to descend into; adding it would record a gitlink, not the work.
 */
export function untrackedToSave(entries: readonly UntrackedEntry[], maxBytes = AUTOSAVE_MAX_UNTRACKED_BYTES): UntrackedPlan {
  const keep: string[] = []
  const skipped: UntrackedPlan['skipped'] = []
  for (const e of entries) {
    if (e.path.endsWith('/')) skipped.push({ path: e.path, reason: 'nested-repo' })
    else if (isSecretPath(e.path)) skipped.push({ path: e.path, reason: 'secret' })
    else if (e.size === null) skipped.push({ path: e.path, reason: 'unreadable' })
    else if (e.size > maxBytes) skipped.push({ path: e.path, reason: 'too-large' })
    else keep.push(e.path)
  }
  return { keep, skipped }
}

/** NUL-separated git output (`-z`) → its records, the trailing empty one dropped. */
export function splitNul(out: string): string[] {
  return out.split('\0').filter(s => s.length > 0)
}

/** `git worktree list --porcelain` → the worktrees that exist as checkouts (bare and prunable ones dropped). */
export function parseWorktreeList(porcelain: string): string[] {
  const out: string[] = []
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n').map(l => l.trimEnd()).filter(Boolean)
    const wt = lines.find(l => l.startsWith('worktree '))
    if (!wt) continue
    if (lines.some(l => l === 'bare' || l.startsWith('prunable'))) continue
    out.push(wt.slice('worktree '.length))
  }
  return out
}

/** Distinct paths, first occurrence order. */
export function dedupeTrees(paths: readonly string[]): string[] {
  return [...new Set(paths.map(p => p.replace(/\/+$/, '') || '/'))]
}

/** A tree needs a look only when it holds something no remote has: an uncommitted change or an unpushed commit. */
export function needsLook(facts: { dirty: boolean; ahead: number }): boolean {
  return facts.dirty || facts.ahead > 0
}

/**
 * The stable name of one worktree: its path below `home`, sanitised, cut, plus 8 hex of the FULL path's hash —
 * two long paths cut to the same prefix must never share a bundle.
 */
export function autosaveSlug(treePath: string, home: string): string {
  const h = home.replace(/\/+$/, '')
  const rel = h && treePath.startsWith(`${h}/`) ? treePath.slice(h.length + 1) : treePath.replace(/^\/+/, '')
  const base = rel.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.]+/, '_').slice(0, SLUG_MAX) || 'root'
  const hash = createHash('sha256').update(treePath).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

export function autosaveRef(slug: string): string {
  return `${AUTOSAVE_REF_PREFIX}${slug}`
}

export interface BundleNames { current: string; temp: string; daily: string; dailyTemp: string }

/** File names (no directory) for one slug on one UTC day. The temp names start with `.` and are never read back. */
export function bundleNames(slug: string, day: string): BundleNames {
  return {
    current: `${slug}${BUNDLE_SUFFIX}`,
    temp: `.${slug}${BUNDLE_SUFFIX}.tmp`,
    daily: `${slug}.${day}${BUNDLE_SUFFIX}`,
    dailyTemp: `.${slug}.${day}${BUNDLE_SUFFIX}.tmp`,
  }
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The fingerprint of the state a round is looking at: the HEAD it would save on top of, and the tree it built. */
export function currentFingerprint(head: string, tree: string): string {
  return `${head}:${tree}`
}

/**
 * The fingerprint of what the hidden ref already holds. A ref equal to HEAD saved a clean tree (its own tree);
 * otherwise it is a save commit whose FIRST parent is the HEAD it was built on. `null` = no previous save.
 */
export function savedFingerprint(ref: { commit: string; parent: string | null; tree: string } | null, head: string, headTree: string): string | null {
  if (!ref) return null
  if (ref.commit === head) return currentFingerprint(head, headTree)
  return ref.parent ? currentFingerprint(ref.parent, ref.tree) : null
}

export type TreeVerdict =
  | { save: true; commitNeeded: boolean }
  | { save: false; why: 'unchanged' | 'nothing-saveable' }

/**
 * After the tree is built: save, or skip. `commitNeeded` is false when the work is only unpushed commits (the ref
 * points at HEAD itself). A dirty status whose saveable tree equals HEAD's — e.g. the only change is a secret or an
 * oversized untracked file — has nothing to carry unless there are unpushed commits.
 */
export function decideTree(input: {
  head: string; headTree: string; tree: string; ahead: number
  saved: string | null; bundlePresent: boolean
}): TreeVerdict {
  const commitNeeded = input.tree !== input.headTree
  if (!commitNeeded && input.ahead === 0) return { save: false, why: 'nothing-saveable' }
  if (input.bundlePresent && input.saved === currentFingerprint(input.head, input.tree)) return { save: false, why: 'unchanged' }
  return { save: true, commitNeeded }
}

/** Whether a round runs now. The `critical` round (the machine is about to fail) runs whatever memory says. */
export function shouldRunRound(input: { memAvailableBytes: number | null; critical: boolean }): { run: boolean; why?: 'low-memory' } {
  if (input.critical) return { run: true }
  if (input.memAvailableBytes !== null && input.memAvailableBytes < AUTOSAVE_MIN_MEM_BYTES) return { run: false, why: 'low-memory' }
  return { run: true }
}

/** The save commit's message — names the tree and the time, so `git log` of the bundle reads by itself. */
export function commitMessage(slug: string, treePath: string, nowMs: number): string {
  return `chore: autosave ${new Date(nowMs).toISOString()} (${slug})\n\nagentistics autosave of ${treePath}\n`
}

/**
 * Retention for one slug over the bundle directory's listing: the current bundle is never touched, daily
 * snapshots beyond the newest `keep` are removed, and a leftover temp file of THIS slug from a crashed round is
 * removed too (it is never the previous bundle — that one is only ever replaced by a completed move).
 */
export function planRetention(files: readonly string[], slug: string, keep = AUTOSAVE_KEEP_DAILY, activeTemps: readonly string[] = []): string[] {
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const daily = new RegExp(`^${esc}\\.(\\d{4}-\\d{2}-\\d{2})\\${BUNDLE_SUFFIX}$`)
  const temp = new RegExp(`^\\.${esc}(\\.\\d{4}-\\d{2}-\\d{2})?\\${BUNDLE_SUFFIX}\\.tmp$`)
  const days = files.map(f => ({ f, m: daily.exec(f) })).filter(x => x.m).map(x => ({ f: x.f, day: x.m![1]! }))
  days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
  const drop = days.slice(Math.max(0, keep)).map(d => d.f)
  for (const f of files) if (temp.test(f) && !activeTemps.includes(f)) drop.push(f)
  return drop
}

/** Where the bundles go by default (spec §4.2), and whether that place survives the VM disk failing. */
export interface BundleDirChoice { dir: string; offVm: boolean }

export function defaultBundleDir(input: {
  platform: string; wsl: boolean; home: string; dataDir: string
  /** The Windows profile already translated to a WSL path (`/mnt/c/Users/x`), or null when it could not be read. */
  windowsProfile: string | null
  localAppData?: string
}): BundleDirChoice {
  if (input.wsl && input.windowsProfile) return { dir: `${input.windowsProfile.replace(/\/+$/, '')}/agentistics-autosave`, offVm: true }
  if (input.platform === 'win32' && input.localAppData) return { dir: `${input.localAppData.replace(/[\\/]+$/, '')}\\agentistics\\autosave`, offVm: false }
  return { dir: `${input.dataDir.replace(/\/+$/, '')}/autosave`, offVm: false }
}

/** `cmd.exe /c echo %USERPROFILE%` output → the Windows path, or null when the variable did not expand. */
export function parseWindowsProfile(out: string): string | null {
  const line = out.split(/\r?\n/).map(l => l.trim()).find(Boolean)
  if (!line || line.includes('%') || !/^[A-Za-z]:\\/.test(line)) return null
  return line
}

/** WSL: the interop env names the distro, or `/proc/version` names the Microsoft kernel. */
export function isWslHost(procVersion: string | null, env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.WSL_DISTRO_NAME) || (procVersion !== null && /microsoft/i.test(procVersion))
}
