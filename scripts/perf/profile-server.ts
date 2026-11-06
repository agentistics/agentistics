/**
 * scripts/perf/profile-server.ts — a CPU PROFILE of a throwaway server over a copied home (APP.LENTO).
 *
 * `idle-cpu.ts` says HOW MUCH CPU the server burns; this says WHERE. It starts `bun --cpu-prof` on the
 * server itself (foreground, its own ports, tmux isolated), optionally appends to the newest transcripts
 * the way live sessions do and polls the routes a dashboard polls, and writes the profile (plus a
 * markdown digest) when the run ends.
 *
 *   bun scripts/perf/profile-server.ts <copied-home> [--seconds 60] [--warm 30] [--writers 4] [--every 1000] [--clients 0] [--out dir]
 *
 * Never the real $HOME, never the real ports (47291/47292).
 */
import { spawn } from 'bun'
import { appendFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const home = args[0]
if (!home || home === homedir() || home === process.env.HOME && !process.env.AGENTISTICS_THROWAWAY) {
  if (!home) { console.error('usage: profile-server.ts <copied-home> [...]'); process.exit(2) }
}
if (home === homedir()) { console.error('refusing the real $HOME'); process.exit(2) }
const opt = (n: string, d: number) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d }
const sopt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? String(args[i + 1]) : d }
const SECONDS = opt('seconds', 60), WARM = opt('warm', 30), WRITERS = opt('writers', 0), EVERY = opt('every', 1000), CLIENTS = opt('clients', 0)
const OUT = sopt('out', join(home, '..', 'prof'))
mkdirSync(OUT, { recursive: true })
const REPO = join(import.meta.dir, '..', '..')
const port = Number(process.env.PORT) && Number(process.env.PORT) !== 47291 ? Number(process.env.PORT) : 47_600 + Math.floor(Math.random() * 200) * 2
if (port === 47291 || port === 47292 || port + 1 === 47291) { console.error('refusing the real ports'); process.exit(2) }

let out = ''
const proc = spawn([process.execPath, '--cpu-prof', `--cpu-prof-dir=${OUT}`, '--cpu-prof-md', join(REPO, 'packages/server/bin/cli.ts'), 'server', '--port', String(port)], {
  cwd: REPO,
  env: {
    ...process.env, HOME: home, USERPROFILE: home, AGENTISTICS_DIR: join(home, '.agentistics'), TMUX_TMPDIR: join(home, '..', 'tmux'),
    VOLTA_HOME: process.env.VOLTA_HOME ?? join(homedir(), '.volta'), PORT: String(port), WEB_PORT: String(port + 1), AGENTISTICS_SERVER_FOREGROUND: '1', AGENTISTICS_TELEMETRY: '0',
    AGENTISTICS_JOURNAL_BACKFILL: '0', INVOCATION_ID: '', SERVE_STATIC: '1',
  },
  stdout: 'pipe', stderr: 'pipe',
})
mkdirSync(join(home, '..', 'tmux'), { recursive: true })
const logFile = join(OUT, 'server.log')
const drain = async (s: ReadableStream<Uint8Array>) => { const d = new TextDecoder(); for await (const c of s) { const t = d.decode(c); out += t; appendFileSync(logFile, t) } }
void drain(proc.stdout as ReadableStream<Uint8Array>); void drain(proc.stderr as ReadableStream<Uint8Array>)
const base = `http://127.0.0.1:${port}`
for (let i = 0; i < 2400; i++) {
  if (proc.exitCode !== null) { console.error(`server exited ${proc.exitCode} (signal ${proc.signalCode})`, out.slice(-3000)); process.exit(1) }
  try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) break } catch { /* not yet */ }
  await Bun.sleep(50)
}
const ticks = async () => { const f = (await Bun.file(`/proc/${proc.pid}/stat`).text()).split(') ')[1]!.split(' '); return Number(f[11]) + Number(f[12]) }
const rss = async () => Number((await Bun.file(`/proc/${proc.pid}/status`).text()).match(/VmRSS:\s+(\d+)/)?.[1] ?? 0)

// Writers: the newest transcripts, appended like a live session.
const files: { f: string; m: number }[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) { try { for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) files.push({ f: join(projects, d, f), m: statSync(join(projects, d, f)).mtimeMs }) } catch { /* not a dir */ } }
files.sort((a, b) => b.m - a.m)
const writers = files.slice(0, WRITERS).map(x => x.f)

await fetch(`${base}/api/data`).then(r => r.arrayBuffer()).catch(() => {})
await Bun.sleep(WARM * 1000)
// Quiet window: nothing writes, nobody asks — the idle CPU the owner's machine pays with no change.
const q0 = await ticks(), qw = performance.now()
await Bun.sleep(30_000)
const quietCpuPct = ((await ticks()) - q0) / 100 / ((performance.now() - qw) / 1000) * 100
let n = 0
const wt = WRITERS > 0 ? setInterval(() => {
  for (const f of writers) appendFileSync(f, JSON.stringify({ type: 'user', sessionId: 'prof', uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: `turn ${n++}` } }) + '\n')
}, EVERY) : null
const lat: Record<string, number[]> = {}
let stop = false
const poll = async (path: string, every: number) => {
  while (!stop) {
    const t = performance.now()
    try { await fetch(`${base}${path}`).then(r => r.arrayBuffer()) } catch { /* counted as slow */ }
    ;(lat[path] ??= []).push(performance.now() - t)
    await Bun.sleep(every)
  }
}
const pollers = Array.from({ length: CLIENTS }, () => [
  poll('/api/fleet?lang=en&format=compact-v1&closed=60', 5000),
  poll('/api/tasks', 15000),
]).flat()
// A cheap route asked every second: its latency IS the event loop's lag as a client feels it.
pollers.push(poll('/api/version', 1000))
const t0 = await ticks(), w0 = performance.now()
await Bun.sleep(SECONDS * 1000)
stop = true
if (wt) clearInterval(wt)
const cpuPct = ((await ticks()) - t0) / 100 / ((performance.now() - w0) / 1000) * 100
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN) }
const builds = [...out.matchAll(/\[data\] built in (\d+) ms/g)].map(m => Number(m[1]))
console.log(JSON.stringify({ seconds: SECONDS, writers: WRITERS, clients: CLIENTS, quietCpuPct: Math.round(quietCpuPct * 10) / 10, cpuPct: Math.round(cpuPct * 10) / 10, rssMB: Math.round(await rss() / 1024), builds: builds.length, buildsLast: builds.slice(-5),
  latency: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { p50: q(v, 0.5), p95: q(v, 0.95), n: v.length }]))}))
proc.kill('SIGINT')
const deadline = Date.now() + 30_000
while (proc.exitCode === null && Date.now() < deadline) await Bun.sleep(200)
if (proc.exitCode === null) proc.kill('SIGKILL')
console.log(`profile in ${OUT}`)
await Promise.all(pollers.map(p => Promise.race([p, Bun.sleep(1)])))
process.exit(0)
