/**
 * perf-watch.ts — IO for `vigia-desempenho` (APP.LENTO prevention). Two host ops the engine's flow
 * wires together; the decisions are `perf-watch-plan.ts` (pure).
 *
 *  - `amostrar-desempenho` {dryRun?} — the SAMPLES of this process since the previous run (the host takes
 *    one every `SAMPLE_EVERY_MS` into a small ring once the flow has run; the flow itself runs every few
 *    minutes, so `flows/runs` gets one record per run, not one per sample), each: CPU since the previous sample (from
 *    `process.cpuUsage`), RSS, the worst event-loop lag of the window (a 250 ms drift timer), and the
 *    p95 of the REAL requests the server answered in the window, per watched route. Nothing is
 *    requested to measure it: a GET of `/api/fleet` from here would wake the fleet poller, which only
 *    polls while somebody asks — the watch would become part of the load it watches.
 *  - `capturar-desempenho` {fire[], dryRun?} — when the sample fired a budget: a CPU profile of the
 *    next `PROFILE_MS` of this process to `<data dir>/perf/<ts>.cpuprofile` (the newest `KEEP` are
 *    kept) and ONE owner notice naming the budget. At most one capture per `CAPTURE_GAP_MS`.
 *
 * It never restarts, stops or changes anything. `AGENTISTICS_PERF_WATCH=0` makes both ops refuse; the
 * flow's own toggle (`agentop flow disable vigia-desempenho`) is the setting a person uses.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { DEFAULT_PERF_BUDGETS, NOTICE_GAP_MS, SAMPLE_EVERY_MS, describeBreach, emptyPerfWatchState, evaluatePerf, p95, routeBucket, type PerfBreach, type PerfSample, type PerfWatchState } from './perf-watch-plan'

export const PERF_DIR = join(AGENTISTICS_DATA_DIR, 'perf')
export const PROFILE_MS = 10_000
export const KEEP = 10
export const CAPTURE_GAP_MS = NOTICE_GAP_MS
const LAG_TICK_MS = 250
const MAX_WINDOW = 5000

const refuse = (reason: string, missing: string[] = []) => ({ refused: true, reason, missing })
const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
export const perfWatchOff = (env: NodeJS.ProcessEnv = process.env) => ['0', 'off', 'false'].includes(String(env.AGENTISTICS_PERF_WATCH ?? '').toLowerCase())

// ── the window the next sample reads ─────────────────────────────────────────────────────────────
const latencies = new Map<string, number[]>()
/** Called by the request handler for every answered request (`index.ts`). Cheap: a push. */
export function recordRequestLatency(pathname: string, ms: number): void {
  const bucket = routeBucket(pathname)
  if (!bucket) return
  for (const key of bucket === '*' ? ['*'] : [bucket, '*']) {
    const list = latencies.get(key) ?? []
    if (list.length < MAX_WINDOW) list.push(ms)
    latencies.set(key, list)
  }
}

let lagMax = 0
let lagTimer: ReturnType<typeof setInterval> | null = null
function startLagMonitor(): void {
  if (lagTimer) return
  let expected = performance.now() + LAG_TICK_MS
  lagTimer = setInterval(() => {
    const now = performance.now()
    lagMax = Math.max(lagMax, Math.max(0, now - expected))
    expected = now + LAG_TICK_MS
  }, LAG_TICK_MS)
  lagTimer.unref?.()
}

let last: { at: number; cpu: NodeJS.CpuUsage } | null = null
let state: PerfWatchState = emptyPerfWatchState()
const RING_MAX = 40
const ring: PerfSample[] = []
let ringTimer: ReturnType<typeof setInterval> | null = null
function startRing(): void {
  if (ringTimer) return
  ringTimer = setInterval(() => { ring.push(takeSample()); if (ring.length > RING_MAX) ring.shift() }, SAMPLE_EVERY_MS)
  ringTimer.unref?.()
}

/** One sample of this process; resets the window. Exported for tests through `perfWatchHostOps`. */
export function takeSample(now = Date.now()): PerfSample {
  startLagMonitor()
  const cpu = process.cpuUsage()
  const cpuPct = last ? Math.round(((cpu.user - last.cpu.user) + (cpu.system - last.cpu.system)) / 1000 / Math.max(1, now - last.at) * 1000) / 10 : 0
  last = { at: now, cpu }
  const routes: Record<string, number | null> = {}
  for (const route of Object.keys(DEFAULT_PERF_BUDGETS.routes)) routes[route] = p95(latencies.get(route) ?? [])
  latencies.clear()
  const loopLagMaxMs = Math.round(lagMax)
  lagMax = 0
  return { at: now, cpuPct, rssMB: Math.round(process.memoryUsage().rss / 1048576), loopLagMaxMs, routes }
}

