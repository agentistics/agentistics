/**
 * editor-fs.ts — the IO around the repository explorer's PURE decisions.
 *
 * `resolveSessionDirectory` gathers the facts `editor-directory.ts`'s `planSessionDirectory`
 * needs (a live fleet row, a store record, a `stat`) and decides through it. Every other function
 * here takes an already-RESOLVED root directory and a client-given relative path, and re-checks
 * containment on the REAL (symlink-resolved) path before touching anything — `editor-path.ts`'s
 * `resolveTreePath` only catches a LEXICAL `..` escape; this is the other half, the one that
 * catches a symlink INSIDE the tree pointing outside it.
 */
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { StartHost } from '../cli-start'
import { gitEnv } from '../backup/repo-probe'
import { planSessionDirectory, type SessionDirPlan } from './editor-directory'
import { resolveTreePath } from './editor-path'
import { realContained } from './real-contained'
import { childrenFromDirents, collapseToChildren, mergeEmptyDirs, type TreeChild } from './editor-list'
import { looksBinary } from './artifact-web'
import { decodeUtf8Lossless } from './editor-text'
import type { MediaKind } from './artifact-media'
import { planMediaView } from './editor-media'
import { planFileWrite } from './editor-conflict'
import {
  capHits, decideGitGrepOutcome, matchNames, parseGrepOutput, SEARCH_LIMIT,
  type ContentHit, type SearchResult,
} from './editor-search'

async function pathIsDirectory(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory() } catch { return false }
}

export async function resolveSessionDirectory(host: StartHost, id: string): Promise<SessionDirPlan> {
  let sessionKnown = false
  let liveCwd: string | undefined
  if (host.sessions) {
    const fleet = await host.sessions()
    const row = fleet.sessions.find(r => r.id === id || r.conversationId === id)
    if (row) {
      sessionKnown = true
      liveCwd = row.cwd || undefined
    }
  }
  let storeDir: string | undefined
  if (!liveCwd) {
    // Dynamic: this branch only runs when the session has no live cwd, so the common (live)
    // path never pays for loading the consolidate store. Verified there is no require-cycle to
    // avoid here — `../consolidate` and everything it imports (`./config`, `./utils`) never
    // reach back into `../cli-start` or this module, static or dynamic.
    const { loadConsolidated } = await import('../consolidate')
    const map = await loadConsolidated()
    const meta = map.get(id)
    if (meta) {
      sessionKnown = true
      storeDir = meta.current_cwd || meta.project_path || undefined
    }
  }
  const dir = liveCwd || storeDir
  const dirExists = dir ? await pathIsDirectory(dir) : false
  return planSessionDirectory({ sessionKnown, liveCwd, storeDir, dirExists })
}

/**
 * Everything this module's write/create/rename/delete/list/search functions can refuse with,
 * beyond a directory-resolution failure (which the caller in `editor-web.ts` handles separately,
 * before ever reaching here).
 */
export type EntryRefusal = 'escaped' | 'not-found' | 'not-a-directory'

export type ListPlan =
  | { ok: true; children: TreeChild[] }
  | { ok: false; reason: EntryRefusal }

export async function listChildren(root: string, requestedPath: string): Promise<ListPlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }

  const real = await realContained(root, planned.abs)
  if (real === null) {
    // Either it does not exist, or it escaped via a symlink. Either way there is nothing to list.
    try {
      await stat(planned.abs)
    } catch {
      return { ok: false, reason: 'not-found' }
    }
    return { ok: false, reason: 'escaped' }
  }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (!st.isDirectory()) return { ok: false, reason: 'not-a-directory' }

  const realRoot = await realpath(root)
  const relDir = real === realRoot ? '' : real.slice(realRoot.length + 1)

  const git = await gitListRecursive(realRoot, relDir)
  if (git !== null) {
    const children = collapseToChildren(git)
    // `git ls-files` — recursive or `--directory`-collapsed, see `gitUntrackedEmptyDirs`'s own
    // header — can only ever name a FILE, tracked or untracked. An empty directory holds no file
    // at all, so no form of it is ever going to produce one; this is the other half, added on top
    // rather than folded into `gitListRecursive` because it answers a different question (what
    // directories exist here) through a different mechanism (readdir + check-ignore, not
    // ls-files) and only for directories git's own listing did not already account for.
    const known = new Set(children.filter(c => c.kind === 'dir').map(c => c.name))
    const emptyDirs = await gitUntrackedEmptyDirs(realRoot, relDir, known)
    return { ok: true, children: mergeEmptyDirs(children, emptyDirs) }
  }

  const entries = await readdir(real, { withFileTypes: true })
  return { ok: true, children: childrenFromDirents(entries) }
}

