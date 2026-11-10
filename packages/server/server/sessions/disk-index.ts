/** Resumable, low-priority crawler for user-selected whole-disk roots. */
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { classifyGitFile, isPrivateMacPath, shouldPruneDirectory, type ScannedDir } from './dir-scan'

export const DISK_INDEX_SLICE_MS = 100
export const DISK_INDEX_TICK_MS = 2_000
export const DISK_INDEX_RECRAWL_MS = 30 * 60_000
/** Poll interval while there is nothing to crawl (no roots, or every root complete). */
export const DISK_INDEX_IDLE_MS = 60_000

const MARKERS = new Set(['package.json', 'pyproject.toml', 'go.mod', 'cargo.toml', 'pom.xml'])
const MAX_ENTRIES = 40_000

interface Task { path: string; depth: number }
interface StoredDir { mtimeMs: number; children: Task[] }
interface DiskState {
  version: 1
  root: string
  queue: Task[]
  visited: Record<string, number>
  dirs: Record<string, StoredDir>
  candidates: ScannedDir[]
  completedAt: number
}

export interface DiskIndexProgress {
  root: string
  visited: number
  queued: number
  candidates: number
  complete: boolean
}

export interface DiskCrawlerOptions {
  root: string
  stateFile?: string
  depth?: number
  now?: () => number
  sliceMs?: number
  /** Test seams: home, platform and the two filesystem reads. */
  home?: string
  platform?: NodeJS.Platform
  statDir?: (path: string) => Promise<{ mtimeMs: number }>
  readDir?: (path: string) => Promise<Dirent<string>[]>
}

function hashRoot(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 24)
}

export function diskIndexFile(root: string, dataDir = AGENTISTICS_DATA_DIR): string {
  return join(dataDir, 'index', 'disks', `${hashRoot(root)}.json`)
}

function emptyState(root: string): DiskState {
  return { version: 1, root, queue: [{ path: root, depth: 0 }], visited: {}, dirs: {}, candidates: [], completedAt: 0 }
}

async function loadState(file: string, root: string): Promise<DiskState> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<DiskState>
    if (parsed.version !== 1 || parsed.root !== root) return emptyState(root)
    return {
      version: 1, root,
      queue: Array.isArray(parsed.queue) ? parsed.queue : [{ path: root, depth: 0 }],
      visited: parsed.visited && typeof parsed.visited === 'object' ? parsed.visited : {},
      dirs: parsed.dirs && typeof parsed.dirs === 'object' ? parsed.dirs : {},
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
      completedAt: Number(parsed.completedAt) || 0,
    }
  } catch { return emptyState(root) }
}

async function persist(file: string, state: DiskState): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(tmp, file).catch(async () => { await writeFile(file, `${JSON.stringify(state)}\n`, { mode: 0o600 }) })
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? path
}

async function projectMarker(entries: { name: string; isDirectory(): boolean; isFile(): boolean }[], path: string): Promise<{ repo: boolean; worktree: boolean }> {
  const git = entries.find(e => e.name === '.git')
  if (git?.isDirectory()) return { repo: true, worktree: false }
  if (git?.isFile()) {
    try { return { repo: false, worktree: classifyGitFile(await readFile(join(path, '.git'), 'utf8')) === 'worktree' } } catch { return { repo: true, worktree: false } }
  }
  return { repo: false, worktree: entries.some(e => MARKERS.has(e.name.toLowerCase()) || /^.+\.sln$/i.test(e.name)) }
}

/** A single crawler. `tick` is deliberately explicit so tests can inject time and simulate restarts. */
export class DiskCrawler {
  private state: DiskState
  private loaded = false
  private readonly depth: number
  private readonly now: () => number
  private readonly sliceMs: number
  private readonly file: string
  /** Bumped whenever the candidate list may have changed, so a caller can tell "same" from "new". */
  private rev = 0

  constructor(private readonly options: DiskCrawlerOptions) {
    this.state = emptyState(options.root)
    this.depth = options.depth ?? 4
    this.now = options.now ?? Date.now
    this.sliceMs = options.sliceMs ?? DISK_INDEX_SLICE_MS
    this.file = options.stateFile ?? diskIndexFile(options.root)
  }

  async load(): Promise<void> {
    if (!this.loaded) { this.state = await loadState(this.file, this.options.root); this.loaded = true }
  }

