/**
 * live-memory-lib.ts — the arithmetic of LIVE.4's 24 h memory measurement (spec
 * `2026-10-02-live-sessions-from-journal` §6 C5 and the owner's Q6, delegated to the leader):
 *
 *   default-on ONLY if, on THIS machine over 24 h, the server with the live/projection flags on shows
 *   <= +150 MB RSS over the flags-off baseline, a slope indistinguishable from zero, a peak < 1 GB and a
 *   probe latency that is not worse. Otherwise the feature stays opt-in.
 *
 * PURE: procfs text and samples in, a verdict out. `live-memory-measure.ts` is the sampler/CLI.
 */

export interface Sample {
  at: string
  rssKb: number
  swapKb: number
  threads: number
  /** utime + stime, clock ticks. */
  cpuTicks: number
  /** Round trip of the probe request (ms); null when it failed. */
  latencyMs: number | null
}

/** The owner's thresholds. `slopeMBPerHour` is what "indistinguishable from zero" means in practice. */
export const GATE = { deltaMB: 150, slopeMBPerHour: 5, peakMB: 1024, warmupMin: 60, minHours: 24 } as const

export function parseProcStatus(text: string): { rssKb: number; swapKb: number; threads: number } | null {
  const num = (k: string): number | null => { const m = new RegExp(`^${k}:\\s*(\\d+)`, 'm').exec(text); return m ? Number(m[1]) : null }
  const rss = num('VmRSS'), threads = num('Threads')
  if (rss === null || threads === null) return null
  return { rssKb: rss, swapKb: num('VmSwap') ?? 0, threads }
}

/** utime+stime from `/proc/<pid>/stat`: after the LAST ')' (the command name may hold spaces and parens), fields 14 and 15. */
export function parseProcStat(text: string): number | null {
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ')
  const u = Number(rest[11]), s = Number(rest[12])
  return Number.isFinite(u) && Number.isFinite(s) ? u + s : null
}

export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null
  const v = [...xs].sort((a, b) => a - b)
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!
}

/** Least-squares slope of RSS over time, MB per hour. */
export function slopeMBPerHour(s: readonly Sample[]): number | null {
  if (s.length < 2) return null
  const t = s.map(x => Date.parse(x.at) / 3_600_000), y = s.map(x => x.rssKb / 1024)
  const mt = t.reduce((a, b) => a + b, 0) / t.length, my = y.reduce((a, b) => a + b, 0) / y.length
  let num = 0, den = 0
  for (let i = 0; i < t.length; i++) { num += (t[i]! - mt) * (y[i]! - my); den += (t[i]! - mt) ** 2 }
  return den === 0 ? null : num / den
}

const HEADER = 'at,rssKb,swapKb,threads,cpuTicks,latencyMs'
export const sampleToCsv = (s: readonly Sample[]): string =>
  [HEADER, ...s.map(x => [x.at, x.rssKb, x.swapKb, x.threads, x.cpuTicks, x.latencyMs ?? ''].join(','))].join('\n') + '\n'

export function parseCsv(text: string): Sample[] {
  return text.trim().split('\n').slice(1).filter(Boolean).map(l => {
    const [at, rss, swap, th, cpu, lat] = l.split(',')
    return { at: at!, rssKb: Number(rss), swapKb: Number(swap), threads: Number(th), cpuTicks: Number(cpu), latencyMs: lat === '' || lat === undefined ? null : Number(lat) }
  })
}

export interface Check { name: 'delta' | 'slope' | 'peak' | 'latency' | 'duration'; ok: boolean; detail: string }
export interface Report {
  samples: number
  hours: number
  steadyMB: number | null
  baselineMB: number | null
  deltaMB: number | null
  slopeMBPerHour: number | null
  peakMB: number | null
  latencyP95Ms: number | null
  baselineLatencyP95Ms: number | null
  cpuTicksPerMin: number | null
  checks: Check[]
  verdict: 'pass' | 'fail' | 'incomplete'
}

const median = (xs: number[]): number | null => percentile(xs, 0.5)
const afterWarmup = (s: readonly Sample[]): Sample[] => {
  if (s.length === 0) return []
  const t0 = Date.parse(s[0]!.at)
  return s.filter(x => Date.parse(x.at) - t0 >= GATE.warmupMin * 60_000)
}
const hoursOf = (s: readonly Sample[]): number => (s.length < 2 ? 0 : (Date.parse(s.at(-1)!.at) - Date.parse(s[0]!.at)) / 3_600_000)

export function report(run: readonly Sample[], o: { baseline?: readonly Sample[] }): Report {
  const steady = afterWarmup(run)
  const steadyMB = median(steady.map(x => x.rssKb / 1024))
  const base = o.baseline ? afterWarmup(o.baseline) : []
  const baselineMB = base.length > 0 ? median(base.map(x => x.rssKb / 1024)) : null
  const deltaMB = steadyMB !== null && baselineMB !== null ? steadyMB - baselineMB : null
  const slope = slopeMBPerHour(steady)
  const peakMB = run.length > 0 ? Math.max(...run.map(x => x.rssKb / 1024)) : null
  const lat = percentile(steady.flatMap(x => (x.latencyMs === null ? [] : [x.latencyMs])), 0.95)
  const baseLat = percentile(base.flatMap(x => (x.latencyMs === null ? [] : [x.latencyMs])), 0.95)
  const hours = hoursOf(run)
  const cpu = run.length >= 2 ? (run.at(-1)!.cpuTicks - run[0]!.cpuTicks) / Math.max(1, hours * 60) : null

  const checks: Check[] = []
  checks.push({ name: 'duration', ok: hours >= GATE.minHours - 0.5, detail: `${hours.toFixed(1)} h measured, the gate asks ${GATE.minHours} h` })
  if (deltaMB !== null) checks.push({ name: 'delta', ok: deltaMB <= GATE.deltaMB, detail: `${deltaMB.toFixed(0)} MB over the baseline (limit +${GATE.deltaMB} MB)` })
  if (slope !== null) checks.push({ name: 'slope', ok: Math.abs(slope) <= GATE.slopeMBPerHour, detail: `${slope.toFixed(2)} MB/h after warm-up (limit ±${GATE.slopeMBPerHour})` })
  if (peakMB !== null) checks.push({ name: 'peak', ok: peakMB < GATE.peakMB, detail: `${peakMB.toFixed(0)} MB peak (limit ${GATE.peakMB} MB)` })
  if (lat !== null && baseLat !== null) checks.push({ name: 'latency', ok: lat <= baseLat * 1.1 + 5, detail: `p95 ${lat.toFixed(0)} ms vs baseline ${baseLat.toFixed(0)} ms (10% / 5 ms tolerance)` })

  const durationOk = checks.find(c => c.name === 'duration')!.ok
  const verdict: Report['verdict'] = deltaMB === null || !durationOk
    ? 'incomplete'
    : checks.every(c => c.ok) ? 'pass' : 'fail'
  return { samples: run.length, hours, steadyMB, baselineMB, deltaMB, slopeMBPerHour: slope, peakMB, latencyP95Ms: lat, baselineLatencyP95Ms: baseLat, cpuTicksPerMin: cpu, checks, verdict }
}