export interface PerfWatchDeps {
  /** The samples taken since the previous call, oldest first, plus one taken now. */
  samples(): PerfSample[]
  profile(ms: number): Promise<object>
  write(file: string, text: string): Promise<void>
  prune(dir: string, keep: number): Promise<void>
  notify(breaches: PerfBreach[], file: string | null): void
  now(): number
  off(): boolean
}

async function inspectorProfile(ms: number): Promise<object> {
  const { Session } = await import('node:inspector')
  const s = new Session()
  s.connect()
  const post = <T>(m: string, p: object = {}) => new Promise<T>((res, rej) => s.post(m, p, (e: Error | null, r?: object) => e ? rej(e) : res(r as T)))
  try {
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: 1000 })
    await post('Profiler.start')
    await new Promise(r => setTimeout(r, ms))
    return (await post<{ profile: object }>('Profiler.stop')).profile
  } finally { try { s.disconnect() } catch { /* already gone */ } }
}

export function defaultPerfWatchDeps(): PerfWatchDeps {
  return {
    samples: () => { startRing(); const out = ring.splice(0); out.push(takeSample()); return out },
    profile: inspectorProfile,
    write: async (file, text) => { await mkdir(PERF_DIR, { recursive: true }); await writeFile(file, text) },
    prune: async (dir, keep) => {
      const files = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.cpuprofile')).sort()
      for (const f of files.slice(0, Math.max(0, files.length - keep))) await rm(join(dir, f), { force: true })
    },
    notify: (breaches, file) => {
      void import('../sse').then(({ broadcastNotification }) => broadcastNotification({
        type: 'warning', code: 'perf.budget_broken',
        meta: { what: breaches.map(b => describeBreach(b, 'en')).join('; '), whatPt: breaches.map(b => describeBreach(b, 'pt')).join('; '), profile: file ?? '—' },
      })).catch(() => {})
    },
    now: Date.now,
    off: () => perfWatchOff(),
  }
}

let lastCapture = -Infinity
let capturing = false

export function perfWatchHostOps(d: PerfWatchDeps = defaultPerfWatchDeps()) {
  return {
    'amostrar-desempenho': async (value: unknown) => {
      if (d.off()) return refuse('the performance watch is off (AGENTISTICS_PERF_WATCH=0)')
      const samples = d.samples()
      let st = state
      const fire: PerfBreach[] = []
      let over: PerfBreach[] = []
      for (const s of samples) { const r = evaluatePerf(st, s); st = r.state; over = r.over; fire.push(...r.fire) }
      if (rec(value).dryRun !== true) state = st
      // `dryRun` is echoed so a flow that wires `capturar-desempenho` to this output stays dry end to end.
      return { ok: true, samples: samples.length, last: samples.at(-1), over, fire, dryRun: rec(value).dryRun === true }
    },
    'capturar-desempenho': async (value: unknown) => {
      if (d.off()) return refuse('the performance watch is off (AGENTISTICS_PERF_WATCH=0)')
      const fire = (Array.isArray(rec(value).fire) ? rec(value).fire : []) as PerfBreach[]
      if (fire.length === 0) return { ok: true, captured: null, reason: 'within budget' }
      if (rec(value).dryRun === true) return { ok: true, captured: null, reason: 'dry run', would: fire.map(b => b.key) }
      const now = d.now()
      // The notice is the point; a profile is evidence, rate-limited so a long incident costs one.
      let file: string | null = null
      if (!capturing && now - lastCapture >= CAPTURE_GAP_MS) {
        capturing = true
        lastCapture = now
        try {
          const profile = await d.profile(PROFILE_MS)
          file = join(PERF_DIR, `${new Date(now).toISOString().replace(/[:.]/g, '-')}.cpuprofile`)
          await d.write(file, JSON.stringify(profile))
          await d.prune(PERF_DIR, KEEP)
        } catch { file = null } finally { capturing = false }
      }
      d.notify(fire, file)
      return { ok: true, captured: file, notified: fire.map(b => b.key) }
    },
  }
}

/** Tests only. */
export function resetPerfWatch(): void { if (ringTimer) clearInterval(ringTimer); ringTimer = null; ring.length = 0; state = emptyPerfWatchState(); last = null; lastCapture = -Infinity; capturing = false; latencies.clear(); lagMax = 0 }
