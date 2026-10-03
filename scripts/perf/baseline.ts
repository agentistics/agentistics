/**
 * scripts/perf/baseline.ts — PERF.1's baseline: measured against a THROWAWAY server over a synthetic
 * (or copied) home, never the running one.
 *
 *   bun scripts/perf/synth-home.ts /tmp/agentistics-perf/synth
 *   bun scripts/perf/baseline.ts /tmp/agentistics-perf/synth [--boots 3] [--json out.json]
 *
 * What it measures (p50/p95 where it repeats):
 * - boot: spawn → listening, → /api/health, → first /api/data built ([boot] lines);
 * - /api/data: cold (the first request after boot) and warm, and its size;
 * - opening a HISTORIC session: GET /api/claude-sessions/:id for a median, a p90 and the largest transcript;
 * - a LIVE CLI session (a fake `claude`, `fake-claude.ts`, in an isolated tmux), seeded with a long history:
 *   - open: the first /api/fleet/chat;
 *   - send → echo: `act prompt` → the first chat read that holds the user turn, reading the way the web
 *     does today (a read right after the send, then every 3 s);
 *   - harness writes the answer → the chat shows it, read the same way;
 *   - the server's own cost of one /api/fleet/chat;
 * - /api/events: a transcript append → the `change` event;
 * - server RSS at the end.
 */
import { readdirSync, statSync, appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { quantiles, startPerfServer, type PerfServer } from './server-harness.ts'

const args = process.argv.slice(2)
const home = args[0]
if (!home) { console.error('usage: baseline.ts <home> [--boots n] [--json out]'); process.exit(2) }
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const BOOTS = Number(opt('boots') ?? 3)
const WEB_POLL_MS = 3000
const out: Record<string, unknown> = { home, at: new Date().toISOString(), machine: { cpus: navigator.hardwareConcurrency } }
const log = (...a: unknown[]) => console.error('[perf]', ...a)

async function timed<T>(f: () => Promise<T>): Promise<[number, T]> { const t = performance.now(); const r = await f(); return [performance.now() - t, r] }
async function get(s: PerfServer, path: string): Promise<{ ms: number; bytes: number; status: number; text: string }> {
  const [ms, r] = await timed(async () => { const res = await fetch(`${s.base}${path}`); const text = await res.text(); return { status: res.status, text } })
  return { ms, bytes: r.text.length, status: r.status, text: r.text }
}

/** Send → echo and harness write → shown, over the chat stream; null when the server has no stream. */
async function measurePush(s: PerfServer, id: string): Promise<unknown> {
  const ctl = new AbortController()
  const res = await fetch(`${s.base}/api/fleet/chat-stream?id=${id}&lang=en`, { signal: ctl.signal }).catch(() => null)
  if (!res || res.status !== 200 || !res.body) return null
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const frames: { at: number; data: string }[] = []
  let first = NaN
  const t0 = performance.now()
  void (async () => {
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        buf += dec.decode(r.value)
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          if (/^event: chat(-delta)?$/m.test(block)) { if (Number.isNaN(first)) first = performance.now() - t0; frames.push({ at: Date.now(), data: block }) }
        }
      }
    } catch { /* aborted */ }
  })()
  for (let i = 0; i < 100 && Number.isNaN(first); i++) await Bun.sleep(20)
  // The in-flight text: the terminal stream the chat scrapes for the turn being written.
  const term: { at: number; data: string }[] = []
  const tres = await fetch(`${s.base}/api/fleet/stream?id=${id}`, { signal: ctl.signal }).catch(() => null)
  if (tres?.body) {
    const tr = tres.body.getReader()
    const td = new TextDecoder()
    void (async () => { try { for (;;) { const r = await tr.read(); if (r.done) break; term.push({ at: Date.now(), data: td.decode(r.value) }) } } catch { /* aborted */ } })()
  }
  const echo: number[] = [], answer: number[] = [], inflight: number[] = []
  for (let k = 0; k < 6; k++) {
    const marker = `pushmark${k}x${Date.now()}`
    const tSend = Date.now()
    const from = frames.length
    await fetch(`${s.base}/api/fleet/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'prompt', text: marker }) })
    const deadline = Date.now() + 15_000
    let e = false, a = false
    while ((!e || !a) && Date.now() < deadline) {
      for (const f of frames.slice(from)) {
        if (!e && f.data.includes(`${marker} writtenAt=`)) {
          echo.push(f.at - tSend); e = true
          // the harness starts printing the answer right after it writes the user turn
          const userAt = Number(f.data.match(new RegExp(`${marker} writtenAt=(\\d+)`))?.[1])
          const shown = term.find(t => t.data.includes(`answer to ${marker}`))
          if (shown && userAt) inflight.push(shown.at - userAt)
          else if (userAt) void (async () => { for (let w = 0; w < 300; w++) { const t2 = term.find(t => t.data.includes(`answer to ${marker}`)); if (t2) { inflight.push(t2.at - userAt); return } await Bun.sleep(5) } })()
        }
        const m = f.data.match(new RegExp(`answer to ${marker}[^"]*writtenAt=(\\d+)`))
        if (!a && m) { answer.push(f.at - Number(m[1])); a = true }
      }
      await Bun.sleep(5)
    }
    await Bun.sleep(300)
  }
  ctl.abort()
  return { firstFrameMs: Math.round(first), sendToEcho: quantiles(echo), harnessWriteToShown: quantiles(answer), inflightTextShown: quantiles(inflight) }
}

