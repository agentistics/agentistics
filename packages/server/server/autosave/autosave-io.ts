/**
 * autosave/autosave-io.ts — one autosave ROUND over a set of git trees (machine-health spec §4, slice A1).
 *
 * Every primitive (run git, size a file, move/duplicate/remove a file, list a directory, a temp directory) is
 * INJECTED: this module holds the sequence and none of the capabilities, so the delivery guard's inventory
 * (`delivery/doors.lint.test.ts`) gains no writer, and the tests drive it over throwaway repos with real
 * primitives handed in from the test file. The wiring of real primitives and the schedule are slice A2.
 *
 * THE INVARIANT: the person's index, branch, HEAD and working tree are byte-identical before and after.
 * - every git call runs with `GIT_OPTIONAL_LOCKS=0` — a plain `git status` otherwise refreshes and REWRITES
 *   `.git/index` (stat data), which is the person's file;
 * - the save tree is built in a TEMPORARY index (`GIT_INDEX_FILE` in a temp directory of our own):
 *   `read-tree HEAD`, `add -u`, the filtered untracked files, `write-tree`, `commit-tree -p HEAD`;
 *   no stash, no checkout, no `commit`, no hook;
 * - pathspecs are literal (`--literal-pathspecs`) and NUL-separated, so a file named `*` or with a newline
 *   adds exactly itself;
 * - the commit identity and `--no-gpg-sign` are fixed, so a repo without `user.email` or with signing on
 *   neither fails nor prompts.
 *
 * The result goes to a hidden ref (`refs/agentistics/autosave/<slug>`) and a bundle written to a temp name and
 * then moved over the previous one — a crash mid-write leaves the previous bundle whole.
 *
 * "Unchanged" is never decided from the ref alone. The ref is updated BEFORE the bundle (git can only bundle a
 * ref that exists), so two guards keep a failed bundle from being called saved:
 * - on EVERY failure path after `update-ref` (a non-zero `git bundle`, an empty file, a thrown exception, a
 *   failed move or daily copy) the ref is put back where it was;
 * - and because a process (or the VM) can die between `update-ref` and the move, where nothing can put it back,
 *   the previous save only counts when the CURRENT BUNDLE ITSELF holds the ref's commit (`git bundle
 *   list-heads`). A bundle that is missing, unreadable or older than the ref means the tree is saved again.
 *
 * Trees are normalised to their top level (`rev-parse --show-toplevel`) before deduplication, so a registry cwd
 * in a subfolder saves the whole worktree (its root untracked files included) and a repo named both ways is one
 * tree with one bundle.
 */

import { join } from 'node:path'
import {
  autosaveRef,
  autosaveSlug,
  bundleNames,
  commitMessage,
  decideTree,
  dedupeTrees,
  needsLook,
  parseWindowsProfile,
  parseWorktreeList,
  planRetention,
  savedFingerprint,
  shouldRunRound,
  splitNul,
  untrackedToSave,
  utcDay,
  AUTOSAVE_KEEP_DAILY,
  type SkipReason,
} from './autosave-plan'

export interface GitResult { code: number; stdout: string; stderr: string }
export interface GitOptions { env?: Readonly<Record<string, string>>; stdin?: string }

export interface AutosaveIo {
  home: string
  now: () => number
  /** Run `git <args>` in `cwd` with `env` ADDED to the process environment. Never throws: a failure is a code. */
  git: (cwd: string, args: readonly string[], opts?: GitOptions) => Promise<GitResult>
  /** `lstat` size, `null` when unreadable. */
  fileSize: (path: string) => Promise<number | null>
  listDir: (dir: string) => Promise<string[] | null>
  ensureDir: (dir: string) => Promise<void>
  /** Same-directory atomic replace of `to` by `from`. */
  moveFile: (from: string, to: string) => Promise<void>
  duplicateFile: (from: string, to: string) => Promise<void>
  removeFile: (path: string) => Promise<void>
  /** A fresh empty directory of our own (for the temporary index), and its removal. */
  makeTempDir: () => Promise<string>
  removeTree: (dir: string) => Promise<void>
  memAvailableBytes?: () => Promise<number | null>
}

export interface RoundOptions {
  /** Repositories (any checkout of each); their `git worktree list` is expanded. */
  repos: readonly string[]
  /** Extra trees named directly (registry cwds). */
  trees?: readonly string[]
  bundleDir: string
  keepDaily?: number
  /** The out-of-schedule round when the machine health is `critical`: runs whatever memory says. */
  critical?: boolean
}

export type TreeOutcome =
  | { path: string; slug: string; outcome: 'saved'; ref: string; commit: string; bundle: string; skippedFiles: Array<{ path: string; reason: SkipReason }> }
  | { path: string; slug: string; outcome: 'skipped'; why: 'clean' | 'unchanged' | 'nothing-saveable' | 'no-head' }
  | { path: string; slug: string; outcome: 'failed'; why: string }

export interface RoundResult {
  ran: boolean
  why?: 'low-memory' | 'already-running' | 'bundle-dir'
  startedAt: number
  finishedAt: number
  trees: TreeOutcome[]
}