/**
 * The untracked, EMPTY directories directly under `relDir` (already-known dirs excluded) — the
 * one thing no shape of `git ls-files` can ever produce, because it only ever names files. Two
 * candidates were weighed:
 *
 * 1. A second `git ls-files --others --exclude-standard --directory -- <pathspec>` call. Its
 *    `--directory` flag DOES print a trailing-slash entry for a genuinely empty directory (
 *    verified: an empty dir with no files at all, tracked or untracked, still comes back as
 *    `name/`) — but only up to the point where an ENTIRE pathspec-rooted subtree is untracked. In
 *    that case git collapses the WHOLE subtree to the pathspec itself (`git ls-files --directory
 *    -- deep` on `deep/a/b/c`, all empty, answers just `deep/` — not `deep/a/`), which is exactly
 *    self-referential when `relDir` IS that pathspec: after stripping the `relDir/` prefix the
 *    entry is the empty string, and the one level of nesting one directory below `relDir` is lost
 *    with it. That failure mode is silent (an empty result reads as "no children" rather than as
 *    a refusal), which rules it out here.
 * 2. `readdir` of the directory being listed, for its child DIRECTORIES only, filtered through
 *    `git check-ignore --stdin`. This is what runs: it asks git for the one thing `ls-files` is
 *    structurally unable to answer (does a name that names no file even exist), and defers to git
 *    for the one thing this module must never reimplement (is it ignored) — never both from the
 *    same call, and never a guess at `.gitignore`'s own semantics. Bounded to one `readdir` (one
 *    directory level, matching the "one directory per tree-expand" contract everywhere else in
 *    this module) plus one batched `check-ignore`, and that second call runs at all only when
 *    `readdir` actually turned up a directory git's own listing did not already name.
 */
async function gitUntrackedEmptyDirs(
  root: string, relDir: string, known: ReadonlySet<string>,
): Promise<string[]> {
  const dirAbs = relDir === '' ? root : `${root}/${relDir}`
  let entries
  try {
    entries = await readdir(dirAbs, { withFileTypes: true })
  } catch {
    return []
  }
  // `.isDirectory()` on a `Dirent` from a non-`follow`ing `readdir` is false for a symlink even
  // when it points at a directory — so a symlink is left exactly as every other function in this
  // module already treats it (a plain entry, never expanded), with no extra check needed here.
  // `.git` is excluded unconditionally: a repository's own control directory is never a row in
  // this tree, at the root or (a nested repo/submodule) anywhere else.
  const candidates = entries
    .filter(e => e.isDirectory() && e.name !== '.git' && !known.has(e.name))
    .map(e => e.name)
  if (candidates.length === 0) return []

  const pathspecs = candidates.map(name => (relDir === '' ? name : `${relDir}/${name}`))
  const ignored = await gitCheckIgnore(root, pathspecs)
  // `null` means the check itself could not answer (git failed to run at all) — degrade to
  // reporting no new directories rather than guessing either way; a directory that stays hidden
  // for one more request is a smaller fault than one shown despite `.gitignore` naming it.
  if (ignored === null) return []
  return candidates.filter((_, i) => !ignored.has(pathspecs[i]!))
}

/**
 * One batched `git check-ignore --stdin` call for every candidate path at once, rather than one
 * process per directory — `--stdin` echoes back exactly the paths (one per line) that ARE
 * ignored, so "not in the returned set" is the answer for everything else, including a path that
 * does not exist at all (which `check-ignore` treats the same as "not ignored", never an error).
 * Exit code 1 means "ran fine, nothing here is ignored" (matching `decideGitGrepOutcome`'s own
 * reading of `git grep`'s exit codes) and is not a failure; only a `null` return is.
 */
async function gitCheckIgnore(root: string, paths: string[]): Promise<Set<string> | null> {
  try {
    const p = Bun.spawn(['git', '-C', root, 'check-ignore', '--stdin'], {
      stdout: 'pipe', stderr: 'pipe', stdin: 'pipe', env: gitEnv(),
    })
    p.stdin.write(`${paths.join('\n')}\n`)
    p.stdin.end()
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    if (code !== 0 && code !== 1) return null
    return new Set(out.split('\n').filter(Boolean))
  } catch {
    return null
  }
}