// ── transcripts by size ─────────────────────────────────────────────────────────────────────────
const all: { id: string; path: string; size: number }[] = []
const projects = join(home, '.claude', 'projects')
for (const d of readdirSync(projects)) for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) { const p = join(projects, d, f); all.push({ id: f.slice(0, -6), path: p, size: statSync(p).size }) }
all.sort((a, b) => a.size - b.size)
const bySize = { median: all[Math.floor(all.length / 2)]!, p90: all[Math.floor(all.length * 0.9)]!, max: all[all.length - 1]! }
out.home_shape = { transcripts: all.length, totalMB: Math.round(all.reduce((n, a) => n + a.size, 0) / 1048576), medianMB: +(bySize.median.size / 1048576).toFixed(1), p90MB: +(bySize.p90.size / 1048576).toFixed(1), maxMB: +(bySize.max.size / 1048576).toFixed(1) }

// ── 1. boot and /api/data cold ─────────────────────────────────────────────────────────────────
const boots: { listening: number; health: number; firstDataBuilt: number; firstDataRequestMs: number }[] = []
for (let b = 0; b < BOOTS; b++) {
  // Boot 1 is a FRESH machine (no cache.db: the whole /api/data built from the transcripts); the
  // others are RESTARTS over the cache the first one left (the owner's everyday case).
  if (b === 0) { rmSync(join(home, '.agentistics'), { recursive: true, force: true }); mkdirSync(join(home, '.agentistics'), { recursive: true }) }
  const s = await startPerfServer(home, { env: { PATH: `${join(import.meta.dir, 'fake-bin')}:${process.env.PATH}` } })
  const cold = await get(s, '/api/data')
  await Bun.sleep(300)
  boots.push({ listening: s.boot.listening ?? NaN, health: Math.round(s.healthMs), firstDataBuilt: s.boot.firstData ?? NaN, firstDataRequestMs: Math.round(cold.ms) })
  out.data_bytes = cold.bytes
  log(`boot ${b + 1}/${BOOTS}`, boots[boots.length - 1])
  if (b < BOOTS - 1) await s.stop()
  else {
    // ── 2. the rest, on the last server ───────────────────────────────────────────────────────
    const warm: number[] = []
    for (let i = 0; i < 20; i++) warm.push((await get(s, '/api/data')).ms)
    out.data_warm = quantiles(warm)

    const open: Record<string, unknown> = {}
    for (const [k, t] of Object.entries(bySize)) {
      const xs: number[] = []
      let bytes = 0
      const encodedDir = basename(dirname(t.path))
      for (let i = 0; i < 5; i++) {
        const r = await get(s, `/api/claude-sessions/${t.id}?encodedDir=${encodeURIComponent(encodedDir)}`)
        if (r.status !== 200) throw new Error(`historic open answered ${r.status}: ${r.text.slice(0, 200)}`)
        xs.push(r.ms); bytes = r.bytes
      }
      // PERF.1 step 3: the paged open (the END first), when the server has it.
      const paged: number[] = []
      let pagedBytes = 0
      for (let i = 0; i < 5; i++) {
        const r = await get(s, `/api/claude-sessions/${t.id}?encodedDir=${encodeURIComponent(encodedDir)}&limit=150`)
        paged.push(r.ms); pagedBytes = r.bytes
      }
      const pagedOk = pagedBytes > 0 && !pagedBytes.toString().startsWith('[')
      open[`${k}_paged`] = pagedOk ? { firstMs: Math.round(paged[0]!), responseKB: Math.round(pagedBytes / 1024), ...quantiles(paged.slice(1)) } : null
      open[k] = { transcriptMB: +(t.size / 1048576).toFixed(1), responseMB: +(bytes / 1048576).toFixed(1), ...quantiles(xs) }
    }
    out.historic_open = open

    // /api/events: an append → `change`
    const ev: number[] = []
    let fresh = 0
    for (let i = 0; i < 5; i++) {
      const before = (await get(s, '/api/data')).text.replace(/"live(SessionIds|Processes)":\[[^\]]*\]/g, '')
      const ctl = new AbortController()
      const res = await fetch(`${s.base}/api/events`, { signal: ctl.signal })
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      // wait for `connected`
      while (!buf.includes('connected')) buf += dec.decode((await reader.read()).value ?? new Uint8Array())
      buf = ''
      const t = performance.now()
      // A new PERSON turn: it changes the session's figures, so fresh data differs from the old.
      appendFileSync(bySize.median.path, `${JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), parentUuid: null, sessionId: bySize.median.id, timestamp: new Date().toISOString(), message: { role: 'user', content: `perf ${i}` } })}\n`)
      const deadline = t + 15_000
      while (performance.now() < deadline) {
        const r = await Promise.race([reader.read(), Bun.sleep(15_000).then(() => null)])
        if (!r || r.done) break
        buf += dec.decode(r.value)
        if (buf.includes('event: change')) {
          ev.push(performance.now() - t)
          // Is the data the client now refetches the NEW data?
          const after = (await get(s, '/api/data')).text.replace(/"live(SessionIds|Processes)":\[[^\]]*\]/g, '')
          if (after !== before) fresh++
          break
        }
      }
      ctl.abort()
      await Bun.sleep(2500)
    }
    out.events_change_after_append = { ...quantiles(ev), refetchSawTheChange: `${fresh}/${ev.length}` }

    // ── 3. live CLI sessions over a fake claude ───────────────────────────────────────────────
    out.live = {}
    for (const [label, seed] of [['p90', bySize.p90], ['max', bySize.max]] as const) {
      const cwd = join(home, '..', 'work', `live-${label}`)
      mkdirSync(cwd, { recursive: true })
      await Bun.write(join(cwd, '.fake-seed'), seed.path)
      const sp = await fetch(`${s.base}/api/fleet/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harness: 'claude', cwd, force: true, label: `perf-${label}` }) })
      const spawned = await sp.json() as { ok: boolean; id?: string; session?: { id: string }; message?: string }
      const id = spawned.id ?? spawned.session?.id
      if (!spawned.ok || !id) { log('spawn failed', spawned); (out.live as Record<string, unknown>)[label] = { error: spawned.message ?? 'spawn failed' }; continue }
      // the first chat read that has history = "open"
      let openMs = NaN
      for (let i = 0; i < 100; i++) {
        const r = await get(s, `/api/fleet/chat?id=${id}&lang=en`)
        if (r.status === 200 && r.text.includes('"turns"') && r.text.length > 2000) { openMs = r.ms; break }
        await Bun.sleep(200)
      }
      const echo: number[] = [], answer: number[] = [], readCost: number[] = []
      for (let k = 0; k < 6; k++) {
        const marker = `perfmark${k}x${Date.now()}`
        const tSend = Date.now()
        await fetch(`${s.base}/api/fleet/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'prompt', text: marker }) })
        // the web: a read right after the send (nudge), then every WEB_POLL_MS
        let sawEcho = false, sawAnswer = false
        let next = Date.now()
        const deadline = Date.now() + 30_000
        while ((!sawEcho || !sawAnswer) && Date.now() < deadline) {
          await Bun.sleep(Math.max(0, next - Date.now()))
          const r = await get(s, `/api/fleet/chat?id=${id}&lang=en`)
          readCost.push(r.ms)
          const now = Date.now()
          if (!sawEcho && new RegExp(`"${marker} writtenAt=`).test(r.text)) { echo.push(now - tSend); sawEcho = true }
          const m = r.text.match(new RegExp(`answer to ${marker}[^"]*writtenAt=(\\d+)`))
          if (!sawAnswer && m) { answer.push(now - Number(m[1])); sawAnswer = true }
          next += WEB_POLL_MS
        }
        await Bun.sleep(500)
      }
      // The PUSH path (PERF.1 step 2), when the server has it: `/api/fleet/chat-stream`.
      const push = await measurePush(s, id)
      ;(out.live as Record<string, unknown>)[label] = { push, seededMB: +(seed.size / 1048576).toFixed(1), openFirstChatMs: Math.round(openMs), sendToEcho: quantiles(echo), harnessWriteToShown: quantiles(answer), chatReadCost: quantiles(readCost) }
      log('live', label, (out.live as Record<string, unknown>)[label])
      await fetch(`${s.base}/api/fleet/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action: 'kill' }) }).catch(() => {})
    }
    out.server_rss_mb_end = Math.round((await s.rssKb()) / 1024)
    await s.stop()
  }
}
out.boot_fresh = boots[0]
const restarts = boots.slice(1)
out.boot_restart = {
  listening: quantiles(restarts.map(b => b.listening)), health: quantiles(restarts.map(b => b.health)),
  firstDataBuilt: quantiles(restarts.map(b => b.firstDataBuilt)), firstDataRequest: quantiles(restarts.map(b => b.firstDataRequestMs)),
}
out.boot_all = {
  listening: quantiles(boots.map(b => b.listening)), health: quantiles(boots.map(b => b.health)),
  firstDataBuilt: quantiles(boots.map(b => b.firstDataBuilt)), firstDataRequest: quantiles(boots.map(b => b.firstDataRequestMs)),
}
const json = JSON.stringify(out, null, 2)
console.log(json)
const jp = opt('json')
if (jp) await Bun.write(jp, json)
