/**
 * clean-io.ts — the facts `clean-plan.ts` decides on, read with git and du, and the plan applied
 * (PERF.1 step 5). Every removal goes through git (`git worktree remove`, which itself refuses a
 * dirty tree) or deletes exactly `<worktree>/node_modules`; nothing else is ever deleted.
 */
import { existsSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { CleanItem, WorktreeFacts } from './clean-plan'

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
}

/** Ceiling for one git/du call. */
export const RUN_TIMEOUT_MS = 60_000
/** Keep disk walks bounded while allowing independent worktrees to make progress together. */
export const WORKTREE_POOL_SIZE = 4

let prio: string[] | null = null
function priority(): string[] {
  if (prio) return prio
  const nice = Bun.which('nice'), ionice = Bun.which('ionice')
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

/** GNU du folds newest mtime into the size walk: no second recursive traversal. */
async function diskFacts(path: string, o: CleanIoOpts): Promise<{ bytes: number; mtimeMs: number | null }> {
  if (!existsSync(path)) return { bytes: 0, mtimeMs: null }
  const timed = process.platform === 'linux'
  const r = await run(timed ? ['du', '-sk', '--time', '--time-style=+%s', path] : ['du', '-sk', path], o)
  const columns = r.out.split('\t')
  const bytes = Number(columns[0]?.trim()) * 1024 || 0
  let mtimeMs: number | null = null
  if (timed && columns[1] && Number.isFinite(Number(columns[1]))) mtimeMs = Number(columns[1]) * 1000
  if (mtimeMs === null) { try { mtimeMs = statSync(path).mtimeMs } catch { /* disappeared */ } }
  return { bytes, mtimeMs }
}

async function defaultRef(repo: string, o: CleanIoOpts): Promise<string | null> {
  const head = await git(['-C', repo, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], o)
  if (head.code === 0 && head.out.trim()) return head.out.trim()
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git(['-C', repo, 'rev-parse', '-q', '--verify', `${ref}^{commit}`], o)).code === 0) return ref
  }
  return null
}

/** Every worktree of one repository, with the facts the plan needs. */
export async function worktreeFacts(repo: string, o: CleanIoOpts = {}): Promise<WorktreeFacts[]> {
  const list = await git(['-C', repo, 'worktree', 'list', '--porcelain'], o)
  if (list.code !== 0) return []
  const base = await defaultRef(repo, o)
  const blocks = list.out.split('\n\n').filter(Boolean)
  o.onDiscover?.(blocks.length)
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
    let merged = false, dirty = false, lastCommitMs: number | null = null, sizeBytes = 0, nodeModulesBytes = 0, lastActivityMs: number | null = null
    if (!missing) {
      if (base && headSha) merged = (await git(['-C', repo, 'merge-base', '--is-ancestor', headSha, base], o)).code === 0
      const st = await git(['-C', path, 'status', '--porcelain'], o)
      dirty = st.code !== 0 || st.out.trim() !== ''
      const lc = await git(['-C', path, 'log', '-1', '--format=%ct'], o)
      lastCommitMs = lc.code === 0 && lc.out.trim() ? Number(lc.out.trim()) * 1000 : null
      const [tree, nm] = await Promise.all([diskFacts(path, o), diskFacts(join(path, 'node_modules'), o)])
      sizeBytes = tree.bytes; nodeModulesBytes = nm.bytes
      lastActivityMs = Math.max(tree.mtimeMs ?? 0, lastCommitMs ?? 0) || null
    }
    out[index] = { repo, path, branch, isMain, missing, locked, merged, dirty, lastCommitMs, lastActivityMs, sizeBytes, nodeModulesBytes }
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

/** Apply the plan's non-keep items; returns one sentence per item that could not be done. */
export async function applyClean(items: readonly CleanItem[], o: CleanIoOpts = {}): Promise<string[]> {
  const problems: string[] = []
  const pruned = new Set<string>()
  for (const { facts: f, action: a } of items) {
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
