/**
 * session-reaper-io.ts — the IO half of `session-reaper.ts`: read `/proc`, stop what the plan names,
 * and run the periodic pass inside `agentop server`.
 *
 * Two doors:
 *  - `stopSessionProcesses(id)` — called by a backend's `kill` right after the pane/relay is ended, so a
 *    closed session leaves nothing behind NOW (an MCP server that double-forked, a structured child whose
 *    relay had already died);
 *  - `reapClosedSessions()` — on server start and every `REAP_EVERY_MS`, for every session the registry
 *    says ended more than `REAP_GRACE_MS` ago (a retire, a hand-off, a reopen's predecessor, a crash —
 *    every path that sets `endedAt` without killing anything).
 *
 * Stopping is SIGTERM, a grace, then SIGKILL — each pid signalled only while it is still the SAME
 * process (its kernel start time is compared, `kill-escalate.ts`). Never by name. Linux only: elsewhere
 * there is no `/proc` and nothing is read or stopped.
 *
 * `AGENTISTICS_REAPER=0` turns the periodic pass off; `AGENTISTICS_REAPER=dry` makes it log and count
 * what it WOULD stop without signalling anything.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { escalateKill, procIO, startTimeOf, type EscalateIO, type PidRef } from './kill-escalate'
import { planSessionReap, reapSentence, REAP_GRACE_MS, type ReapPlan, type ReapProc } from './session-reaper'

const CLK_TCK = 100
export const REAP_EVERY_MS = 5 * 60_000

export interface ReadProc extends ReapProc {
  startTicks: string
  /** `AGENTISTICS_TEST_RUNNER_PID` from its environ — the `bun test` run that started it, if any. */
  runner?: string
}

/**
 * Under `bun test` (the preload sets the runner marker) only processes carrying THIS run's marker are
 * candidates: a test that kills session `m-1` must never reach a real process on the machine.
 */
export function hermetic(procs: ReadProc[], env: NodeJS.ProcessEnv = process.env): ReadProc[] {
  const run = env.AGENTISTICS_TEST_RUNNER_PID?.trim()
  return run ? procs.map(p => (p.runner === run ? p : { ...p, managedId: undefined })) : procs
}

function readQuiet(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/** Boot time (s since the epoch), from `/proc/stat`'s `btime`. */
function bootTimeSec(procRoot: string): number | null {
  const m = /^btime\s+(\d+)/m.exec(readQuiet(`${procRoot}/stat`) ?? '')
  return m ? Number(m[1]) : null
}

/** Wall-clock start (ms) of a live pid, or null when it is gone / unreadable. */
export function procStartMs(pid: number, procRoot = '/proc'): number | null {
  const btime = bootTimeSec(procRoot)
  const stat = readQuiet(`${procRoot}/${pid}/stat`)
  const ticks = stat ? startTimeOf(stat) : null
  return btime === null || ticks === null ? null : Math.round((btime + Number(ticks) / CLK_TCK) * 1000)
}

/** `AGENTOP_MANAGED_ID` out of a NUL-separated environ — PURE. */
export function managedIdOf(environ: string): string | undefined {
  for (const kv of environ.split('\0')) if (kv.startsWith('AGENTOP_MANAGED_ID=')) return kv.slice(19) || undefined
  return undefined
}

/**
 * Every process this uid can read, with its parent, start and (when present) session marker. Processes
 * of other users are listed without a marker (their environ is unreadable) so the subtree guard still
 * sees them. `null` off Linux or when `/proc` cannot be listed.
 */
export function readReapProcs(procRoot = '/proc'): ReadProc[] | null {
  if (process.platform !== 'linux' && procRoot === '/proc') return null
  const btime = bootTimeSec(procRoot)
  if (btime === null) return null
  let names: string[]
  try { names = readdirSync(procRoot) } catch { return null }
  const out: ReadProc[] = []
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    const stat = readQuiet(`${procRoot}/${n}/stat`)
    if (!stat) continue
    const open = stat.indexOf('('), close = stat.lastIndexOf(')')
    if (open < 0 || close < open) continue
    const f = stat.slice(close + 2).split(' ')
    const ppid = Number(f[1])
    const ticks = startTimeOf(stat)
    if (!Number.isFinite(ppid) || ticks === null) continue
    const environ = readQuiet(`${procRoot}/${n}/environ`)
    const managedId = environ ? managedIdOf(environ) : undefined
    const runner = environ ? /(?:^|\0)AGENTISTICS_TEST_RUNNER_PID=(\d+)/.exec(environ)?.[1] : undefined
    let rssBytes: number | null = null
    if (managedId) {
      const m = /^VmRSS:\s+(\d+) kB$/m.exec(readQuiet(`${procRoot}/${n}/status`) ?? '')
      rssBytes = m ? Number(m[1]) * 1024 : null
    }
    out.push({
      pid: Number(n), ppid, comm: stat.slice(open + 1, close),
      startMs: Math.round((btime + Number(ticks) / CLK_TCK) * 1000),
      startTicks: ticks,
      ...(managedId ? { managedId } : {}),
      ...(runner ? { runner } : {}),
      rssBytes,
    })
  }
  return out
}

