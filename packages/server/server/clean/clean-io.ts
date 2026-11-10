/**
 * clean-io.ts — the facts `clean-plan.ts` decides on, read with git and du, and the plan applied
 * (PERF.1 step 5). Every removal goes through git (`git worktree remove`, which itself refuses a
 * dirty tree) or deletes exactly `<worktree>/node_modules`; nothing else is ever deleted.
 */
import { hostWhich } from '../host-which'
import { existsSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { CleanItem, WorktreeFacts } from './clean-plan'
import { MANAGED_SESSIONS_FILE } from '../config'

export interface CleanIoOpts {
  signal?: AbortSignal
  onDiscover?: (count: number) => void
  onItemStart?: (path: string) => void
  onItem?: (facts: WorktreeFacts) => void
  env?: Record<string, string | undefined>
  /** Run git and du at the lowest CPU and I/O priority (the server's weekly look). */
  lowPriority?: boolean
  /** Override the per-process ceiling in tests; production keeps the 60-second default. */
  timeoutMs?: number
  /** Test seam: cwds of not-ended managed sessions; production reads the session registry. */
  managedCwds?: readonly string[]
  /** Test seam: the registry file to read; production reads the managed-sessions file. */
  registryFile?: string
  /** Test seam: the process cwd reader. */
  processCwds?: () => CwdReading
  /** A sentence the caller should show: a source of "in use" could not be read. */
  onWarning?: (message: string) => void
}

/** Ceiling for one git/du call. */
export const RUN_TIMEOUT_MS = 60_000
/** Keep disk walks bounded while allowing independent worktrees to make progress together. */
export const WORKTREE_POOL_SIZE = 4

let prio: string[] | null = null
function priority(): string[] {
  if (prio) return prio
  const nice = hostWhich('nice'), ionice = hostWhich('ionice')
  prio = [...(nice ? [nice, '-n', '19'] : []), ...(ionice ? [ionice, '-c', '3'] : [])]
  return prio
}

async function run(argv: string[], o: CleanIoOpts & { cwd?: string } = {}): Promise<{ code: number; out: string }> {
  o.signal?.throwIfAborted()
  const p = Bun.spawn(o.lowPriority ? [...priority(), ...argv] : argv, { cwd: o.cwd, env: (o.env ?? process.env) as Record<string, string>, stdout: 'pipe', stderr: 'ignore' })
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const abort = () => {
    try { p.kill('SIGKILL') } catch { /* exited */ }
    rejectAbort?.(o.signal?.reason ?? new Error('clean scan cancelled'))
  }
  o.signal?.addEventListener('abort', abort, { once: true })
  // A wedged git/du (huge tree, dead network mount) must cost one item, never the whole command.
  let timedOut = false
  let timeout!: ReturnType<typeof setTimeout>
  const deadline = new Promise<{ code: number; out: string }>(resolve => {
    timeout = setTimeout(() => {
      timedOut = true
      try { p.kill('SIGKILL') } catch { /* gone */ }
      // Do not await the pipe after killing the process. A child such as a Git hook can inherit
      // stdout and keep the pipe open even though the process we spawned is gone.
      resolve({ code: 124, out: '' })
    }, o.timeoutMs ?? RUN_TIMEOUT_MS)
  })
  const result = (async () => {
    const out = await new Response(p.stdout).text()
    return { code: await p.exited, out }
  })()
  try {
    const value = await Promise.race([result, deadline, aborted])
    o.signal?.throwIfAborted()
    return value
  } finally {
    o.signal?.removeEventListener('abort', abort)
    clearTimeout(timeout)
    if (timedOut || o.signal?.aborted) void result.catch(() => {})
  }
}
const git = (args: string[], o: CleanIoOpts) => run(['git', ...args], o)

/** The repository (its common dir's parent: the main checkout) a path belongs to, or null. */
export async function repoOf(path: string, o: CleanIoOpts = {}): Promise<string | null> {
  if (!existsSync(path)) return null
  const r = await git(['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], o)
  if (r.code !== 0) return null
  const common = r.out.trim()
  return common.endsWith(`${sep}.git`) ? common.slice(0, -5) : null
}

/** What one `du` reported for a tree, or null when it said nothing usable. Pure; exported for tests. */
export function parseDu(out: string, path: string, timed: boolean): { bytes: number; mtimeMs: number | null; nodeModulesBytes: number } | null {
  const nm = join(path, 'node_modules')
  let total: { bytes: number; mtimeMs: number | null } | null = null
  let nodeModulesBytes = 0
  for (const line of out.split('\n')) {
    const cols = line.split('\t')
    if (cols.length < (timed ? 3 : 2)) continue
    const kb = Number(cols[0]?.trim())
    if (!Number.isFinite(kb) || cols[0]!.trim() === '') continue
    const at = timed ? Number(cols[1]) : NaN
    const where = resolve(cols.slice(timed ? 2 : 1).join('\t'))
    if (where === resolve(path)) total = { bytes: kb * 1024, mtimeMs: Number.isFinite(at) ? at * 1000 : null }
    else if (where === resolve(nm)) nodeModulesBytes = kb * 1024
  }
  return total ? { ...total, nodeModulesBytes } : null
}

/**
 * ONE du per worktree: its total, its `node_modules` (a depth-1 line of the same walk) and, on GNU,
 * the newest mtime. Worktrees nested INSIDE this one are excluded — the main checkout holds
 * `.claude/worktrees/*`, and walking them again counted every worktree twice and made the main
 * checkout's walk the one that outlived the timeout. A du that timed out or printed nothing is
 * `unknown`, never a measured 0.
 */
async function diskFacts(path: string, nested: readonly string[], o: CleanIoOpts): Promise<{ bytes: number; nodeModulesBytes: number; mtimeMs: number | null; unknown: boolean }> {
  if (!existsSync(path)) return { bytes: 0, nodeModulesBytes: 0, mtimeMs: null, unknown: false }
  const gnu = process.platform === 'linux'
  const argv = gnu
    ? ['du', '-k', '-d', '1', '--time', '--time-style=+%s', ...nested.map(n => `--exclude=${n}`), path]
    : ['du', '-k', '-d', '1', path]
  const r = await run(argv, o)
  const parsed = r.code === 124 ? null : parseDu(r.out, path, gnu)
  let mtimeMs = parsed?.mtimeMs ?? null
  if (mtimeMs === null) { try { mtimeMs = statSync(path).mtimeMs } catch { /* disappeared */ } }
  return { bytes: parsed?.bytes ?? 0, nodeModulesBytes: parsed?.nodeModulesBytes ?? 0, mtimeMs, unknown: parsed === null }
}

async function defaultRef(repo: string, o: CleanIoOpts): Promise<string | null> {
  const head = await git(['-C', repo, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], o)
  if (head.code === 0 && head.out.trim()) return head.out.trim()
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git(['-C', repo, 'rev-parse', '-q', '--verify', `${ref}^{commit}`], o)).code === 0) return ref
  }
  return null
}

