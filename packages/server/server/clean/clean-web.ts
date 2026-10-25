import { readdirSync, readlinkSync, statfsSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { platform } from 'node:os'
import { cleanRepos, collectCleanFacts } from '../cli-clean'
import { applyClean } from './clean-io'
import { fmtBytes, planClean, type CleanItem, type WorktreeFacts } from './clean-plan'
import { broadcastNotification } from '../sse'
import type { CleanWebPlan, CleanJob, CleanScanState } from '@agentistics/core'
import { newCleanScan, scanEstimate, scanLog, wireCleanPlan } from './clean-state'

export type { CleanWebItem, CleanWebPlan, CleanJob } from '@agentistics/core'

let scan: { promise: Promise<CleanWebPlan>; controller: AbortController; state: CleanScanState } | null = null
let cached: { plan: CleanWebPlan; at: number } | null = null
let job: CleanJob | null = null
const CACHE_MS = 5 * 60_000

function itemId(f: WorktreeFacts, kind: CleanItem['action']['kind']): string { return `${f.repo}:${f.path}:${kind}` }

/** Server-owned task: leaving the dialog does not interrupt it. */
export function getCleanPlan(): { state: 'scanning' | 'ready'; progress: number; plan: Promise<CleanWebPlan> } {
  if (scan?.state.state === 'scanning') return { state: 'scanning', progress: scan.state.progress, plan: scan.promise }
  if (cached && (scan?.state.background || Date.now() - cached.at < CACHE_MS)) return { state: 'ready', progress: 1, plan: Promise.resolve(cached.plan) }
  cached = null
  const controller = new AbortController()
  const state = newCleanScan(crypto.randomUUID(), Date.now())
  const signal = controller.signal
  const promise = (async () => {
    const repos = await cleanRepos([], { signal, lowPriority: true })
    signal.throwIfAborted()
    state.projectTotal = repos.length
    for (const repo of repos) scanLog(state, { at: Date.now(), state: 'queued', name: basename(repo) })
    state.step = 2; state.label = 'measuring'
    const protectedBySession = await protectedPaths()
    signal.throwIfAborted()
    let completed = 0, total = 0, discoveredRepos = 0
    const facts = await collectCleanFacts(repos, { lowPriority: true, signal,
      onDiscover: count => { total += count; discoveredRepos++ },
      onItemStart: path => scanLog(state, { at: Date.now(), state: 'running', name: basename(path) }),
      onItem: fact => {
        completed++
        const row = wireCleanPlan(planClean([fact], Date.now()), state, Date.now(), protectionFor([fact], protectedBySession)).items[0]!
        if (row.kind !== 'keep') { state.foundBytes += row.bytes; state.itemCount++ }
        state.measuredBytes = (state.measuredBytes ?? 0) + fact.sizeBytes
        // The line reports what was MEASURED. It used to print 0 for every kept folder, so a scan of
        // folders holding gigabytes read as a column of "0 B".
        scanLog(state, { at: Date.now(), state: 'done', name: basename(fact.path), bytes: fact.sizeBytes,
          ...(row.kind === 'keep' ? { kept: true } : { freeBytes: row.bytes }), ...(fact.sizeUnknown ? { unknown: true } : {}) })
        scanEstimate(state, completed, Math.max(total, Math.ceil(total / Math.max(1, discoveredRepos) * repos.length)), Date.now())
      },
      onProgress: done => { state.projectCount = done },
    })
    signal.throwIfAborted()
    state.step = 3; state.label = 'preparing'; state.progress = 0.98
    const plan = wireCleanPlan(planClean(facts, Date.now()), state, Date.now(), protectionFor(facts, protectedBySession))
    state.state = 'ready'; state.progress = 1; state.etaMs = 0; state.elapsedMs = plan.elapsedMs
    state.foundBytes = plan.reclaimable.bytes; state.itemCount = plan.reclaimable.count
    cached = { plan, at: Date.now() }
    return plan
  })().catch(error => {
    const cancelled = signal.aborted
    controller.abort()
    state.state = cancelled ? 'cancelled' : 'error'
    state.elapsedMs = Date.now() - state.startedAt
    if (!cancelled) state.error = String(error)
    throw error
  })
  // Polling uses the snapshot; consume rejections even when nobody awaits the promise.
  void promise.catch(() => {})
  scan = { promise, controller, state }
  return { state: 'scanning', progress: state.progress, plan: promise }
}
function protectionFor(facts: readonly WorktreeFacts[], protectedBySession: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of facts) {
    const match = [...protectedBySession].find(([p]) => inside(f.path, p) || inside(p, f.path))
    if (match) out.set(f.path, match[1])
  }
  return out
}
export function cleanScanState(): CleanScanState | null {
  if (!scan) return null
  const state = scan.state
  return { ...state, elapsedMs: state.state === 'scanning' ? Date.now() - state.startedAt : state.elapsedMs, log: [...state.log] }
}
export function backgroundCleanScan(): CleanScanState | null {
  if (scan && (scan.state.state === 'scanning' || scan.state.state === 'ready')) scan.state.background = true
  return cleanScanState()
}
export function cancelCleanScan(): CleanScanState | null {
  if (scan?.state.state === 'scanning') {
    scan.state.state = 'cancelled'; scan.state.background = false; scan.controller.abort()
  }
  return cleanScanState()
}
export function finalizeCleanScan(): void {
  if (scan?.state.state === 'scanning') return
  scan = null; cached = null
}
export async function cleanPlanResponse(): Promise<CleanWebPlan | CleanScanState> {
  if (cached && (scan?.state.background || Date.now() - cached.at < CACHE_MS)) return cached.plan
  if (!scan || scan.state.state === 'cancelled' || scan.state.state === 'ready') getCleanPlan()
  return cleanScanState()!
}