/**
 * The recursive, gitignore-aware file list under `relDir` (relative to `root`), with paths
 * returned relative to `relDir` itself. `null` when `root` is not a git work tree at all (the
 * command's own exit code says so — no separate "is this a repo" probe is needed).
 *
 * PHANTOM ROWS: the Studio's rename/delete act with a raw `fs.rename`/`rm`, never `git mv`/`git
 * rm` — so a git-TRACKED path can vanish or move on disk while the INDEX still names the old
 * one. `--cached` answers from the index regardless of what disk has, so an entry gone from disk
 * kept appearing (a file under its old name; a whole directory, once every tracked descendant
 * that used to justify `collapseToChildren` producing it was itself gone). `--others
 * --exclude-standard` is never the problem half — it lists the working tree's own untracked,
 * non-ignored files, which by definition exist.
 *
 * Fixed by subtracting `git ls-files --deleted` (index paths git can see are missing from the
 * worktree) from the `--cached` half, before `collapseToChildren` ever runs. Chosen over an
 * `lstat` per collapsed child — the other candidate — because it is exact at EVERY depth under
 * `relDir` in one pass (a deleted folder's directory row disappears here for the same reason its
 * files do, with nothing extra to reason about), it costs one more `git` call bounded by the
 * same pathspec rather than N filesystem syscalls sized to how many children the level happens to
 * have, and it needs no filesystem access at all beyond what `git` already does internally. A
 * `--deleted` call that itself fails is treated as "nothing known to be deleted" — the listing
 * degrades to exactly its old (buggy) behaviour rather than refusing the whole directory.
 */
async function gitListRecursive(root: string, relDir: string): Promise<string[] | null> {
  const pathspec = relDir === '' ? '.' : relDir
  const [res, deletedRes] = await Promise.all([
    runGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--', pathspec]),
    runGit(root, ['ls-files', '--deleted', '--', pathspec]),
  ])
  if (!res.ok) return null
  const deleted = deletedRes.ok ? new Set(deletedRes.out.split('\n').filter(Boolean)) : null
  const prefix = relDir === '' ? '' : `${relDir}/`
  return res.out.split('\n').filter(Boolean)
    .filter(p => !deleted?.has(p))
    .map(p => (p.startsWith(prefix) ? p.slice(prefix.length) : p))
}

/**
 * `-C <cwd>` does NOT override `GIT_DIR` for repository discovery — an ambient `GIT_DIR` /
 * `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_PREFIX` / `GIT_COMMON_DIR` (exactly what this repo's
 * own pre-commit hook exports while running from a linked worktree, and what any parent process
 * spawning the server could equally set) silently redirects `git -C <cwd> ls-files` onto whatever
 * repository those variables name instead of `cwd` — measured here: without stripping them, this
 * module listed the OUTER checkout's files for a request scoped to an unrelated temp directory.
 * Reuses `backup/repo-probe.ts`'s own `gitEnv()` rather than reimplementing the strip — same rule,
 * same variable set, one place to keep it right.
 */

/**
 * One `git` runner for this whole module — mirrors `shell-web.ts`'s own `tmux()` helper.
 * `code` is the real exit code; a spawn that threw before git ever ran (the binary missing, a
 * permission error) has no exit code of its own and is given the sentinel `-1`, which must read
 * the same as any other non-0/non-1 failure to a caller deciding whether to fall back.
 */
async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; code: number }> {
  try {
    const p = Bun.spawn(['git', '-C', cwd, ...args], {
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: gitEnv(),
    })
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    return { ok: code === 0, out, code }
  } catch {
    return { ok: false, out: '', code: -1 }
  }
}

export type ReadFileRefusal = EntryRefusal | 'not-a-file'

/**
 * A file whose bytes are not valid UTF-8 — Latin-1, cp1252, UTF-16 without a NUL in its first
 * chunk. Refused by BOTH the read and the write, see `editor-text.ts`.
 *
 * NOT READABLE EITHER, and that is a decision rather than an omission. The only text this module
 * could send is a lossy one, with U+FFFD where the undecodable bytes are: a picture of a file that
 * is not the file, offered in the same pane that edits files. A read-only variant would be a second
 * editor mode the client has to honour everywhere a buffer can be saved from (autosave, the
 * conflict's "keep mine", a hidden tab), and a refusal is the one answer that cannot be saved back.
 */
export type TextRefusal = 'not-utf8'

