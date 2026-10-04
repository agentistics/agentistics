/**
 * scripts/perf/storm.ts — the REBUILD STORM load test: N live sessions writing their transcripts
 * every `--every` ms, against a THROWAWAY server (free ports, isolated tmux, synthetic home).
 *
 *   bun scripts/perf/synth-home.ts /tmp/storm-home --scale 0.2 --big 0 --git
 *   bun scripts/perf/storm.ts /tmp/storm-home [--sessions 10] [--every 500] [--seconds 60] [--json out] [--budget]
 *
 * Owner report on v2.103.1: "está mais lento ainda, sem streaming, nem abre no celular" — the server
 * logged `[data] built in 1–2 s` every ~2 s at 134 % CPU with ~10 sessions writing, and `/api/fleet`
 * took 2.5 s. What it measures, over the load window:
 * - the server's CPU % (utime+stime from /proc over wall time);
 * - `/api/data` builds per minute (the `[data] built in` lines) and their duration;
 * - `/api/fleet` and `/api/data` p95, polled the way a dashboard does;
 * - send → echo on a live (fake) claude session, over the chat stream — it must not wait on a build.
 *
 * `--budget` fails (exit 1) when a figure exceeds its `storm*` ceiling in `budgets.json`.
 */
import { appendFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { quantiles, startPerfServer } from './server-harness.ts'
import { measurePush } from './measure.ts'

const args = process.argv.slice(2)
const home = args[0]
if (!home) { console.error('usage: storm.ts <home> [--sessions n] [--every ms] [--seconds s] [--json out] [--budget]'); process.exit(2) }
const opt = (n: string, d: number) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d }
const N = opt('sessions', 10), EVERY = opt('every', 500), SECONDS = opt('seconds', 60)
const jsonOut = (() => { const i = args.indexOf('--json'); return i >= 0 ? args[i + 1] : undefined })()
const log = (...a: unknown[]) => console.error('[storm]', ...a)

const files: { id: string; path: string; size: number }[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) { const p = join(projects, d, f); files.push({ id: f.slice(0, -6), path: p, size: statSync(p).size }) }
files.sort((a, b) => a.size - b.size)
// Ten sessions of ordinary size, spread across projects (the live fleet of a working day).
const writers = Array.from({ length: N }, (_, i) => files[Math.floor((i + 0.5) * files.length / (N + 1))]!).filter(Boolean)

const s = await startPerfServer(home, { env: { PATH: `${join(import.meta.dir, 'fake-bin')}:${process.env.PATH}` } })
const ticks = async (): Promise<number> => {
  const pid = await s.serverPid()
  try { const f = (await Bun.file(`/proc/${pid}/stat`).text()).split(') ')[1]!.split(' '); return Number(f[11]) + Number(f[12]) } catch { return NaN }
}
const builds = (): number[] => [...s.log().matchAll(/\[data\] built in (\d+) ms/g)].map(m => Number(m[1]))
const timed = async (path: string) => { const t = performance.now(); const r = await fetch(`${s.base}${path}`); await r.arrayBuffer(); return performance.now() - t }

let out: Record<string, unknown> = {}
try {
  await fetch(`${s.base}/api/data`).then(r => r.arrayBuffer())
  // A live session to measure the chat on, while the others write.
  const cwd = join(home, '..', 'work', 'storm-live'); mkdirSync(cwd, { recursive: true })
  const sp = await (await fetch(`${s.base}/api/fleet/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: 'claude', cwd, force: true, label: 'storm' }) })).json() as { id?: string }
  await Bun.sleep(3000)

  const builds0 = builds().length
  const ticks0 = await ticks(), t0 = performance.now()
  let stop = false
  let writes = 0
  const writer = (async () => {
    let k = 0
    while (!stop) {
      // Every session writes one line every EVERY ms, in the same burst — a turn lands as a burst
      // of lines, and the quiet between bursts is what lets a debounced rebuild fire.
      for (const w of writers) {
        appendFileSync(w.path, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, sessionId: w.id, timestamp: new Date().toISOString(), message: { id: `msg_${crypto.randomUUID().slice(0, 8)}`, role: 'assistant', model: 'claude-sonnet-5-5', type: 'message', content: [{ type: 'text', text: `storm ${k}` }], usage: { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } }) + '\n')
        writes++
      }
      k++
      await Bun.sleep(EVERY)
    }
  })()
  const fleet: number[] = [], data: number[] = []
  const poller = (async () => { while (!stop) { fleet.push(await timed('/api/fleet')); data.push(await timed('/api/data')); await Bun.sleep(2000) } })()
  // The chat during the storm.
  await Bun.sleep(Math.min(10_000, SECONDS * 250))
  const push = sp.id ? await measurePush(s, sp.id, 4) : null
  const left = SECONDS * 1000 - (performance.now() - t0)
  if (left > 0) await Bun.sleep(left)
  stop = true
  await Promise.all([writer, poller])
  const wall = (performance.now() - t0) / 1000
  const cpuPct = ((await ticks()) - ticks0) / 100 / wall * 100
  const during = builds().slice(builds0)
  out = {
    sessions: writers.length, everyMs: EVERY, seconds: Math.round(wall), writes,
    cpuPct: Math.round(cpuPct),
    buildsPerMin: Math.round(during.length / wall * 60 * 10) / 10,
    buildMs: quantiles(during),
    buildDutyPct: Math.round(during.reduce((a, b) => a + b, 0) / 1000 / wall * 100),
    fleet: quantiles(fleet), data: quantiles(data),
    sendToEcho: push?.sendToEcho ?? null,
    answerShown: push?.harnessWriteToShown ?? null,
  }
  if (sp.id) await fetch(`${s.base}/api/fleet/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sp.id, action: 'kill' }) }).catch(() => {})
} finally {
  await s.stop()
}
const json = JSON.stringify(out, null, 2)
console.log(json)
if (jsonOut) await Bun.write(jsonOut, json)

if (args.includes('--budget')) {
  const b = await Bun.file(join(import.meta.dir, 'budgets.json')).json() as Record<string, number>
  const m: Record<string, number | null> = {
    stormCpuPct: out.cpuPct as number,
    stormBuildP50Ms: (out.buildMs as { p50: number; n: number }).n ? (out.buildMs as { p50: number }).p50 : null,
    stormBuildDutyPct: out.buildDutyPct as number,
    stormFleetP95Ms: (out.fleet as { p95: number }).p95,
    stormDataP95Ms: (out.data as { p95: number }).p95,
    stormEchoP95Ms: (out.sendToEcho as { p95: number; n: number } | null)?.n ? (out.sendToEcho as { p95: number }).p95 : null,
  }
  let failed = 0
  for (const [k, v] of Object.entries(m)) {
    const ceiling = b[k]
    if (ceiling === undefined) continue
    const verdict = v === null || Number.isNaN(v) ? 'SKIPPED' : v <= ceiling ? 'ok' : 'OVER'
    if (verdict !== 'ok') failed++
    console.log(`${verdict.padEnd(7)} ${k.padEnd(22)} ${String(v ?? '—').padStart(7)}  ≤ ${ceiling}`)
  }
  if (failed) { console.error(`\n${failed} storm budget(s) not met.`); process.exit(1) }
  console.log('\nThe storm budgets hold.')
}
log('done')