/** What a reader could say about "who is sitting where": `known: false` means it could not tell at all. */
export interface CwdReading { cwds: string[]; known: boolean }

/**
 * Directories the live processes of this machine are sitting in. Linux reads /proc; elsewhere `lsof`
 * (the same reader the web apply uses). A platform or machine with no working reader is UNKNOWN,
 * never "nobody is there".
 */
export function liveCwds(): CwdReading {
  if (process.platform === 'linux') {
    let pids: string[]
    try { pids = readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid) } catch { return { cwds: [], known: false } }
    const cwds: string[] = []
    for (const pid of pids) {
      try { cwds.push(readlinkSync(`/proc/${pid}/cwd`)) } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        // Gone (ENOENT) or not ours (EACCES) is ordinary; anything else means the read itself is unreliable.
        if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'ESRCH') return { cwds, known: false }
      }
    }
    return { cwds, known: true }
  }
  const lsof = hostWhich('lsof')
  if (!lsof) return { cwds: [], known: false }
  try {
    const r = Bun.spawnSync([lsof, '-a', '-d', 'cwd', '-Fn'])
    // Exit 0 with nothing printed is "ran and found nothing"; a failure, even with partial output, is unknown.
    if (r.exitCode !== 0) return { cwds: [], known: false }
    const cwds = r.stdout.toString().split('\n').filter(l => l.startsWith('n')).map(l => l.slice(1))
    return { cwds, known: true }
  } catch { return { cwds: [], known: false } }
}

/**
 * cwds of managed sessions never ended, read from the registry FILE. A missing file is a real empty
 * registry; an unreadable, empty-by-corruption or non-array one is UNKNOWN — `readRegistry` would
 * report `[]` for it, which is exactly how an open session became removable.
 */
