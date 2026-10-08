/**
 * fs-folders.ts — one LEVEL of subfolders, for the "Procurar pasta…" browser in New session.
 *
 * A non-technical person must never type a path, and with disks enabled must be able to pick ANY
 * folder, not only the indexed projects. So this lists DIRECTORIES only (name, path, hasChildren) —
 * never a file name, never file contents — one level per request, lazily.
 *
 * THE ALLOWLIST IS THE WHOLE SECURITY STORY: a path is listable only when it is the install disk's
 * home or lives under it, or lives under an ENABLED disk (`preferences.scanRoots`). Anything else is
 * `forbidden`; the route answers 403. The check runs on the RESOLVED real path, so a symlink inside
 * the home cannot lead out of it. It hides system/temp folders with the disk index's own skip list
 * (`shouldPruneDirectory`) so the two can never disagree about what is implementation space.
 *
 * A slow disk (Windows over /mnt) must not hold the dialog: the listing has a budget and, past it,
 * answers what it has with `partial: true` — said in words by the UI, never a silently short list.
 */
import { readdir, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { shouldPruneDirectory } from './sessions/dir-scan'
import { isExcludedProjectPath } from './sessions/project-source'

export interface FolderEntry { name: string; path: string; hasChildren: boolean }

export type FolderListing =
  | { ok: true; path: string; parent: string | null; folders: FolderEntry[]; partial: boolean }
  | { ok: false; reason: 'forbidden' | 'not-found' | 'bad-path' }

export const LISTING_BUDGET_MS = 1_500

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function inside(path: string, root: string): boolean {
  const a = norm(path)
  const b = norm(root)
  return b === '' ? true : a === b || a.startsWith(`${b}/`)
}

/** The roots a person may browse: the install disk's home plus every enabled disk. */
export function allowedRoots(scanRoots: readonly string[], home = homedir()): string[] {
  return [...new Map([home, ...scanRoots].filter(Boolean).map(r => [norm(r), r])).values()]
}

export function isAllowedPath(path: string, roots: readonly string[]): boolean {
  return roots.some(r => inside(path, r))
}

/** The folder list's first screen: the home and each enabled disk. No file system read. */
export function rootListing(roots: readonly string[]): FolderEntry[] {
  return roots.map(r => ({ name: r === roots[0] ? basename(r) || r : r, path: r, hasChildren: true }))
}

/** Hidden: dot-folders (configuration, never a place a non-technical person works), the disk index's own
 *  prune list, and the temp tree. */
export function isHiddenFolder(name: string, fullPath: string, temporary = tmpdir()): boolean {
  return name.startsWith('.') || shouldPruneDirectory(name) || isExcludedProjectPath(fullPath, '\0', temporary)
}

interface Deps {
  scanRoots: readonly string[]
  home?: string
  temporary?: string
  budgetMs?: number
  /** Test seam: the directory read. */
  list?: (dir: string) => Promise<{ name: string; dir: boolean }[]>
}

async function defaultList(dir: string) {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.map(e => ({ name: e.name, dir: e.isDirectory() }))
}

async function hasSubfolders(dir: string, list: NonNullable<Deps['list']>, temporary: string): Promise<boolean> {
  try {
    return (await list(dir)).some(e => e.dir && !isHiddenFolder(e.name, join(dir, e.name), temporary))
  } catch { return false }
}

export async function listFolders(rawPath: string, deps: Deps): Promise<FolderListing> {
  if (!rawPath || rawPath.includes('\0')) return { ok: false, reason: 'bad-path' }
  const home = deps.home ?? homedir()
  const roots = allowedRoots(deps.scanRoots, home)
  const list = deps.list ?? defaultList
  const temporary = deps.temporary ?? tmpdir()
  const requested = resolve(rawPath)
  if (!isAllowedPath(requested, roots)) return { ok: false, reason: 'forbidden' }
  // Check again on the REAL path: a symlink under the home must not lead out of it.
  let real = requested
  try { real = await realpath(requested) } catch { return { ok: false, reason: 'not-found' } }
  if (!isAllowedPath(real, roots)) return { ok: false, reason: 'forbidden' }

  const budget = deps.budgetMs ?? LISTING_BUDGET_MS
  const deadline = Date.now() + budget
  let partial = false
  const timeout = Symbol('timeout')
  const read = await Promise.race([
    list(real).catch(() => null),
    new Promise<typeof timeout>(r => setTimeout(() => r(timeout), budget)),
  ])
  if (read === timeout) return { ok: true, path: requested, parent: parentOf(requested, roots), folders: [], partial: true }
  if (read === null) return { ok: false, reason: 'not-found' }
  const entries = read

  const dirs = entries
    .filter(e => e.dir && !isHiddenFolder(e.name, join(real, e.name), temporary))
    .sort((a, b) => a.name.localeCompare(b.name))
  const folders: FolderEntry[] = []
  for (const e of dirs) {
    if (Date.now() > deadline) { partial = true; break }
    const path = join(requested, e.name)
    folders.push({ name: e.name, path, hasChildren: await hasSubfolders(join(real, e.name), list, temporary) })
  }
  return { ok: true, path: requested, parent: parentOf(requested, roots), folders, partial }
}

/** The parent to go UP to, or null at the top of an allowed root (back to the disk list). */
function parentOf(path: string, roots: readonly string[]): string | null {
  if (roots.some(r => norm(r) === norm(path))) return null
  const up = dirname(path)
  return up !== path && isAllowedPath(up, roots) ? up : null
}