  async tick(): Promise<DiskIndexProgress> {
    await this.load()
    const now = this.now()
    if (this.state.queue.length === 0 && this.state.completedAt > 0 && now - this.state.completedAt >= DISK_INDEX_RECRAWL_MS) {
      this.state.queue = [{ path: this.state.root, depth: 0 }]
      this.state.completedAt = 0
    }
    // A complete index with no recrawl due has nothing to do: no rewrite of the state file either.
    if (this.state.queue.length === 0 && this.state.completedAt > 0) return this.progress()
    const deadline = now + this.sliceMs
    while (this.state.queue.length && this.now() < deadline) {
      const task = this.state.queue.shift()!
      // Also drops entries a previous run persisted: a private folder is never stat'ed or listed here.
      if (this.isPrivate(task.path)) continue
      let mtimeMs = 0
      try { mtimeMs = (await (this.options.statDir ?? stat)(task.path)).mtimeMs } catch { continue }
      const unchanged = this.state.visited[task.path] === mtimeMs
      this.state.visited[task.path] = mtimeMs
      if (unchanged && this.state.dirs[task.path]) {
        this.state.queue.push(...this.state.dirs[task.path]!.children)
        await Promise.resolve()
        continue
      }
      this.rev++
      this.state.candidates = this.state.candidates.filter(c => c.path !== task.path && !c.path.startsWith(`${task.path}/`))
      let entries: Dirent<string>[] = []
      try { entries = await (this.options.readDir ?? ((p: string) => readdir(p, { withFileTypes: true, encoding: 'utf8' })))(task.path) } catch { this.state.dirs[task.path] = { mtimeMs, children: [] }; continue }
      const marker = await projectMarker(entries, task.path)
      if (task.depth > 0 && (marker.repo || marker.worktree)) {
        this.state.candidates.push({ path: task.path, name: baseName(task.path), repo: marker.repo, worktree: marker.worktree })
      }
      const children: Task[] = task.depth < this.depth ? entries
        .filter(e => e.isDirectory() && !shouldPruneDirectory(e.name) && !this.isPrivate(join(task.path, e.name)))
        .slice(0, MAX_ENTRIES).map(e => ({ path: join(task.path, e.name), depth: task.depth + 1 })) : []
      this.state.dirs[task.path] = { mtimeMs, children }
      this.state.queue.push(...children)
      await Promise.resolve()
    }
    if (this.state.queue.length === 0) this.state.completedAt ||= this.now()
    await persist(this.file, this.state)
    return this.progress()
  }

  progress(): DiskIndexProgress {
    return { root: this.state.root, visited: Object.keys(this.state.visited).length, queued: this.state.queue.length, candidates: this.state.candidates.length, complete: this.state.queue.length === 0 && this.state.completedAt > 0 }
  }

  /** Changes whenever progress or the candidate list may have changed. */
  signature(): string {
    const p = this.progress()
    return `${this.rev}:${p.visited}:${p.queued}:${p.candidates}:${p.complete ? 1 : 0}`
  }

  /** True when a tick would do real work (queue non-empty or a recrawl is due). */
  idle(): boolean {
    return this.state.queue.length === 0 && this.state.completedAt > 0 && this.now() - this.state.completedAt < DISK_INDEX_RECRAWL_MS
  }

  candidates(): ScannedDir[] { return this.state.candidates.filter(c => !this.isPrivate(c.path)) }

  private isPrivate(path: string): boolean {
    return isPrivateMacPath(path, this.options.home, this.options.platform)
  }
}

export interface DiskIndexSnapshot { candidates: ScannedDir[]; progress: DiskIndexProgress[]; indexing: boolean }

/** Owns all selected disks and advances exactly one root per tick. */
export class DiskIndex {
  private crawlers = new Map<string, DiskCrawler>()
  private roots: string[] = []
  private cursor = 0
  private running = false
  private timer: ReturnType<typeof setTimeout> | undefined
  /** A tick is awaiting: a wake() then only flags it, so two chains of timers can never exist. */
  private ticking = false
  private wakeRequested = false
  private lastSignature = ''
  onSnapshot?: (snapshot: DiskIndexSnapshot) => void

  configure(roots: string[], factory: (root: string) => DiskCrawler = root => new DiskCrawler({ root })): void {
    const before = this.roots.join('\0')
    this.roots = [...new Set(roots)]
    for (const root of this.roots) if (!this.crawlers.has(root)) this.crawlers.set(root, factory(root))
    for (const root of this.crawlers.keys()) if (!this.roots.includes(root)) this.crawlers.delete(root)
    // A running loop may be parked on the long idle wait: new roots must not wait it out.
    if (this.running && before !== this.roots.join('\0')) this.wake()
  }

  async tick(): Promise<DiskIndexSnapshot> {
    if (this.roots.length) {
      const root = this.roots[this.cursor++ % this.roots.length]!
      await this.crawlers.get(root)!.tick()
    }
    const snapshot = this.snapshot()
    // Tell the listener only when something it could show has changed.
    const sig = this.signature()
    if (sig !== this.lastSignature) { this.lastSignature = sig; this.onSnapshot?.(snapshot) }
    return snapshot
  }

  private signature(): string {
    return this.roots.map(r => `${r}=${this.crawlers.get(r)!.signature()}`).join('|')
  }

  /** Nothing to crawl: no roots, or every root complete with no recrawl due. */
  private idle(): boolean {
    return this.roots.every(r => this.crawlers.get(r)!.idle())
  }

  private schedule(ms: number): void {
    if (!this.running) return
    this.timer = setTimeout(() => { void this.loop() }, ms)
    this.timer.unref?.()
  }

  private async loop(): Promise<void> {
    if (!this.running || this.ticking) return
    this.wakeRequested = false
    // Never touch the crawlers (or the listener) while there is nothing to do.
    if (this.idle()) { this.schedule(DISK_INDEX_IDLE_MS); return }
    this.ticking = true
    try { await this.tick().catch(() => {}) } finally { this.ticking = false }
    this.schedule(this.wakeRequested ? 0 : DISK_INDEX_TICK_MS)
  }

  private wake(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    // The loop in flight reschedules itself immediately once its tick ends; never start a second one.
    if (this.ticking) { this.wakeRequested = true; return }
    this.schedule(0)
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer) }

  snapshot(): DiskIndexSnapshot {
    const crawlers = this.roots.map(root => this.crawlers.get(root)!)
    const progress = crawlers.map(c => c.progress())
    return { candidates: crawlers.flatMap(c => c.candidates()), progress, indexing: progress.some(p => !p.complete) }
  }
}