export interface StopDeps {
  io?: EscalateIO
  term?: (pid: number) => void
  graceMs?: number
}

/** SIGTERM each (same-process check first), wait for them to go, SIGKILL the rest. */
export async function stopProcs(procs: readonly ReadProc[], d: StopDeps = {}): Promise<{ stopped: number[]; stuck: number[] }> {
  const io = d.io ?? procIO()
  const refs: PidRef[] = procs.map(p => ({ pid: p.pid, start: p.startTicks }))
  const term = d.term ?? ((pid: number) => { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } })
  for (const r of refs) if (io.alive(r)) term(r.pid)
  const { stuck } = await escalateKill(refs, io, { graceMs: d.graceMs ?? 3_000 })
  const stuckSet = new Set(stuck)
  return { stopped: refs.map(r => r.pid).filter(p => !stuckSet.has(p)), stuck }
}

const selfManagedId = (): string | undefined => process.env.AGENTOP_MANAGED_ID?.trim() || undefined

/**
 * The kill of ONE session: stop every process still carrying its marker that started before now.
 * Called after the pane/relay is gone, so the backend lists nothing live for it. Best effort, never throws.
 */
export interface SessionStop { stopped: number[]; stuck: number[]; freedBytes: number; found: Array<{ pid: number; comm: string; rssBytes: number | null }> }

export async function stopSessionProcesses(id: string, opts: { procRoot?: string; stop?: StopDeps; nowMs?: number; endedMs?: number; dryRun?: boolean; readProcs?: () => ReadProc[] | null } = {}): Promise<SessionStop> {
  const none: SessionStop = { stopped: [], stuck: [], freedBytes: 0, found: [] }
  try {
    const read = (opts.readProcs ?? (() => readReapProcs(opts.procRoot)))()
    if (!read) return none
    const procs = hermetic(read)
    const nowMs = opts.nowMs ?? Date.now()
    const plan = planSessionReap({
      procs, ended: new Map([[id, opts.endedMs ?? nowMs]]), liveIds: new Set(), nowMs, graceMs: 0,
      selfPid: process.pid, selfManagedId: selfManagedId(), onlyIds: new Set([id]),
    })
    if (plan.stop.length === 0) return none
    const targets = plan.stop as ReadProc[]
    const found = targets.map(t => ({ pid: t.pid, comm: t.comm, rssBytes: t.rssBytes ?? null }))
    if (opts.dryRun) return { stopped: [], stuck: [], freedBytes: targets.reduce((s, t) => s + (t.rssBytes ?? 0), 0), found }
    const r = await stopProcs(targets, opts.stop)
    const freedBytes = targets.filter(t => r.stopped.includes(t.pid)).reduce((s, t) => s + (t.rssBytes ?? 0), 0)
    console.log(`[reaper] session ${id}: stopped ${r.stopped.length} leftover process(es)${r.stuck.length ? `, ${r.stuck.length} would not stop` : ''}`)
    return { ...r, freedBytes, found }
  } catch { return none }
}

export interface ReapResult {
  atMs: number
  dryRun: boolean
  processes: number
  freedBytes: number
  /** Distinct sessions the stopped processes belonged to. */
  sessions: number
  stuck: number
  pids: number[]
  /** What the plan named, stopped or not (a dry run names, never stops). */
  found?: Array<{ pid: number; comm: string; sessionId: string; rssBytes: number | null }>
  /** Why the pass did nothing, when it could not judge (no /proc, backend unlisted, registry unread). */
  skippedWhy?: string
}

export interface ReapDeps {
  readProcs?: () => ReadProc[] | null
  /** Session id → endedAt (ms). */
  readEnded?: () => Promise<Map<string, number>>
  /** Ids the backend lists as alive; `null` = could not be listed (then nothing is stopped). */
  liveIds?: () => Promise<Set<string> | null>
  stop?: StopDeps
  nowMs?: number
  graceMs?: number
  dryRun?: boolean
  log?: (line: string) => void
}

async function defaultEnded(): Promise<Map<string, number>> {
  const { readRegistry } = await import('./registry')
  const out = new Map<string, number>()
  for (const m of await readRegistry()) {
    if (!m.endedAt) continue
    const t = Date.parse(m.endedAt)
    if (Number.isFinite(t)) out.set(m.id, t)
  }
  return out
}

async function defaultLiveIds(): Promise<Set<string> | null> {
  try {
    const { resolveBackend } = await import('./index')
    const backend = await resolveBackend()
    if (await backend.unavailable()) return null
    return new Set((await backend.list()).filter(s => s.alive !== false).map(s => s.id))
  } catch { return null }
}

