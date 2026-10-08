/**
 * scripts/perf/idle-cpu.ts — the server's CPU while sessions WRITE and nobody is LOOKING (PERF.1 step 1).
 *
 * `storm.ts` measures the server with a dashboard open (it polls /api/fleet and /api/data and streams a
 * terminal). This measures the other half of the owner's report — the machine sitting there with a few
 * assistants working: a throwaway server over a synthetic home, `--sessions` transcripts appended every
 * `--every` ms, no client at all, CPU from /proc (utime+stime over wall time).
 *
 *   bun scripts/perf/idle-cpu.ts <synthetic-home> [--sessions 3] [--every 1000] [--seconds 60] [--warm 20]
 */
import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { startPerfServer } from './server-harness.ts'

const args = process.argv.slice(2)
const home = args[0]
if (!home) { console.error('usage: idle-cpu.ts <home> [--sessions n] [--every ms] [--seconds s] [--warm s]'); process.exit(2) }
const opt = (n: string, d: number) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d }
const N = opt('sessions', 3), EVERY = opt('every', 1000), SECONDS = opt('seconds', 60), WARM = opt('warm', 20)

const files: string[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) files.push(join(projects, d, f))
files.sort((a, b) => statSync(a).size - statSync(b).size)
const writers = Array.from({ length: N }, (_, i) => files[Math.floor((i + 0.5) * files.length / (N + 1))]!)

const s = await startPerfServer(home)
const ticks = async (): Promise<number> => {
  const pid = await s.serverPid()
  const f = (await Bun.file(`/proc/${pid}/stat`).text()).split(') ')[1]!.split(' ')
  return Number(f[11]) + Number(f[12])
}
const hz = 100
try {
  // One request so the first build has happened, then let the boot settle.
  await fetch(`${s.base}/api/data`).then(r => r.arrayBuffer())
  await Bun.sleep(WARM * 1000)
  const quiet0 = await ticks(), q0 = performance.now()
  await Bun.sleep(10_000)
  const quietPct = ((await ticks()) - quiet0) / hz / ((performance.now() - q0) / 1000) * 100

  const builds0 = [...s.log().matchAll(/\[data\] built in/g)].length
  const t0 = await ticks(), w0 = performance.now()
  let n = 0
  const timer = setInterval(() => {
    for (const f of writers) appendFileSync(f, JSON.stringify({ type: 'user', sessionId: 'idle', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: `turn ${n++}` } }) + '\n')
  }, EVERY)
  await Bun.sleep(SECONDS * 1000)
  clearInterval(timer)
  const wall = (performance.now() - w0) / 1000
  const cpuPct = ((await ticks()) - t0) / hz / wall * 100
  const builds = [...s.log().matchAll(/\[data\] built in (\d+) ms/g)].slice(builds0).map(m => Number(m[1]))
  console.log(JSON.stringify({ sessions: N, everyMs: EVERY, seconds: SECONDS, quietCpuPct: Math.round(quietPct * 10) / 10, cpuPct: Math.round(cpuPct * 10) / 10, builds: builds.length, buildMsP50: builds.sort((a, b) => a - b)[Math.floor(builds.length / 2)] ?? null }))
} finally {
  await s.stop()
}
process.exit(0)