/**
 * The binary variant's two media fields, and why they are two rather than one.
 *
 * `media` is set ONLY when the Studio will render the file, and is the kind it will render it as.
 * `mediaOverLimit` is set only when the file IS one of those kinds and is over that kind's ceiling,
 * and carries the ceiling it hit — so the pane can say which limit refused it instead of falling
 * back to the generic "binary file" sentence. Both absent is an ordinary binary (a `.zip`, a
 * compiled binary), for which that sentence is exactly right.
 *
 * The decision is the server's, made once in `planMediaView`, and the client re-derives none of it:
 * a ceiling the browser applied would be a second copy of a number this module owns.
 */
export type ReadFilePlan =
  | { ok: true; content: string; mtimeMs: number; binary?: false }
  | {
    ok: true; binary: true; name: string; size: number
    media?: MediaKind
    mediaOverLimit?: { media: MediaKind; limit: number }
  }
  | { ok: false; reason: ReadFileRefusal | TextRefusal }

export async function readTreeFile(root: string, requestedPath: string): Promise<ReadFilePlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }
  const real = await realContained(root, planned.abs)
  if (real === null) return { ok: false, reason: 'not-found' }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' }

  const name = real.split('/').pop() ?? real
  // MEDIA IS DECIDED BEFORE THE BYTES ARE READ, and that ordering is the point. `looksBinary` needs
  // the file in memory, and this feature is what makes a half-gigabyte video reachable through this
  // route — reading one whole just to learn it is not text is the cost the extension already answers.
  // A file whose extension is on the closed table is never read here at all.
  const view = planMediaView(real, st.size)
  if (view.kind === 'render') return { ok: true, binary: true, name, size: st.size, media: view.media }
  if (view.kind === 'too-big') {
    return {
      ok: true, binary: true, name, size: st.size,
      mediaOverLimit: { media: view.media, limit: view.limit },
    }
  }

  const buf = await readFile(real)
  if (looksBinary(buf)) {
    return { ok: true, binary: true, name, size: st.size }
  }
  const content = decodeUtf8Lossless(buf)
  if (content === null) return { ok: false, reason: 'not-utf8' }
  return { ok: true, content, mtimeMs: st.mtimeMs }
}

export type ReadMediaRefusal = ReadFileRefusal | 'not-media' | 'too-big'

export type ReadMediaPlan =
  | { ok: true; real: string; name: string; size: number; mime: string; media: MediaKind }
  | { ok: false; reason: ReadMediaRefusal; limit?: number }

/**
 * The file to SERVE, resolved through both containment halves exactly like every other function
 * here — `resolveTreePath`'s lexical check AND `realContained`'s symlink recheck, never one without
 * the other. It returns the real PATH and not the bytes: the route streams the file rather than
 * buffering it, which is the whole reason a 512 MB ceiling is tenable at all.
 *
 * The ceiling is re-applied here and not taken on trust from the read that preceded it. The two
 * calls are seconds apart and the file can grow between them, and more to the point a client can
 * simply ask — a limit enforced only where the number happens to have been reported is not a limit.
 */
export async function readTreeMedia(root: string, requestedPath: string): Promise<ReadMediaPlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }
  const real = await realContained(root, planned.abs)
  if (real === null) return { ok: false, reason: 'not-found' }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' }

  const view = planMediaView(real, st.size)
  if (view.kind === 'not-media') return { ok: false, reason: 'not-media' }
  if (view.kind === 'too-big') return { ok: false, reason: 'too-big', limit: view.limit }
  return {
    ok: true, real, name: real.split('/').pop() ?? real, size: st.size,
    mime: view.mime, media: view.media,
  }
}

export type WriteFileRefusal = EntryRefusal | 'not-a-file' | TextRefusal

export type WriteFilePlan =
  | { ok: true; mtimeMs: number }
  | { ok: false; reason: 'conflict'; content: string; mtimeMs: number }
  | { ok: false; reason: WriteFileRefusal }

