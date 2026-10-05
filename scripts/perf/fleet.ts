/**
 * scripts/perf/fleet.ts — `/api/fleet` latency with many live (fake) sessions, over a throwaway server.
 *
 *   bun scripts/perf/synth-home.ts /tmp/fleet-home --scale 0.3 --big 0
 *   bun scripts/perf/fleet.ts /tmp/fleet-home [--sessions 20] [--calls 8] [--profile]
 *
 * The owner's real server answered `/api/fleet` in 2.9 s (125 KB br) while `/api/data` took 0.13 s: the
 * sessions list is what makes the UI feel slow. Prints cold and warm latency (p50/max) of the call the
 * dashboard polls every 5 s; `--profile` prints the server's own per-phase stopwatch.
 */
import { join } from 'node:path'
import { mkdirSync, readdirSync } from 'node:fs'
import { quantiles, startPerfServer } from './server-harness.ts'

const args = process.argv.slice(2)
const home = args[0]
if (!home) { console.error('usage: fleet.ts <home> [--sessions n] [--calls n] [--profile]'); process.exit(2) }
const opt = (n: string, d: number) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d }
const N = opt('sessions', 20), CALLS = opt('calls', 8)
const files: string[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) files.push(join(projects, d, f))

const s = await startPerfServer(home, { env: { PATH: `${join(import.meta.dir, 'fake-bin')}:${process.env.PATH}`, ...(args.includes('--profile') ? { AGENTISTICS_PROFILE_FLEET: '1' } : {}) } })
const timed = async () => { const t = performance.now(); const r = await fetch(`${s.base}/api/fleet`); const b = await r.arrayBuffer(); return { ms: performance.now() - t, kb: b.byteLength / 1024 } }
try {
  await fetch(`${s.base}/api/data`).then(r => r.arrayBuffer())
  let made = 0
  for (let i = 0; i < N; i++) {
    const cwd = join(home, '..', 'work', `fleet-live-${i}`); mkdirSync(cwd, { recursive: true })
    await Bun.write(join(cwd, '.fake-seed'), files[i % files.length]!)
    const r = await fetch(`${s.base}/api/fleet/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: 'claude', cwd, force: true, label: `live-${i}` }) }).then(r => r.json()).catch(() => ({})) as { ok?: boolean }
    if (r.ok) made++
  }
  await Bun.sleep(4000)
  const cold = await timed()
  const warm: number[] = []
  for (let i = 0; i < CALLS; i++) { warm.push((await timed()).ms); await Bun.sleep(1200) } // past the 1 s memo, like a poll
  const rows = (await (await fetch(`${s.base}/api/fleet`)).json() as { rows: unknown[] }).rows.length
  console.log(JSON.stringify({ liveCreated: made, rows, coldMs: Math.round(cold.ms), kb: Math.round(cold.kb), warm: quantiles(warm), warmMax: Math.round(Math.max(...warm)) }))
  if (args.includes('--profile')) console.log(s.log().split('\n').filter(l => l.includes('[fleet-profile]')).slice(-45).join('\n'))
} finally { await s.stop() }
