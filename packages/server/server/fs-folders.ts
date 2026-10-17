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
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { checkProjectName, type ProjectNameRefusal } from '@agentistics/core'
import { createTreeEntry } from './sessions/editor-fs'
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


export type CreateFolderRefusal = ProjectNameRefusal | 'exists' | 'forbidden' | 'parent-missing' | 'failed'
export type CreateFolderResult =
  | { ok: true; path: string }
  | { ok: false; reason: CreateFolderRefusal; path?: string }

/** The HTTP status a refusal is answered with — one table, so the route and its tests agree. */
export function createFolderStatus(reason: CreateFolderRefusal): number {
  switch (reason) {
    case 'forbidden': return 403
    case 'parent-missing': return 404
    case 'exists': return 409
    case 'failed': return 500
    default: return 400
  }
}

/**
 * Create ONE new project folder, `name` inside `parent` ("Novo projeto" in the new-session wizard).
 *
 * The allowlist that decides what may be BROWSED decides where a folder may be created: `parent`
 * must be absolute and, resolved AND by real path, inside `allowedRoots`. The name is the browser's
 * own rule re-applied (`checkProjectName`), plus the listing's hidden names — a folder the browser
 * would not show back is not one to create. `createParent` creates at most ONE missing level, and
 * only the suggested default (`<home>/projetos` | `<home>/projects`), never an arbitrary chain.
 * `createTreeEntry` does the last mile: containment again, `lstat` before `mkdir` (a dangling
 * symlink at the name is "exists"), and a `mkdir` that is not recursive.
 */
export async function createProjectFolder(
  input: { parent?: unknown; name?: unknown; createParent?: unknown },
  deps: { scanRoots: readonly string[]; home?: string; temporary?: string },
): Promise<CreateFolderResult> {
  const { parent, name: rawName } = input
  if (typeof parent !== 'string' || typeof rawName !== 'string' || parent === '' || parent.includes('\0') || !isAbsolute(parent)) {
    return { ok: false, reason: 'forbidden' }
  }
  const checked = checkProjectName(rawName)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const home = deps.home ?? homedir()
  const temporary = deps.temporary ?? tmpdir()
  const roots = allowedRoots(deps.scanRoots, home)
  const requested = resolve(parent)
  if (!isAllowedPath(requested, roots)) return { ok: false, reason: 'forbidden' }
  const target = join(requested, checked.name)
  if (isHiddenFolder(checked.name, target, temporary)) return { ok: false, reason: 'dot-name' }

  try {
    let real: string
    try {
      real = await realpath(requested)
    } catch {
      const suggested = [join(home, 'projetos'), join(home, 'projects')].some(p => norm(p) === norm(requested))
      if (input.createParent !== true || !suggested) return { ok: false, reason: 'parent-missing' }
      // The suggested default, one level, under a home that must exist: created together with the project.
      try { await lstat(requested) } catch { await mkdir(requested).catch(err => { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }) }
      real = await realpath(requested)
    }
    if (!isAllowedPath(real, roots)) return { ok: false, reason: 'forbidden' }
    const root = roots.filter(r => inside(real, r)).sort((a, b) => b.length - a.length)[0]!
    const made = await createTreeEntry(root, relative(root, join(real, checked.name)), 'dir')
    if (made.ok) return { ok: true, path: target }
    switch (made.reason) {
      case 'already-exists': return { ok: false, reason: 'exists', path: target }
      case 'not-found': case 'not-a-directory': return { ok: false, reason: 'parent-missing' }
      case 'escaped': case 'no-permission': return { ok: false, reason: 'forbidden' }
      case 'name-too-long': return { ok: false, reason: 'too-long' }
    }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