export async function writeTreeFile(
  root: string, requestedPath: string, content: string, expectedMtimeMs: number,
): Promise<WriteFilePlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }
  const real = await realContained(root, planned.abs)
  if (real === null) return { ok: false, reason: 'not-found' }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  if (!st.isFile()) return { ok: false, reason: 'not-a-file' }

  // THE BYTES ON DISK ARE CHECKED BEFORE EITHER ANSWER, not only on the read. The read refusing a
  // non-UTF-8 file is what keeps the Studio from offering a Save; this is what makes the write itself
  // safe — against a client that asks this route directly, and against a file that was valid UTF-8
  // when it was opened and was rewritten in another encoding since (that one is also a conflict, and
  // a conflict's "current content" decoded lossily is exactly the text a "keep theirs" would save).
  const disk = await readFile(real)
  const diskText = decodeUtf8Lossless(disk)
  if (diskText === null) return { ok: false, reason: 'not-utf8' }

  const plan = planFileWrite({ expectedMtimeMs, diskMtimeMs: st.mtimeMs })
  if (!plan.ok) {
    // The write is refused BEFORE it happens. What comes back is the CURRENT disk content, read
    // fresh — the caller's editor shows it, and nothing here has touched the file.
    return { ok: false, reason: 'conflict', content: diskText, mtimeMs: plan.diskMtimeMs }
  }

  await writeFile(real, content, 'utf8')
  const after = await stat(real)
  return { ok: true, mtimeMs: after.mtimeMs }
}

/**
 * A CREATE target has no real path of its own yet — `realContained` alone cannot check it, because
 * `realpath` throws on something that does not exist. So the PARENT is checked instead: it must
 * exist, be a real directory, and be contained in the real root. This is the one place in this
 * module where "does not exist yet" is the SUCCESS case rather than a refusal.
 */
async function realContainedParent(root: string, abs: string): Promise<string | null> {
  const parent = dirname(abs)
  const realParent = await realContained(root, parent)
  if (realParent === null) return null
  // Recompose with the (still unresolved) basename — the child itself is not real yet.
  return `${realParent}/${abs.slice(parent.length + 1)}`
}

export type CreateRefusal =
  'escaped' | 'not-found' | 'already-exists' | 'not-a-directory' | 'name-too-long' | 'no-permission'
export type CreatePlan = { ok: true } | { ok: false; reason: CreateRefusal }

export async function createTreeEntry(
  root: string, requestedPath: string, kind: 'file' | 'dir',
): Promise<CreatePlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }
  const target = await realContainedParent(root, planned.abs)
  if (target === null) return { ok: false, reason: 'not-found' }

  try {
    // `lstat`, not `stat`: a DANGLING symlink at this name answers "nothing there" to `stat`, and
    // `writeFile` would then follow it and create its target — which can be anywhere on the machine.
    await lstat(target)
    return { ok: false, reason: 'already-exists' }
  } catch {
    // Good — it must not exist yet.
  }

  try {
    // `wx`: the name was free a moment ago, and a file that appears in between is not overwritten.
    if (kind === 'dir') await mkdir(target)
    else await writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
  } catch (err) {
    const reason = fsRefusal(err)
    if (
      reason === 'already-exists' || reason === 'not-found' || reason === 'not-a-directory'
      || reason === 'name-too-long' || reason === 'no-permission'
    ) return { ok: false, reason }
    throw err
  }
  return { ok: true }
}

/**
 * The filesystem's own refusal, as one of this module's codes — or `null`, and the caller rethrows.
 *
 * The checks above run BEFORE the call, so the call can still refuse on its own: a folder moved into
 * its own descendant (EINVAL — including through a symlink, which no lexical check can see), a path
 * whose middle segment is a FILE (ENOTDIR), something created at the name in between (EEXIST). Those
 * used to escape as a thrown `Error` whose message carries the ABSOLUTE host path, straight out of a
 * route with no catch. Only codes with a true sentence are mapped; anything else stays an exception.
 *
 * ENAMETOOLONG and EACCES joined the table for the same reason: an entry name over the filesystem's
 * limit, or a folder this process may not write to, are ORDINARY user mistakes — a name pasted from
 * somewhere else, a repository checked out read-only — and both used to fall through to the generic
 * 500 every other mapped code here was added to avoid.
 */
function fsRefusal(
  err: unknown,
): 'into-itself' | 'not-a-directory' | 'already-exists' | 'not-found' | 'not-empty' | 'name-too-long' | 'no-permission' | null {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'EINVAL') return 'into-itself'
  if (code === 'ENOTDIR') return 'not-a-directory'
  if (code === 'EEXIST') return 'already-exists'
  if (code === 'ENOENT') return 'not-found'
  if (code === 'ENOTEMPTY') return 'not-empty'
  if (code === 'ENAMETOOLONG') return 'name-too-long'
  if (code === 'EACCES') return 'no-permission'
  return null
}