/** Fixed identity: the save never depends on (or prompts for) the repository's own config. */
const IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'agentistics autosave',
  GIT_AUTHOR_EMAIL: 'autosave@agentistics.invalid',
  GIT_COMMITTER_NAME: 'agentistics autosave',
  GIT_COMMITTER_EMAIL: 'autosave@agentistics.invalid',
}
const BASE_ENV: Readonly<Record<string, string>> = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }

export interface Autosaver { round: (opts: RoundOptions) => Promise<RoundResult> }

export function createAutosaver(io: AutosaveIo): Autosaver {
  let running = false

  const git = (cwd: string, args: readonly string[], extra?: GitOptions) =>
    io.git(cwd, args, { ...extra, env: { ...BASE_ENV, ...(extra?.env ?? {}) } })
  const out = async (cwd: string, args: readonly string[], extra?: GitOptions): Promise<string | null> => {
    const r = await git(cwd, args, extra)
    return r.code === 0 ? r.stdout.trim() : null
  }

  async function discover(opts: RoundOptions): Promise<string[]> {
    const found: string[] = [...(opts.trees ?? [])]
    for (const repo of opts.repos) {
      try {
        const r = await git(repo, ['worktree', 'list', '--porcelain'])
        if (r.code === 0) found.push(...parseWorktreeList(r.stdout))
      } catch { /* an unreadable repo contributes no trees; the others still run */ }
    }
    // A subfolder (a registry cwd) means its worktree: `ls-files -o` is relative to the cwd, so saving from the
    // subfolder would miss the root's untracked files, and the same tree would be bundled twice under two slugs.
    const tops: string[] = []
    for (const p of found) {
      let top: string | null = null
      try { top = await out(p, ['rev-parse', '--show-toplevel']) } catch { top = null }
      tops.push(top || p)
    }
    return dedupeTrees(tops)
  }

  /** The commit the bundle file holds for `ref`, or null (missing, unreadable, or not carrying that ref). */
  async function bundleHeadOf(path: string, bundle: string, ref: string): Promise<string | null> {
    const listed = await out(path, ['bundle', 'list-heads', bundle, ref])
    if (!listed) return null
    for (const line of listed.split('\n')) {
      const [commit, name] = line.trim().split(/\s+/)
      if (name === ref && commit) return commit
    }
    return null
  }

  /** The save tree, built in a temporary index. Returns the tree id and what was left out. */
  async function buildTree(path: string): Promise<{ tree: string; skipped: Array<{ path: string; reason: SkipReason }> } | { error: string }> {
    const dir = await io.makeTempDir()
    const env = { GIT_INDEX_FILE: join(dir, 'index') }
    try {
      if ((await git(path, ['read-tree', 'HEAD'], { env })).code !== 0) return { error: 'read-tree' }
      if ((await git(path, ['add', '-u'], { env })).code !== 0) return { error: 'add-u' }
      const listed = await git(path, ['ls-files', '-o', '--exclude-standard', '-z'], { env })
      if (listed.code !== 0) return { error: 'ls-files' }
      const entries = []
      for (const rel of splitNul(listed.stdout)) entries.push({ path: rel, size: rel.endsWith('/') ? 0 : await io.fileSize(join(path, rel)) })
      const plan = untrackedToSave(entries)
      if (plan.keep.length) {
        const added = await git(path, ['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, stdin: plan.keep.join('\0') + '\0' })
        if (added.code !== 0) return { error: 'add-untracked' }
      }
      const tree = await out(path, ['write-tree'], { env })
      return tree ? { tree, skipped: plan.skipped } : { error: 'write-tree' }
    } finally {
      await io.removeTree(dir)
    }
  }

  async function saveTree(path: string, opts: RoundOptions): Promise<TreeOutcome> {
    const slug = autosaveSlug(path, io.home)
    const head = await out(path, ['rev-parse', '--verify', '-q', 'HEAD'])
    if (!head) return { path, slug, outcome: 'skipped', why: 'no-head' }
    const status = await git(path, ['status', '--porcelain', '-z', '--untracked-files=normal'])
    if (status.code !== 0) return { path, slug, outcome: 'failed', why: 'status' }
    const dirty = status.stdout.length > 0
    const ahead = Number(await out(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']) ?? '0') || 0
    if (!needsLook({ dirty, ahead })) return { path, slug, outcome: 'skipped', why: 'clean' }

    const headTree = await out(path, ['rev-parse', 'HEAD^{tree}'])
    if (!headTree) return { path, slug, outcome: 'failed', why: 'head-tree' }
    let tree = headTree
    let skippedFiles: Array<{ path: string; reason: SkipReason }> = []
    if (dirty) {
      const built = await buildTree(path)
      if ('error' in built) return { path, slug, outcome: 'failed', why: built.error }
      tree = built.tree
      skippedFiles = built.skipped
    }

    const ref = autosaveRef(slug)
    const prev = await out(path, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])
    const names = bundleNames(slug, utcDay(io.now()))
    const temp = join(opts.bundleDir, names.temp)
    const current = join(opts.bundleDir, names.current)
    const listing = (await io.listDir(opts.bundleDir)) ?? []
    const bundlePresent = listing.includes(names.current)
    // The ref only describes a save the bundle on disk actually carries (see the header).
    const confirmed = prev !== null && bundlePresent && (await bundleHeadOf(path, current, ref)) === prev
    const savedRef = confirmed && prev
      ? { commit: prev, parent: await out(path, ['rev-parse', '--verify', '-q', `${prev}^1`]), tree: (await out(path, ['rev-parse', `${prev}^{tree}`])) ?? '' }
      : null
    const verdict = decideTree({ head, headTree, tree, ahead, saved: savedFingerprint(savedRef, head, headTree), bundlePresent })
    if (!verdict.save) return { path, slug, outcome: 'skipped', why: verdict.why }

    let commit = head
    if (verdict.commitNeeded) {
      const c = await out(path, ['commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', commitMessage(slug, path, io.now())], { env: IDENTITY })
      if (!c) return { path, slug, outcome: 'failed', why: 'commit-tree' }
      commit = c
    }
    if ((await git(path, ['update-ref', '-m', 'agentistics autosave', ref, commit])).code !== 0) return { path, slug, outcome: 'failed', why: 'update-ref' }

    const dailyTemp = join(opts.bundleDir, names.dailyTemp)
    let stage: 'bundle' | 'bundle-move' = 'bundle'
    try {
      const bundled = await git(path, ['bundle', 'create', '--quiet', temp, ref, '--not', '--remotes'])
      const size = bundled.code === 0 ? await io.fileSize(temp) : null
      if (bundled.code !== 0 || !size) throw new Error('bundle')
      stage = 'bundle-move'
      await io.moveFile(temp, current)
      // The day's snapshot is the newest save of that day: duplicated to its own temp name, then moved in.
      await io.duplicateFile(current, dailyTemp)
      await io.moveFile(dailyTemp, join(opts.bundleDir, names.daily))
    } catch {
      await io.removeFile(temp).catch(() => {})
      await io.removeFile(dailyTemp).catch(() => {})
      // Put the ref back on EVERY failure path, so the next round sees the tree as NOT saved and writes the
      // bundle again. If even this cannot run, the bundle-head check above still refuses to call it saved.
      try {
        if (prev) await git(path, ['update-ref', ref, prev, commit])
        else await git(path, ['update-ref', '-d', ref, commit])
      } catch { /* the bundle-head check covers it */ }
      return { path, slug, outcome: 'failed', why: stage }
    }
    const after = (await io.listDir(opts.bundleDir)) ?? []
    for (const f of planRetention(after, slug, opts.keepDaily ?? AUTOSAVE_KEEP_DAILY)) await io.removeFile(join(opts.bundleDir, f)).catch(() => {})
    return { path, slug, outcome: 'saved', ref, commit, bundle: current, skippedFiles }
  }

  return {
    async round(opts) {
      const startedAt = io.now()
      const done = (r: Omit<RoundResult, 'startedAt' | 'finishedAt'>): RoundResult => ({ ...r, startedAt, finishedAt: io.now() })
      if (running) return done({ ran: false, why: 'already-running', trees: [] })
      const mem = io.memAvailableBytes ? await io.memAvailableBytes() : null
      const gate = shouldRunRound({ memAvailableBytes: mem, critical: opts.critical === true })
      if (!gate.run) return done({ ran: false, why: gate.why, trees: [] })
      running = true
      try {
        try { await io.ensureDir(opts.bundleDir) } catch { return done({ ran: false, why: 'bundle-dir', trees: [] }) }
        const trees: TreeOutcome[] = []
        // One tree at a time: the first round over a big fleet is paced, never parallel (spec §4.5).
        for (const path of await discover(opts)) {
          try { trees.push(await saveTree(path, opts)) } catch (e) {
            trees.push({ path, slug: autosaveSlug(path, io.home), outcome: 'failed', why: e instanceof Error ? e.message.slice(0, 200) : 'error' })
          }
        }
        return done({ ran: true, trees })
      } finally {
        running = false
      }
    },
  }
}

/**
 * The off-VM bundle directory on WSL: the Windows profile (`cmd.exe /c echo %USERPROFILE%`, bounded), translated by
 * `wslpath`. `null` when either step fails — the caller then falls back to `defaultBundleDir`'s same-disk choice
 * and SAYS it is on the same disk.
 */
export async function resolveWindowsProfile(run: (argv: string[], timeoutMs: number) => Promise<{ code: number; stdout: string } | null>, timeoutMs = 5_000): Promise<string | null> {
  const r = await run(['cmd.exe', '/c', 'echo %USERPROFILE%'], timeoutMs)
  const win = r && r.code === 0 ? parseWindowsProfile(r.stdout) : null
  if (!win) return null
  const p = await run(['wslpath', '-u', win], timeoutMs)
  const path = p && p.code === 0 ? p.stdout.trim() : ''
  return path.startsWith('/') ? path : null
}
