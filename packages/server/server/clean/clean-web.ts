import { readdirSync, readlinkSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { platform } from 'node:os'
import { cleanRepos, collectCleanFacts } from '../cli-clean'
import { applyClean } from './clean-io'
import { fmtBytes, planClean, reclaimable, type CleanItem, type WorktreeFacts } from './clean-plan'
import { loadConsolidated } from '../consolidate'
import { broadcastNotification } from '../sse'

export interface CleanWebItem {
  id: string
  repo: string
  path: string
  kind: CleanItem['action']['kind']
  bytes: number
  reason: string
}
export interface CleanWebPlan { items: CleanWebItem[]; reclaimable: { bytes: number; count: number } }
export interface CleanJob { id: string; state: 'verifying' | 'removing worktrees' | 'removing node_modules' | 'pruning' | 'done'; progress: number; result?: { freedBytes: number; worktrees: number; nodeModules: number; skipped: Array<{ path: string; reason: string }>; errors: string[] } }

let scan: { promise: Promise<CleanWebPlan>; at: number } | null = null
let cached: { plan: CleanWebPlan; at: number } | null = null
let job: CleanJob | null = null
const CACHE_MS = 5 * 60_000

function itemId(f: WorktreeFacts, kind: CleanItem['action']['kind']): string { return `${f.repo}:${f.path}:${kind}` }
function reason(item: CleanItem): string {
  if (item.action.kind === 'remove') return 'merged and clean'
  if (item.action.kind === 'prune') return 'directory is gone'
  if (item.action.kind === 'node-modules') return 'no commit in 30+ days'
  return item.action.reason
}
function wire(items: readonly CleanItem[]): CleanWebPlan {
  const selected = items.filter(i => i.action.kind !== 'keep')
  return { items: selected.map(i => {
    if (i.action.kind === 'keep') throw new Error('keep item selected')
    return { id: itemId(i.facts, i.action.kind), repo: i.facts.repo, path: i.facts.path, kind: i.action.kind, bytes: i.action.frees, reason: reason(i) }
  }), reclaimable: reclaimable(items) }
}
async function scanNow(): Promise<CleanWebPlan> {
  const facts = await collectCleanFacts(await cleanRepos([]), { lowPriority: true })
  return wire(planClean(facts, Date.now()))
}
export function getCleanPlan(): { state: 'scanning' | 'ready'; progress: number; plan?: Promise<CleanWebPlan> } {
  if (scan && Date.now() - scan.at < CACHE_MS) return { state: 'scanning', progress: 0, plan: scan.promise }
  const promise = scanNow().then(plan => { cached = { plan, at: Date.now() }; return plan }).finally(() => { if (scan?.promise === promise) scan = null })
  scan = { promise, at: Date.now() }
  return { state: 'scanning', progress: 0, plan: promise }
}
export async function cleanPlanResponse(): Promise<CleanWebPlan | { state: 'scanning'; progress: number }> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.plan
  if (!scan || Date.now() - scan.at >= CACHE_MS) getCleanPlan()
  return { state: 'scanning', progress: 0 }
}

function inside(path: string, root: string): boolean { const p = resolve(path), r = resolve(root); return p === r || p.startsWith(r + sep) }
async function protectedPaths(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const cwd = process.cwd()
  for (const s of (await loadConsolidated()).values()) {
    const p = s.current_cwd ?? s.project_path
    if (p && inside(cwd, p)) out.set(p, 'the server working directory')
    else if (p) out.set(p, 'an active session')
  }
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
    const protectedBySession = await protectedPaths()
    const requested = new Set(ids)
    const current = planClean(await collectCleanFacts(await cleanRepos([]), { lowPriority: true }), Date.now())
      .filter(i => i.action.kind !== 'keep' && requested.has(itemId(i.facts, i.action.kind)))
    const skipped: Array<{ path: string; reason: string }> = []
    const safe: CleanItem[] = []
    for (const item of current) {
      const f = item.facts
      const session = [...protectedBySession].find(([p]) => inside(f.path, p) || inside(p, f.path))
      if (session) { skipped.push({ path: f.path, reason: session[1] }); continue }
      if (await processIn(f.path)) { skipped.push({ path: f.path, reason: 'a process is running inside it (or its location is unknown)' }); continue }
      safe.push(item)
    }
    const errors: string[] = []
    created.state = 'removing worktrees'; created.progress = 25
    errors.push(...(await applyClean(safe.filter(i => i.action.kind === 'remove'))))
    created.state = 'removing node_modules'; created.progress = 60
    errors.push(...(await applyClean(safe.filter(i => i.action.kind === 'node-modules'))))
    created.state = 'pruning'; created.progress = 85
    errors.push(...(await applyClean(safe.filter(i => i.action.kind === 'prune'))))
    created.result = { freedBytes: safe.reduce((n, i) => n + (i.action.kind === 'keep' ? 0 : i.action.frees), 0), worktrees: safe.filter(i => i.action.kind === 'remove' || i.action.kind === 'prune').length, nodeModules: safe.filter(i => i.action.kind === 'node-modules').length, skipped, errors }
    created.state = 'done'; created.progress = 100
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
  })().catch(error => { created.state = 'done'; created.progress = 100; created.result = { freedBytes: 0, worktrees: 0, nodeModules: 0, skipped: [], errors: [String(error)] } })
  return created
}
export function cleanJob(): CleanJob | null { return job }