/**
 * THE ENTRY A MUTATION ACTS ON — the name in its folder, never what a symlink at that name points to.
 *
 * Rename and delete used to resolve the entry with `realContained`, which is `realpath` of the ENTRY
 * itself: right for a READ (the bytes you see are the target's) and wrong for a MUTATION. With
 * `CLAUDE.md -> AGENTS.md`, deleting `CLAUDE.md` deleted `AGENTS.md` and left a dangling link, while
 * the confirmation had named `CLAUDE.md`; renaming it renamed `AGENTS.md`. So only the PARENT is
 * resolved (it must really live inside the tree — that is the containment rule), the basename is kept
 * as written, and existence is `lstat`, which answers for the link and not for its target. `rename`
 * and `rm` both act on a link without following it, so the link is what moves or goes.
 *
 * `null` for a path whose parent escapes or does not exist, and for a name with nothing there.
 */
async function entryContained(root: string, abs: string): Promise<string | null> {
  const entry = await realContainedParent(root, abs)
  if (entry === null) return null
  try {
    await lstat(entry)
    return entry
  } catch {
    return null
  }
}

/**
 * `''`, `.`, `sub/..` — anything that normalises to the session folder ITSELF. A mutation of the root
 * is never something the tree asks for (the root is not a row), and `DELETE path=. recursive=1` used
 * to answer 200 and remove the whole session folder. Refused by name rather than falling through to
 * whatever the parent check happens to say, so the sentence is true.
 */
function namesRoot(root: string, abs: string): boolean {
  return resolve(abs) === resolve(root)
}

export type RenameRefusal =
  | 'escaped' | 'not-found' | 'already-exists' | 'is-root' | 'into-itself' | 'not-a-directory'
  | 'name-too-long' | 'no-permission'
export type RenamePlan = { ok: true } | { ok: false; reason: RenameRefusal }

export async function renameTreeEntry(root: string, fromPath: string, toPath: string): Promise<RenamePlan> {
  const from = resolveTreePath(root, fromPath)
  if (!from.ok) return { ok: false, reason: 'escaped' }
  const to = resolveTreePath(root, toPath)
  if (!to.ok) return { ok: false, reason: 'escaped' }
  if (namesRoot(root, from.abs) || namesRoot(root, to.abs)) return { ok: false, reason: 'is-root' }

  const realFrom = await entryContained(root, from.abs)
  if (realFrom === null) return { ok: false, reason: 'not-found' }

  // `realContainedParent` collapses two different facts into one `null`: the destination's parent
  // does not exist AT ALL, or it exists but escapes containment (a symlink route out of the tree).
  // A move into a folder nobody made yet is an everyday mistake and reads as `escaped` before this
  // check — a sentence about the wrong thing. Re-checking the parent LEXICALLY first (no realpath,
  // no symlink-following) tells the two apart: only a parent that genuinely is not there answers
  // `not-found`; one that exists but fails the REAL containment check keeps `escaped`.
  const toParentExists = await lstat(dirname(to.abs)).then(() => true, () => false)
  if (!toParentExists) return { ok: false, reason: 'not-found' }

  const realToTarget = await realContainedParent(root, to.abs)
  if (realToTarget === null) return { ok: false, reason: 'escaped' }

  try {
    // `lstat`: a dangling symlink already sitting at the destination is still something there.
    await lstat(realToTarget)
    return { ok: false, reason: 'already-exists' }
  } catch {
    // Good — the destination must be free.
  }

  try {
    await rename(realFrom, realToTarget)
  } catch (err) {
    const reason = fsRefusal(err)
    if (reason === 'not-empty') return { ok: false, reason: 'already-exists' }
    if (reason) return { ok: false, reason }
    throw err
  }
  return { ok: true }
}

export type DeleteRefusal = 'escaped' | 'not-found' | 'not-empty' | 'is-root' | 'name-too-long' | 'no-permission'
export type DeletePlan = { ok: true } | { ok: false; reason: DeleteRefusal }