export async function managedReading(o: CleanIoOpts): Promise<CwdReading> {
  if (o.managedCwds) return { cwds: [...o.managedCwds], known: true }
  const file = o.registryFile ?? MANAGED_SESSIONS_FILE
  let text: string
  try { text = await readFile(file, 'utf-8') } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { cwds: [], known: true } : { cwds: [], known: false }
  }
  if (!text.trim()) return { cwds: [], known: true }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return { cwds: [], known: false }
    const rows = parsed.filter((r): r is { cwd: string; endedAt?: string } => !!r && typeof r === 'object' && typeof (r as { cwd?: unknown }).cwd === 'string')
    return { cwds: openSessionCwds(rows), known: true }
  } catch { return { cwds: [], known: false } }
}

/** Process + registry together: the cwds to protect and whether either source was unreadable. */
export async function useReading(o: CleanIoOpts): Promise<CwdReading> {
  const live = (o.processCwds ?? liveCwds)()
  const managed = await managedReading(o)
  return { cwds: [...live.cwds, ...managed.cwds], known: live.known && managed.known }
}

/** Ignored paths an install or build brings back; anything else ignored (`.env.local`, `*.secret`) is the user's. */
const REGENERABLE = new Set(['node_modules', 'dist', 'build', '.turbo', '.next', 'coverage', '.cache', 'out'])
export function isRegenerable(entry: string): boolean {
  if (entry.startsWith('"')) return false // git quoted an unusual name: do not guess
  // Only a directory git collapsed whole (trailing `/`) is a build output; a loose file inside
  // `dist/` (`src/dist/keys.secret`) is listed by its own path and belongs to the user.
  if (entry.endsWith('/')) return REGENERABLE.has(entry.replace(/\/+$/, '').split('/').pop() ?? '')
  return entry.endsWith('.tsbuildinfo')
}

/** dirty = tracked/untracked change; keepsIgnored = an ignored entry outside the regenerable list (or git could not say). */
export async function treeState(path: string, o: CleanIoOpts): Promise<{ dirty: boolean; keepsIgnored: boolean }> {
  const st = await git(['-C', path, 'status', '--porcelain', '--ignored'], o)
  if (st.code !== 0) return { dirty: true, keepsIgnored: true }
  let dirty = false, keepsIgnored = false
  for (const line of st.out.split('\n')) {
    if (!line.trim()) continue
    if (line.startsWith('!! ')) { if (!isRegenerable(line.slice(3))) keepsIgnored = true } else dirty = true
  }
  return { dirty, keepsIgnored }
}

/** cwds of managed sessions that were never ended (stopped but resumable still count). Pure; exported for tests. */
export function openSessionCwds(rows: ReadonlyArray<{ cwd: string; endedAt?: string }>): string[] {
  return rows.filter(r => !r.endedAt && r.cwd).map(r => resolve(r.cwd))
}

/** A live process has its cwd at or below `path`. Pure; exported for tests. */
export function cwdInside(path: string, cwds: readonly string[]): boolean {
  const p = resolve(path)
  return cwds.some(c => c === p || c.startsWith(p + sep))
}

