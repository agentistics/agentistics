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
import { lstat, mkdir, readdir, realpath, rmdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { checkProjectName, type CreateFolderRefusal } from '@agentistics/core'
import { shouldPruneDirectory } from './sessions/dir-scan'
import { isExcludedProjectPath } from './sessions/project-source'

export interface FolderEntry { name: string; path: string; hasChildren: boolean }

export type FolderListing =
  | { ok: true; path: string; parent: string | null; folders: FolderEntry[]; partial: boolean }
  | { ok: false; reason: 'forbidden' | 'not-found' | 'bad-path' }

export const LISTING_BUDGET_MS = 1_500

/** Case is folded ONLY where the file system folds it (Windows, macOS). On Linux `/home/ANA` and
 *  `/home/ana` are two different directories, and folding there let a request for one pass as the other. */
export function foldsCase(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

function norm(p: string, fold = foldsCase()): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return fold ? n.toLowerCase() : n
}

function inside(path: string, root: string, fold = foldsCase()): boolean {
  const a = norm(path, fold)
  const b = norm(root, fold)
  return b === '' ? true : a === b || a.startsWith(`${b}/`)
}

/** The roots a person may browse: the install disk's home plus every enabled disk. */
export function allowedRoots(scanRoots: readonly string[], home = homedir()): string[] {
  return [...new Map([home, ...scanRoots].filter(Boolean).map(r => [norm(r), r])).values()]
}

export function isAllowedPath(path: string, roots: readonly string[], fold = foldsCase()): boolean {
  return roots.some(r => inside(path, r, fold))
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


export type { CreateFolderRefusal }
export type CreateFolderResult =
  | { ok: true; path: string; createdParent?: string }
  | { ok: false; reason: CreateFolderRefusal; path?: string }

/** The HTTP status a refusal is answered with — one table, so the route and its tests agree. */
export function createFolderStatus(reason: CreateFolderRefusal): number {
  switch (reason) {
    case 'forbidden': return 403
    case 'parent-missing': return 404
    case 'exists': case 'exists-other': return 409
    case 'failed': return 500
    default: return 400
  }
}

/** What a successful creation records. */
export interface FolderCreatedEvent { path: string; createdParent?: string }

/**
 * The record of a creation. There is no `AuditAction` for a file-system write yet, and the union is
 * mirrored EQUAL by engine-api's `EngineAuditAction` (engine-api-mirrors.test.ts), so a new action is
 * an engine-api change — out of scope here. It goes to the server log in one greppable line instead.
 * TODO(engine-api): add `fs.folder.create` to `EngineAuditAction` + `AuditAction` and route this
 * through `writeAudit` (which, note, only reaches Mongo — a solo machine has none).
 */
export function logFolderCreated(event: FolderCreatedEvent): void {
  console.info(`[audit] fs.folder.create path=${JSON.stringify(event.path)}${event.createdParent ? ` createdParent=${JSON.stringify(event.createdParent)}` : ''}`)
}

interface CreateDeps {
  scanRoots: readonly string[]
  home?: string
  temporary?: string
  platform?: NodeJS.Platform
  /** Where a creation is recorded. Default: `logFolderCreated`. */
  record?: (event: FolderCreatedEvent) => void
  /** Test seam: runs between the checks and each `mkdir` — the window a swapped parent would use. */
  beforeMkdir?: (path: string) => Promise<void> | void
}

type Kind = 'dir' | 'symlink' | 'other' | 'missing'

async function kindOf(path: string): Promise<Kind> {
  try {
    const st = await lstat(path)
    return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'other'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw err
  }
}

function refusalOf(err: unknown): CreateFolderRefusal {
  switch ((err as NodeJS.ErrnoException).code) {
    case 'ENOENT': case 'ENOTDIR': return 'parent-missing'
    case 'EACCES': case 'EPERM': case 'EROFS': return 'forbidden'
    case 'ENAMETOOLONG': return 'too-long'
    default: return 'failed'
  }
}

/**
 * Make `path` with a NON-recursive `mkdir`, then prove what was made: a real directory (not a
 * symlink) whose real path is inside `realRoot`. If not, the directory just made is removed and the
 * request refused. Node has no `openat`/`mkdirat`, so a check-then-mkdir by path always has a window
 * in which a parent can be swapped for a symlink; this makes the OUTCOME safe by construction instead:
 * whatever the mkdir landed on is verified after the fact and undone when it is outside.
 *
 * RESIDUAL WINDOW (stated, not hidden): between the post-check and the `rmdir`, a second swap could
 * make the `rmdir` remove some other EMPTY directory, or leave the stray one in place. Both need an
 * attacker already able to rewrite directories inside this user's home, and neither writes content.
 */
async function mkdirVerified(path: string, realRoot: string, fold: boolean, beforeMkdir?: CreateDeps['beforeMkdir']): Promise<'ok' | 'exists' | CreateFolderRefusal> {
  await beforeMkdir?.(path)
  try {
    await mkdir(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    return refusalOf(err)
  }
  let real: string | null = null
  try { if (await kindOf(path) === 'dir') real = await realpath(path) } catch { real = null }
  if (real !== null && inside(real, realRoot, fold)) return 'ok'
  try { await rmdir(path) } catch { /* see RESIDUAL WINDOW */ }
  return 'forbidden'
}

/** Every component strictly below `root` down to `path` must be a real directory: a symlink anywhere
 *  in the chain is refused, never followed. Returns the first missing component, if any. */
async function walkChain(root: string, path: string): Promise<{ ok: true; missing: string | null } | { ok: false; reason: CreateFolderRefusal }> {
  const rel = relative(root, path)
  if (rel === '') return { ok: true, missing: null }
  if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: 'forbidden' }
  let at = root
  const parts = rel.split(sep)
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i]!)
    const k = await kindOf(at)
    if (k === 'symlink') return { ok: false, reason: 'forbidden' }
    if (k === 'other') return { ok: false, reason: 'parent-missing' }
    if (k === 'missing') return i === parts.length - 1 ? { ok: true, missing: at } : { ok: false, reason: 'parent-missing' }
  }
  return { ok: true, missing: null }
}