export async function deleteTreeEntry(
  root: string, requestedPath: string, recursive: boolean,
  // Injectable for tests only — the same seam `chat-web.ts`'s `readerFor` uses. `rm`'s own recursive
  // walk throwing ENOENT/ENOTEMPTY for a CHILD a concurrent actor touched, while the entry itself is
  // still right here, cannot be reproduced on a real filesystem without a genuine race; without this
  // seam that branch would go untested the same way chat-web.ts's own comment describes.
  rmFn: typeof rm = rm,
): Promise<DeletePlan> {
  const planned = resolveTreePath(root, requestedPath)
  if (!planned.ok) return { ok: false, reason: 'escaped' }
  if (namesRoot(root, planned.abs)) return { ok: false, reason: 'is-root' }
  const real = await entryContained(root, planned.abs)
  if (real === null) return { ok: false, reason: 'not-found' }

  let st
  try {
    // `lstat`, so a link to a folder is a LINK here: it is removed as one entry and its target's
    // contents are neither listed for the not-empty check nor touched.
    st = await lstat(real)
  } catch {
    return { ok: false, reason: 'not-found' }
  }

  if (st.isDirectory() && !recursive) {
    const entries = await readdir(real)
    if (entries.length > 0) return { ok: false, reason: 'not-empty' }
  }

  try {
    await rmFn(real, { recursive: true, force: false })
  } catch (err) {
    const reason = fsRefusal(err)
    if (reason === 'not-found' || reason === 'not-empty') {
      // `rm`'s own internal walk can throw either code for a CHILD a CONCURRENT actor touched —
      // removed one (ENOENT) or added one (ENOTEMPTY) — even though the entry we were asked to
      // delete is still right here, just shrinking or growing under us. Trusting the syscall's own
      // reading answered `not-found` for a folder that plainly existed; re-checking against the
      // entry itself is what tells "gone" apart from "still there, just raced with".
      const stillThere = await lstat(real).then(() => true, () => false)
      return { ok: false, reason: stillThere ? 'not-empty' : 'not-found' }
    }
    if (reason === 'name-too-long' || reason === 'no-permission') return { ok: false, reason }
    throw err
  }
  return { ok: true }
}

export type { SearchResult }

/**
 * Filename matches always run (fast, no process). Content matches run through `git grep` in a git
 * repo; a NON-git directory gets a bounded plain walk instead — capped by FILE COUNT, not depth,
 * so a huge `node_modules`-shaped folder with no git repo behind it cannot make this hang, which
 * is the exact risk the spec calls out.
 *
 * `overrides` exists ONLY for tests — it lets the walk's file/dir caps and the grep's own hit cap
 * be driven down to a handful of fixtures instead of needing PLAIN_WALK_FILE_LIMIT (5000) real
 * files or SEARCH_LIMIT (200) real hits on disk to reproduce a boundary. Every production caller
 * takes the module defaults.
 *
 * `truncated` is not only `capHits`' own verdict on the COMBINED, already-gathered hit list — the
 * walk and the grep can each stop early for a reason `capHits` never sees (a walk cap cutting the
 * file list handed to name-matching and to the plain grep, a file skipped for its size, or the
 * grep's own hit-cap `break` landing exactly on the limit with nothing left over for `capHits` to
 * cut). Any one of those means the scan did not cover the whole tree, so the result is partial
 * regardless of what the final hit count happens to be.
 */
export async function searchTree(
  root: string, q: string,
  overrides: { fileLimit?: number; dirLimit?: number; grepLimit?: number } = {},
): Promise<SearchResult> {
  const query = q.trim()
  if (!query) return { hits: [], truncated: false }

  const files = await gitListRecursive(root, '')
  // The git path must never walk: `walkPlain` only runs when `root` is not a git work tree at
  // all. Walking once here and handing the SAME list to both the name match and (on fallback,
  // below) the content grep is what fixes the double-walk this search used to do.
  const walk = files === null ? await walkPlain(root, overrides) : null
  const walked = walk?.files
  const nameHits = matchNames(files ?? walked!, query)

  let contentHits: ContentHit[]
  let grepTruncated = false
  if (files !== null) {
    const gitHits = await gitGrepContent(root, query)
    // `null` means `git grep` itself failed for a real reason (not "no matches") — fall back to
    // a plain read of the very file list `git ls-files` already gave us, no second walk needed.
    if (gitHits !== null) {
      contentHits = gitHits
    } else {
      const grep = await grepPlain(root, files, query, overrides.grepLimit)
      contentHits = grep.hits
      grepTruncated = grep.truncated
    }
  } else {
    const grep = await grepPlain(root, walked!, query, overrides.grepLimit)
    contentHits = grep.hits
    grepTruncated = grep.truncated
  }

  const capped = capHits([...nameHits, ...contentHits])
  return { hits: capped.hits, truncated: capped.truncated || (walk?.truncated ?? false) || grepTruncated }
}

/**
 * `null` signals the caller must fall back to a plain content read — see `decideGitGrepOutcome`
 * for the exit-code reasoning. Exit 1 ("ran fine, found nothing") is answered with `[]` directly,
 * never treated as a fallback case.
 */
