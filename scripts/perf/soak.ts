/**
 * scripts/perf/soak.ts — the server under a steady, realistic load for a while, sampling what it
 * holds (PERF.1 step 4). A THROWAWAY server over a synthetic home, never the running one.
 *
 *   bun scripts/perf/soak.ts /tmp/agentistics-perf/synth [--minutes 15]
 *
 * Load: two dashboards (an /api/events stream each, refetching /api/data on every `change`), one open
 * live chat (push stream) on a fake claude answering a prompt every 20 s, a transcript append every
 * 2 s somewhere in the home, and a historic session opened every 5 s. The server logs `[mem]` every
 * 30 s (AGENTISTICS_PERF_MEM); the script prints those lines and the RSS trend.
 */
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { startPerfServer } from './server-harness.ts'

const args = process.argv.slice(2)
const home = args[0]
if (!home) { console.error('usage: soak.ts <home> [--minutes n]'); process.exit(2) }
const mi = args.indexOf('--minutes')
const MINUTES = mi >= 0 ? Number(args[mi + 1]) : 15

const files: string[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) files.push(join(projects, d, f))

const s = await startPerfServer(home, { env: { AGENTISTICS_PERF_MEM: '30', PATH: `${join(import.meta.dir, 'fake-bin')}:${process.env.PATH}` } })
await fetch(`${s.base}/api/data`).then(r => r.text())
const stop = Date.now() + MINUTES * 60_000
const ctl = new AbortController()
const rss: { min: number; mb: number }[] = []
const t0 = Date.now()

// two dashboards
for (let k = 0; k < 2; k++) void (async () => {
  const res = await fetch(`${s.base}/api/events`, { signal: ctl.signal })
  const r = res.body!.getReader(); const dec = new TextDecoder()
  try { for (;;) { const c = await r.read(); if (c.done) break; if (dec.decode(c.value).includes('event: change')) await fetch(`${s.base}/api/data`).then(x => x.text()) } } catch { /* stopped */ }
})()

// one live chat
const cwd = join(home, '..', 'work', 'soak-live'); mkdirSync(cwd, { recursive: true })
const sp = await (await fetch(`${s.base}/api/fleet/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: 'claude', cwd, force: true, label: 'soak' }) })).json() as { id?: string; session?: { id: string } }
const id = sp.id ?? sp.session?.id
if (id) void (async () => { try { const r = (await fetch(`${s.base}/api/fleet/chat-stream?id=${id}&lang=en`, { signal: ctl.signal })).body!.getReader(); for (;;) { if ((await r.read()).done) break } } catch { /* stopped */ } })()

let n = 0
while (Date.now() < stop) {
  n++
  const f = files[n % files.length]!
  appendFileSync(f, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: `soak ${n}` } }) + '\n')
  if (n % 3 === 0) { const h = files[(n * 7) % files.length]!; await fetch(`${s.base}/api/claude-sessions/${basename(h, '.jsonl')}?encodedDir=${encodeURIComponent(basename(dirname(h)))}&limit=150`).then(r => r.text()).catch(() => {}) }
  if (id && n % 10 === 0) await fetch(`${s.base}/api/fleet/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'prompt', text: `soak prompt ${n}` }) }).catch(() => {})
  if (n % 30 === 0) { rss.push({ min: Math.round((Date.now() - t0) / 6000) / 10, mb: Math.round((await s.rssKb()) / 1024) }); console.error('[soak]', rss[rss.length - 1]) }
  await Bun.sleep(2000)
}
ctl.abort()
if (id) await fetch(`${s.base}/api/fleet/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'kill' }) }).catch(() => {})
console.log(s.log().split('\n').filter(l => l.startsWith('[mem]')).join('\n'))
console.log(JSON.stringify({ minutes: MINUTES, rss }))
await s.stop()