/** One periodic pass. */
export async function reapClosedSessions(d: ReapDeps = {}): Promise<ReapResult> {
  const nowMs = d.nowMs ?? Date.now()
  const dryRun = d.dryRun ?? false
  const log = d.log ?? ((l: string) => console.log(l))
  const empty = (why: string): ReapResult => ({ atMs: nowMs, dryRun, processes: 0, freedBytes: 0, sessions: 0, stuck: 0, pids: [], skippedWhy: why })
  const read = (d.readProcs ?? (() => readReapProcs()))()
  if (!read) return empty('no /proc here')
  const procs = hermetic(read)
  if (!procs.some(p => p.managedId)) return empty('nothing carries a session marker')
  let ended: Map<string, number>
  try { ended = await (d.readEnded ?? defaultEnded)() } catch { return empty('registry unreadable') }
  const live = await (d.liveIds ?? defaultLiveIds)()
  if (live === null) return empty('backend could not be listed')
  const plan: ReapPlan = planSessionReap({
    procs, ended, liveIds: live, nowMs, graceMs: d.graceMs ?? REAP_GRACE_MS,
    selfPid: process.pid, selfManagedId: selfManagedId(),
  })
  const targets = plan.stop as ReadProc[]
  if (targets.length === 0) return { atMs: nowMs, dryRun, processes: 0, freedBytes: 0, sessions: 0, stuck: 0, pids: [] }
  const sessions = new Set(targets.map(t => t.managedId)).size
  const found = targets.map(t => ({ pid: t.pid, comm: t.comm, sessionId: t.managedId!, rssBytes: t.rssBytes ?? null }))
  if (dryRun) {
    const freedBytes = targets.reduce((s, t) => s + (t.rssBytes ?? 0), 0)
    const r: ReapResult = { atMs: nowMs, dryRun, processes: targets.length, freedBytes, sessions, stuck: 0, pids: targets.map(t => t.pid), found }
    log(`[reaper] dry run: ${reapSentence(r)} (${sessions} session(s)): ${targets.map(t => `${t.pid}:${t.comm}@${t.managedId}`).join(' ')}`)
    return r
  }
  const s = await stopProcs(targets, d.stop)
  const freedBytes = targets.filter(t => s.stopped.includes(t.pid)).reduce((sum, t) => sum + (t.rssBytes ?? 0), 0)
  const r: ReapResult = { atMs: nowMs, dryRun, processes: s.stopped.length, freedBytes, sessions, stuck: s.stuck.length, pids: s.stopped, found }
  log(`[reaper] ${reapSentence(r)} (${sessions} session(s))${s.stuck.length ? `; ${s.stuck.length} would not stop` : ''}`)
  return r
}

// ── the server's loop ─────────────────────────────────────────────────────────────────────────────

export interface ReaperState {
  enabled: boolean
  dryRun: boolean
  /** Who runs the periodic pass: the `coletor-processos` flow (flows on) or this server's own timer. */
  scheduler: 'flow' | 'server' | 'off'
  last: ReapResult | null
  totalProcesses: number
  totalFreedBytes: number
}

const state: ReaperState = { enabled: false, dryRun: false, scheduler: 'off', last: null, totalProcesses: 0, totalFreedBytes: 0 }
let timer: ReturnType<typeof setInterval> | null = null
let inFlight: Promise<ReapResult> | null = null

export function reaperState(): ReaperState { return { ...state, last: state.last ? { ...state.last } : null } }

export function reaperMode(env: NodeJS.ProcessEnv = process.env): 'off' | 'dry' | 'on' {
  const v = env.AGENTISTICS_REAPER?.trim().toLowerCase()
  return v === '0' || v === 'off' ? 'off' : v === 'dry' ? 'dry' : 'on'
}

/**
 * ONE collector pass, whoever asks — the server's timer or the `coletor-processos` flow's host op —
 * and the totals `/api/resources` reports. Concurrent callers share the pass in flight.
 */
export function collectorPass(o: { dryRun?: boolean; graceMs?: number; log?: (l: string) => void; deps?: ReapDeps } = {}): Promise<ReapResult> {
  if (inFlight) return inFlight
  const dryRun = o.dryRun ?? (reaperMode() === 'dry')
  inFlight = (async () => {
    const r = await reapClosedSessions({ ...o.deps, dryRun, ...(o.graceMs !== undefined ? { graceMs: o.graceMs } : {}), ...(o.log ? { log: o.log } : {}) })
    state.last = r
    if (!r.dryRun) { state.totalProcesses += r.processes; state.totalFreedBytes += r.freedBytes }
    return r
  })().finally(() => { inFlight = null })
  return inFlight
}

/**
 * Boot + every `REAP_EVERY_MS`. With the flows engine on (`AGENTISTICS_FLOWS=1`) the schedule is the
 * `coletor-processos` flow's (boot + periodic trigger) and this timer stays off — one scheduler, one
 * path; the server's timer is the floor for a machine with flows off.
 */
export function startSessionReaper(log: (l: string) => void = l => console.log(l), env: NodeJS.ProcessEnv = process.env): void {
  if (timer || process.platform !== 'linux') return
  const mode = reaperMode(env)
  if (mode === 'off') return
  state.enabled = true
  state.dryRun = mode === 'dry'
  if (env.AGENTISTICS_FLOWS === '1') { state.scheduler = 'flow'; return }
  state.scheduler = 'server'
  const tick = () => { void collectorPass({ dryRun: state.dryRun, log }).catch(e => log(`[reaper] pass failed: ${String(e)}`)) }
  tick()
  timer = setInterval(tick, REAP_EVERY_MS)
  timer.unref?.()
}