async function gitGrepContent(root: string, query: string): Promise<ContentHit[] | null> {
  const res = await runGit(root, ['grep', '-n', '--untracked', '-I', '-e', query, '--', '.'])
  const outcome = decideGitGrepOutcome(res.code)
  if (outcome === 'none') return []
  if (outcome === 'fallback') return null
  return parseGrepOutput(res.out)
}

/** Bounded so a directory with no `.gitignore` to lean on cannot make search feel like it hangs. */
const PLAIN_WALK_FILE_LIMIT = 5000
/**
 * Independent of the file cap above: `out.length` only grows when a FILE is pushed, so a tree of
 * thousands of nested near-empty subdirectories would never trip `PLAIN_WALK_FILE_LIMIT` and
 * `readdir` would run once per directory forever — exactly the hang this search must never
 * produce. Same magnitude as the file cap, for the identical reason.
 */
const PLAIN_WALK_DIR_LIMIT = 5000

export interface WalkResult {
  files: string[]
  /** Either cap actually stopped the walk before every reachable file was seen. */
  truncated: boolean
}

/**
 * Exported, and the caps are overridable, only so tests can prove the directory cap terminates
 * the walk without needing to build thousands of real directories on disk — every production
 * caller relies on the two module-level defaults above.
 */
export async function walkPlain(
  root: string,
  limits: { fileLimit?: number; dirLimit?: number } = {},
): Promise<WalkResult> {
  const fileLimit = limits.fileLimit ?? PLAIN_WALK_FILE_LIMIT
  const dirLimit = limits.dirLimit ?? PLAIN_WALK_DIR_LIMIT
  const out: string[] = []
  const stack = ['']
  let dirsVisited = 0
  let cutOff = false
  while (stack.length > 0 && out.length < fileLimit && dirsVisited < dirLimit) {
    const rel = stack.pop()!
    const abs = rel === '' ? root : `${root}/${rel}`
    dirsVisited++
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) stack.push(childRel)
      else out.push(childRel)
      if (out.length >= fileLimit) { cutOff = true; break }
    }
  }
  // `stack.length > 0` after the loop is the DIRECTORY cap's own signature: there was more to
  // visit and the walk stopped anyway. `cutOff` catches the FILE cap even in the rare case where
  // hitting it also happened to leave the stack empty — either way, something reachable from here
  // was never looked at.
  return { files: out, truncated: cutOff || stack.length > 0 }
}

/**
 * A file above this size is skipped BEFORE it is ever read whole into memory — the same "search
 * must never hang or exhaust memory" guarantee the walk's own caps exist for, applied to one huge
 * file rather than a huge tree. 1 MiB comfortably covers any real source file while refusing a
 * stray multi-megabyte log or data dump sitting in a directory with no git index to exclude it.
 * A `stat` that throws skips the file too, the same posture the existing `readFile` catch takes.
 */
const GREP_MAX_FILE_BYTES = 1024 * 1024

interface GrepPlainResult {
  hits: ContentHit[]
  /** A file was skipped for its size, or the hit cap ended the scan before every file was read. */
  truncated: boolean
}

/**
 * `limit` defaults to `SEARCH_LIMIT` and is overridable ONLY for tests — see `searchTree`'s own
 * `overrides` doc. Every production caller takes the module default.
 */
async function grepPlain(
  root: string, files: readonly string[], query: string, limit: number = SEARCH_LIMIT,
): Promise<GrepPlainResult> {
  const needle = query.toLowerCase()
  const hits: ContentHit[] = []
  let truncated = false
  for (const rel of files) {
    // The hit cap is checked BEFORE reading the next file, never only compared against the final
    // count afterward — a scan that stops here has, by definition, not looked at whatever files
    // remain, whether or not the eventual total lands exactly on `limit`.
    if (hits.length >= limit) { truncated = true; break }
    const abs = `${root}/${rel}`
    let size: number
    try {
      size = (await stat(abs)).size
    } catch {
      continue
    }
    if (size > GREP_MAX_FILE_BYTES) { truncated = true; continue }
    let buf
    try {
      buf = await readFile(abs)
    } catch {
      continue
    }
    if (looksBinary(buf)) continue
    const lines = buf.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) {
        hits.push({ kind: 'content', path: rel, line: i + 1, text: lines[i]! })
      }
    }
  }
  return { hits, truncated }
}