/**
 * Create ONE new project folder, `name` inside `parent` ("Novo projeto" in the new-session wizard).
 *
 * The allowlist that decides what may be BROWSED decides where a folder may be created. Every check
 * runs BEFORE any write: `parent` absolute and inside an allowed root (case-sensitive except on
 * Windows/macOS), every path component between that root and `parent` a real directory (no symlink
 * followed), and the name the browser's own rule (`checkProjectName`) plus the listing's hidden
 * names. `createParent` creates at most ONE missing level and only the exact default
 * (`<home>/projetos` | `<home>/projects`). Each `mkdir` is then verified after the fact
 * (`mkdirVerified`) — that is what closes a parent swapped for a symlink between check and write.
 *
 * "Use the folder that already exists" is only ever offered (`exists` + `path`) for a REAL directory
 * whose real path is inside the roots; a file, a symlink or anything else is `exists-other`.
 */
export async function createProjectFolder(
  input: { parent?: unknown; name?: unknown; createParent?: unknown },
  deps: CreateDeps,
): Promise<CreateFolderResult> {
  const { parent, name: rawName } = input
  if (typeof parent !== 'string' || typeof rawName !== 'string' || parent === '' || parent.includes('\0') || !isAbsolute(parent)) {
    return { ok: false, reason: 'forbidden' }
  }
  const checked = checkProjectName(rawName)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const fold = foldsCase(deps.platform)
  const home = resolve(deps.home ?? homedir())
  const temporary = deps.temporary ?? tmpdir()
  const roots = allowedRoots(deps.scanRoots, home).map(r => resolve(r))
  const requested = resolve(parent)
  if (!isAllowedPath(requested, roots, fold)) return { ok: false, reason: 'forbidden' }
  const target = join(requested, checked.name)
  if (isHiddenFolder(checked.name, target, temporary)) return { ok: false, reason: 'dot-name' }
  // The deepest root holding the request lexically; containment is then proven against ITS real path.
  const root = roots.filter(r => inside(requested, r, fold)).sort((a, b) => b.length - a.length)[0]!

  try {
    let realRoot: string
    try { realRoot = await realpath(root) } catch { return { ok: false, reason: 'parent-missing' } }
    const realRoots = (await Promise.all(roots.map(r => realpath(r).catch(() => null)))).filter((r): r is string => r !== null)

    const chain = await walkChain(root, requested)
    if (!chain.ok) return { ok: false, reason: chain.reason }
    let createdParent: string | undefined
    if (chain.missing !== null) {
      // Exactly `<home>/projetos|projects`, compared EXACTLY (no case folding), one level, under the real home.
      const suggested = [join(home, 'projetos'), join(home, 'projects')].includes(requested)
      if (input.createParent !== true || !suggested || root !== home) return { ok: false, reason: 'parent-missing' }
      const made = await mkdirVerified(requested, realRoot, fold, deps.beforeMkdir)
      if (made === 'ok') createdParent = requested
      else if (made !== 'exists') return { ok: false, reason: made }
      // A racing creator made it first: re-prove the chain before using it.
      if (made === 'exists') {
        const again = await walkChain(root, requested)
        if (!again.ok || again.missing !== null) return { ok: false, reason: again.ok ? 'parent-missing' : again.reason }
      }
    }

    const existing = await kindOf(target)
    if (existing !== 'missing') return await existingRefusal(target, existing, realRoots, fold)
    const made = await mkdirVerified(target, realRoot, fold, deps.beforeMkdir)
    if (made === 'exists') return await existingRefusal(target, await kindOf(target), realRoots, fold)
    if (made !== 'ok') return { ok: false, reason: made }
    ;(deps.record ?? logFolderCreated)({ path: target, ...(createdParent ? { createdParent } : {}) })
    return { ok: true, path: target, ...(createdParent ? { createdParent } : {}) }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

async function existingRefusal(target: string, kind: Kind, realRoots: readonly string[], fold: boolean): Promise<CreateFolderResult> {
  if (kind === 'dir') {
    const real = await realpath(target).catch(() => null)
    if (real !== null && isAllowedPath(real, realRoots, fold)) return { ok: false, reason: 'exists', path: target }
  }
  return { ok: false, reason: 'exists-other' }
}
