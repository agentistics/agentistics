/**
 * scripts/perf/clients.ts — server CPU against N simulated WEB CLIENTS while sessions write.
 *
 *   bun scripts/perf/synth-home.ts /tmp/clients-home --scale 0.3 --big 0
 *   bun scripts/perf/clients.ts /tmp/clients-home [--clients 10] [--sessions 10] [--every 500] [--seconds 30]
 *
 * Owner report on v2.104.x: the real server burned ~134 % of a core with 13 web connections open (6
 * tabs here + 7 from another notebook), only ~2 data builds in the window. A client is what a tab is:
 * the `/api/events` stream, a refetch of `/api/data?partial=1` on every `change`, and `/api/fleet` every
 * 5 s — with the browser's own `Accept-Encoding`. Prints the server's CPU %, how many full responses it
 * sent, how many were 304, and the bytes on the wire.
 */
import { appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { startPerfServer } from './server-harness.ts'

const args = process.argv.slice(2)
const home = args[0]
if (!home) { console.error('usage: clients.ts <home> [--clients n] [--sessions n] [--every ms] [--seconds s]'); process.exit(2) }
const opt = (n: string, d: number) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d }
const CLIENTS = opt('clients', 10), N = opt('sessions', 10), EVERY = opt('every', 500), SECONDS = opt('seconds', 30)

const files: { id: string; path: string; size: number }[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) { const p = join(projects, d, f); files.push({ id: f.slice(0, -6), path: p, size: Bun.file(p).size }) }
files.sort((a, b) => a.size - b.size)
const writers = Array.from({ length: N }, (_, i) => files[Math.floor((i + 0.5) * files.length / (N + 1))]!).filter(Boolean)

const s = await startPerfServer(home, {})
const ticks = async (): Promise<number> => {
  const pid = await s.serverPid()
  try { const f = (await Bun.file(`/proc/${pid}/stat`).text()).split(') ')[1]!.split(' '); return Number(f[11]) + Number(f[12]) } catch { return NaN }
}
let out: Record<string, unknown> = {}
try {
  await fetch(`${s.base}/api/data`).then(r => r.arrayBuffer())
  await Bun.sleep(3000)
  let stop = false
  const stats = { dataFull: 0, data304: 0, dataBytes: 0, fleet: 0, changes: 0 }
  const ctl = new AbortController()
  const client = async () => {
    let etag: string | null = null
    const refetch = async () => {
      const r = await fetch(`${s.base}/api/data?partial=1`, { headers: etag ? { 'If-None-Match': etag } : {}, signal: ctl.signal }).catch(() => null)
      if (!r) return
      if (r.status === 304) { stats.data304++; return }
      etag = r.headers.get('etag')
      stats.dataBytes += (await r.arrayBuffer()).byteLength
      stats.dataFull++
    }
    await refetch()
    void (async () => { while (!stop) { await fetch(`${s.base}/api/fleet`, { signal: ctl.signal }).then(r => r.arrayBuffer()).catch(() => {}); stats.fleet++; await Bun.sleep(5000) } })()
    const res = await fetch(`${s.base}/api/events`, { signal: ctl.signal }).catch(() => null)
    if (!res?.body) return
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
    try {
      for (;;) {
        const r = await reader.read(); if (r.done) break
        buf += dec.decode(r.value)
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          if (/^event: change$/m.test(block)) { stats.changes++; await refetch() }
        }
      }
    } catch { /* aborted */ }
  }
  for (let i = 0; i < CLIENTS; i++) void client()
  await Bun.sleep(1500)
  const ticks0 = await ticks(), t0 = performance.now()
  const w = (async () => {
    while (!stop) {
      for (const f of writers) appendFileSync(f.path, JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, sessionId: f.id, timestamp: new Date().toISOString(), message: { id: `msg_${crypto.randomUUID()}`, role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n')
      await Bun.sleep(EVERY)
    }
  })()
  await Bun.sleep(SECONDS * 1000)
  stop = true
  const wall = (performance.now() - t0) / 1000
  const cpuPct = ((await ticks()) - ticks0) / 100 / wall * 100
  ctl.abort()
  await w
  const builds = [...s.log().matchAll(/\[data\] built in (\d+) ms/g)].length
  out = { clients: CLIENTS, seconds: Math.round(wall), cpuPct: Math.round(cpuPct), ...stats, MBonWire: Math.round(stats.dataBytes / 1e5) / 10, builds }
} finally { await s.stop() }
console.log(JSON.stringify(out))