/** Every worktree of one repository, with the facts the plan needs. */
export async function worktreeFacts(repo: string, o: CleanIoOpts = {}): Promise<WorktreeFacts[]> {
  const list = await git(['-C', repo, 'worktree', 'list', '--porcelain'], o)
  if (list.code !== 0) return []
  const base = await defaultRef(repo, o)
  const blocks = list.out.split('\n\n').filter(Boolean)
  const allPaths = blocks.map(b => b.split('\n').find(l => l.startsWith('worktree '))?.slice(9)).filter((p): p is string => !!p).map(p => resolve(p))
  o.onDiscover?.(blocks.length)
  const use = await useReading(o)
  if (!use.known) o.onWarning?.('Could not read the process list or the session registry: worktrees are kept because it is unknown whether they are in use.')
  const cwds = use.cwds
  const out: Array<WorktreeFacts | undefined> = []
  let next = 0
  const inspect = async (block: string, index: number) => {
    const lines = block.split('\n').filter(Boolean)
    const path = lines.find(l => l.startsWith('worktree '))?.slice(9)
    if (!path) return
    o.signal?.throwIfAborted()
    o.onItemStart?.(path)
    const headSha = lines.find(l => l.startsWith('HEAD '))?.slice(5) ?? null
    const branch = lines.find(l => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null
    const isMain = resolve(path) === resolve(repo)
    const missing = lines.some(l => l.startsWith('prunable')) || !existsSync(path)
    const locked = lines.some(l => l.startsWith('locked'))
    let merged = false, pushed = false, squashed = false, dirty = false, lastCommitMs: number | null = null, sizeBytes = 0, nodeModulesBytes = 0, lastActivityMs: number | null = null, sizeUnknown = false, keepsIgnored = false
    if (!missing) {
      if (base && headSha) merged = (await git(['-C', repo, 'merge-base', '--is-ancestor', headSha, base], o)).code === 0
      if (!merged && headSha) {
        // A squash/rebase merge leaves no ancestry: ask whether the commits survive elsewhere instead.
        if (branch) pushed = (await git(['-C', repo, 'merge-base', '--is-ancestor', headSha, `refs/remotes/origin/${branch}`], o)).code === 0
        if (!pushed && base) {
          const c = await git(['-C', repo, 'cherry', base, headSha], o)
          const marks = c.out.split('\n').filter(Boolean)
          squashed = c.code === 0 && marks.length > 0 && marks.every(l => l.startsWith('-'))
        }
      }
      const tree = await treeState(path, o)
      dirty = tree.dirty; keepsIgnored = tree.keepsIgnored
      const lc = await git(['-C', path, 'log', '-1', '--format=%ct'], o)
      lastCommitMs = lc.code === 0 && lc.out.trim() ? Number(lc.out.trim()) * 1000 : null
      const own = resolve(path)
      const disk = await diskFacts(path, allPaths.filter(p => p !== own && p.startsWith(own + sep)), o)
      sizeBytes = disk.bytes; nodeModulesBytes = disk.nodeModulesBytes; sizeUnknown = disk.unknown
      lastActivityMs = Math.max(disk.mtimeMs ?? 0, lastCommitMs ?? 0) || null
    }
    out[index] = { repo, path, branch, isMain, missing, locked, merged, pushed, squashed, inUse: cwdInside(path, cwds), ...(use.known ? {} : { useUnknown: true }), ...(keepsIgnored ? { keepsIgnored } : {}), dirty, lastCommitMs, lastActivityMs, sizeBytes, nodeModulesBytes, ...(sizeUnknown ? { sizeUnknown } : {}) }
    o.onItem?.(out[index]!)
  }
  await Promise.all(Array.from({ length: Math.min(WORKTREE_POOL_SIZE, blocks.length) }, async () => {
    while (next < blocks.length) {
      o.signal?.throwIfAborted()
      const index = next++
      await inspect(blocks[index]!, index)
    }
  }))
  return out.filter((f): f is WorktreeFacts => f !== undefined)
}

/** Why a worktree must not be touched NOW (in use, unknown, dirty, non-regenerable ignored files), or null. */
async function changedSince(path: string, o: CleanIoOpts, removing: boolean): Promise<string | null> {
  const use = await useReading(o)
  if (cwdInside(path, use.cwds)) return 'it is in use now'
  if (!use.known) return 'it is unknown whether it is in use (process list or session registry unreadable)'
  if (!removing) return null // node_modules only: uncommitted work elsewhere in the tree is untouched
  const tree = await treeState(path, o)
  if (tree.dirty) return 'it has uncommitted changes now'
  if (tree.keepsIgnored) return 'it holds ignored files that cannot be regenerated'
  return null
}

/** Apply the plan's non-keep items; returns one sentence per item that could not be done. */
export async function applyClean(items: readonly CleanItem[], o: CleanIoOpts = {}): Promise<string[]> {
  const problems: string[] = []
  const pruned = new Set<string>()
  for (const { facts: f, action: a } of items) {
    if (a.kind === 'remove' || a.kind === 'node-modules') {
      // The plan may be minutes old: look again at THIS worktree right before touching it.
      const why = await changedSince(f.path, o, a.kind === 'remove')
      if (why) { problems.push(`${f.path}: skipped, ${why}`); continue }
    }
    if (a.kind === 'remove') {
      // No --force: git refuses a tree that changed since it was listed.
      const r = await git(['-C', f.repo, 'worktree', 'remove', f.path], o)
      if (r.code !== 0) problems.push(`${f.path}: git refused to remove it (it changed since it was listed?)`)
    } else if (a.kind === 'prune' && !pruned.has(f.repo)) {
      pruned.add(f.repo)
      await git(['-C', f.repo, 'worktree', 'prune'], o)
    } else if (a.kind === 'node-modules') {
      const nm = join(f.path, 'node_modules')
      if (resolve(nm) !== resolve(f.path, 'node_modules') || !existsSync(nm)) continue
      try { rmSync(nm, { recursive: true, force: true }) } catch (e) { problems.push(`${nm}: ${String(e)}`) }
    }
  }
  return problems
}