function inside(path: string, root: string): boolean { const p = resolve(path), r = resolve(root); return p === r || p.startsWith(r + sep) }
export async function protectedPaths(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const cwd = process.cwd()
  try {
    // The consolidated store is historical. The fleet is the server's live source of truth;
    // importing it lazily also keeps the cleanup scanner independent of CLI startup wiring.
    const { readFleet } = await import('../sessions/fleet-web')
    const fleet = await readFleet('en')
    for (const row of fleet.rows) {
      if (['working', 'waiting', 'waiting-approval', 'unknown'].includes(row.state) && row.cwd) out.set(row.cwd, 'an active session')
    }
  } catch {
    // A failed fleet read must not turn historical sessions into permanent locks. processIn below
    // remains the independent last safety check.
  }
  if (cwd) out.set(cwd, 'the server working directory')
  return out
}
export async function processIn(path: string): Promise<boolean> {
  if (platform() === 'linux') {
    let pids: string[]
    try { pids = readdirSync('/proc').filter(name => /^\d+$/.test(name)) } catch { return true }
    let inspected = 0
    for (const pid of pids) {
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`)
        inspected++
        if (inside(cwd, path)) return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EACCES' && code !== 'ENOENT') return true
      }
    }
    return inspected === 0
  }
  const lsof = Bun.which('lsof')
  if (!lsof) return true
  try {
    const out = Bun.spawnSync([lsof, '-a', '-d', 'cwd', '-Fn']).stdout.toString()
    return out.split('\n').some(line => line.startsWith('n') && inside(line.slice(1), path))
  } catch { return true }
}
export async function applyCleanSelection(ids: readonly string[]): Promise<CleanJob> {
  if (job && job.state !== 'done') throw new Error('clean job already running')
  const created: CleanJob = { id: crypto.randomUUID(), state: 'verifying', progress: 0 }
  job = created
  void (async () => {
    const startedAt = Date.now()
    const diskFreeBefore = diskFree()
    const protectedBySession = await protectedPaths()
    const requested = new Set(ids)
    const repos = await cleanRepos([])
    const currentPlan = planClean(await collectCleanFacts(repos, { lowPriority: true }), Date.now())
    const planned = new Map((cached?.plan.items ?? []).map(item => [item.id, item]))
    const current = currentPlan.filter(i => i.action.kind !== 'keep' && requested.has(itemId(i.facts, i.action.kind)))
    const skipped: Array<{ path: string; reason: string }> = []
    const currentIds = new Set(current.map(i => itemId(i.facts, i.action.kind)))
    for (const id of requested) {
      if (currentIds.has(id)) continue
      skipped.push({ path: planned.get(id)?.path ?? id, reason: 'changed since the plan' })
    }
    const safe: CleanItem[] = []
    for (const item of current) {
      const f = item.facts
      const session = [...protectedBySession].find(([p]) => inside(f.path, p) || inside(p, f.path))
      if (session) { skipped.push({ path: f.path, reason: session[1] }); continue }
      if (await processIn(f.path)) { skipped.push({ path: f.path, reason: 'a process is running inside it (or its location is unknown)' }); continue }
      safe.push(item)
    }
    const errors: string[] = []
    const removed: NonNullable<CleanJob['result']>['removed'] = []
    const apply = async (items: CleanItem[]) => {
      const problems = await applyClean(items)
      errors.push(...problems)
      for (const item of items) {
        if (item.action.kind !== 'keep' && !problems.some(problem => problem.startsWith((item.action.kind === 'node-modules' ? join(item.facts.path, 'node_modules') : item.facts.path) + ':'))) {
          removed.push({ path: item.facts.path, kind: item.action.kind, bytes: item.action.frees })
        }
      }
    }
    created.state = 'removing worktrees'; created.progress = 25
    await apply(safe.filter(i => i.action.kind === 'remove'))
    created.state = 'removing node_modules'; created.progress = 60
    await apply(safe.filter(i => i.action.kind === 'node-modules'))
    created.state = 'pruning'; created.progress = 85
    await apply(safe.filter(i => i.action.kind === 'prune'))
    created.result = { freedBytes: removed.reduce((n, i) => n + i.bytes, 0), worktrees: removed.filter(i => i.kind === 'remove' || i.kind === 'prune').length, removedWorktrees: removed.filter(i => i.kind === 'remove').length,
      nodeModules: removed.filter(i => i.kind === 'node-modules').length, pruned: removed.filter(i => i.kind === 'prune').length,
      skipped, errors, removed, elapsedMs: Date.now() - startedAt, diskFreeBefore, diskFreeAfter: diskFree() }
    created.state = 'done'; created.progress = 100
    cached = null
    scan = null
    console.info('[clean] apply', JSON.stringify({ jobId: created.id, ...created.result }))
    broadcastNotification({
      type: created.result.skipped.length || created.result.errors.length ? 'warning' : 'success',
      code: created.result.skipped.length || created.result.errors.length ? 'clean.partial' : 'clean.done',
      meta: {
        freed: fmtBytes(created.result.freedBytes),
        worktrees: created.result.worktrees,
        nodeModules: created.result.nodeModules,
        skipped: created.result.skipped.length,
        errors: created.result.errors.length,
      },
    })
  })().catch(error => { created.state = 'done'; created.progress = 100; created.result = { freedBytes: 0, worktrees: 0, removedWorktrees: 0, nodeModules: 0, skipped: [], errors: [String(error)], pruned: 0, removed: [], elapsedMs: 0, diskFreeBefore: null, diskFreeAfter: null } })
  return created
}
export function cleanJob(): CleanJob | null { return job }

function diskFree(): number | null {
  try { const fs = statfsSync(process.cwd()); return fs.bavail * fs.bsize } catch { return null }
}
