/**
 * CI COPY of the ENGINE.MAP bench (engine repo, branch docs/engine-map, docs/engine-map/scripts/bench.ts).
 * Differences from the engine's file — keep this list exact, `sync.test.ts` pins the hashes:
 *   1. switch probe: 10 samples instead of 5, and p95 of GET / first frame reported (`switchGetP95`,
 *      `switchFirstP95`, a table column) — the 09 §8 budget is p95, the original printed p50 only;
 * Everything else — the simulated web client, the probes, the soak, the tables — is byte for byte.
 */
/**
 * bench.ts — the ENGINE.MAP performance baseline. Re-runnable UNCHANGED against a build with the
 * adapter flag ON: point it at that server and compare the summary tables.
 *
 *   bun bench.ts --base http://127.0.0.1:48881 --pid <server pid> --root <ROOT> \
 *                [--plan quick|full] [--soak-min 30] [--out results.json]
 *
 * It never starts or stops a server (run-bench.sh does that, by PID). It drives the server only
 * through its HTTP API, exactly the routes the web app uses:
 *
 *   a simulated WEB CLIENT (one per --clients) = what one browser tab on /sessions with one chat open
 *   does, per packages/web/src: GET /api/fleet every 5 s (lib/fleet.ts FLEET_POLL_MS), the shared
 *   /api/events SSE and a GET /api/data?partial=1 on every `change` (hooks/useData.ts) plus every
 *   30 s, GET /api/health every 2 s (lib/startupLoad.ts LIVENESS_MS), the open chat's push stream
 *   /api/fleet/chat-stream (lib/chatFeed.ts) and its terminal frame stream /api/fleet/stream
 *   (SessionChat.tsx → useTerminalStream). Conditional /api/data requests carry If-None-Match, as a
 *   browser's HTTP cache would.
 *
 * Measured, per condition (N fake sessions × C clients):
 *   server CPU % (own + reaped children, i.e. the tmux client processes it spawns), RSS, rchar and
 *   read syscalls per minute (/proc/<pid>/io), tmux invocations per minute by subcommand (tmux shim
 *   log), the tmux SERVER's CPU %, /api/fleet and /api/data latency p50/p95 and payload size,
 *   send→echo, harness-write→answer-shown, switch-session.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ── args ────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d }
const BASE = arg('base', 'http://127.0.0.1:48881')!
const PID = Number(arg('pid'))
const ROOT = arg('root')!
const PLAN = arg('plan', 'full')!
const SOAK_MIN = Number(arg('soak-min', PLAN === 'full' ? '30' : '0'))
const OUT = arg('out', join(ROOT, 'logs', 'bench-results.json'))!
const LABEL = arg('label', 'baseline')!
const HARNESSES = (arg('harnesses', 'claude,codex,gemini,copilot,kimi,antigravity')!).split(',')
if (!PID || !ROOT) { console.error('usage: --pid <server pid> --root <ROOT>'); process.exit(2) }
const TMUX_LOG = join(ROOT, 'logs', 'tmux-calls.log')
const CLK_TCK = 100

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const now = () => Date.now()
const log = (...a: unknown[]) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...a)

// ── /proc sampling ──────────────────────────────────────────────────────────────────────────────
interface ProcSample { t: number; self: number; children: number; rss: number; rchar: number; syscr: number; ioOk: boolean }
function sample(pid: number): ProcSample | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // fields after ")" start at #3 (state): utime=#14 → index 11
    const self = (Number(f[11]) + Number(f[12])) / CLK_TCK
    const children = (Number(f[13]) + Number(f[14])) / CLK_TCK
    const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) * 1024
    let rchar = 0, syscr = 0, ioOk = false
    try {
      const io = readFileSync(`/proc/${pid}/io`, 'utf8')
      rchar = Number(/rchar:\s+(\d+)/.exec(io)?.[1] ?? 0); syscr = Number(/syscr:\s+(\d+)/.exec(io)?.[1] ?? 0); ioOk = true
    } catch { /* io unreadable */ }
    return { t: now(), self, children, rss, rchar, syscr, ioOk }
  } catch { return null }
}
function tmuxServerPid(): number | null {
  // The throwaway socket: $ROOT/tmux/tmux-<uid>/agentop
  // The socket is `agentop-<hash of the data dir>` (per data dir), not plain `agentop`.
  const dir = join(ROOT, 'tmux', `tmux-${process.getuid?.() ?? 1000}`)
  const name = existsSync(dir) ? readdirSync(dir).find(n => n.startsWith('agentop')) : undefined
  if (!name) return null
  const sock = join(dir, name)
  const r = Bun.spawnSync(['/usr/bin/tmux', '-S', sock, 'display-message', '-p', '#{pid}'])
  const n = Number(r.stdout.toString().trim())
  return Number.isFinite(n) && n > 0 ? n : null
}
function tmuxCalls(fromMs: number, toMs: number): Record<string, number> {
  if (!existsSync(TMUX_LOG)) return {}
  const out: Record<string, number> = {}
  for (const line of readFileSync(TMUX_LOG, 'utf8').split('\n')) {
    const [ts, sub] = line.split(' ')
    const t = Number(ts)
    if (!sub || t < fromMs || t > toMs) continue
    out[sub] = (out[sub] ?? 0) + 1
  }
  return out
}

// ── stats ───────────────────────────────────────────────────────────────────────────────────────
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const r0 = (x: number) => Number.isFinite(x) ? Math.round(x) : NaN
const r1 = (x: number) => Number.isFinite(x) ? Math.round(x * 10) / 10 : NaN

// ── HTTP + SSE ──────────────────────────────────────────────────────────────────────────────────
interface Timed { ms: number; bytes: number; wire: number; status: number }
async function timedGet(path: string, headers: Record<string, string> = {}): Promise<Timed & { etag?: string; text?: string }> {
  const t0 = performance.now()
  try {
    const res = await fetch(BASE + path, { headers: { 'Accept-Encoding': 'br, gzip', ...headers } })
    const buf = new Uint8Array(await res.arrayBuffer())
    return { ms: performance.now() - t0, bytes: buf.byteLength, wire: Number(res.headers.get('content-length') ?? buf.byteLength), status: res.status, etag: res.headers.get('etag') ?? undefined, text: path.includes('/chat') ? new TextDecoder().decode(buf) : undefined }
  } catch { return { ms: performance.now() - t0, bytes: 0, wire: 0, status: 0 } }
}
async function post(path: string, body: unknown): Promise<{ ms: number; json: any }> {
  const t0 = performance.now()
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(body) })
  let json: any = null
  try { json = await res.json() } catch { /* */ }
  return { ms: performance.now() - t0, json }
}

/** A minimal SSE reader over fetch. Returns a closer. */
function sse(path: string, on: (event: string, data: string) => void, onBytes?: (n: number) => void): () => void {
  const ac = new AbortController()
  void (async () => {
    try {
      const res = await fetch(BASE + path, { signal: ac.signal, headers: { Accept: 'text/event-stream' } })
      if (!res.body) return
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        onBytes?.(value.byteLength)
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          let ev = 'message', data = ''
          for (const l of block.split('\n')) {
            if (l.startsWith('event:')) ev = l.slice(6).trim()
            else if (l.startsWith('data:')) data += (data ? '\n' : '') + l.slice(5).trimStart()
          }
          if (data || ev !== 'message') on(ev, data)
        }
      }
    } catch { /* aborted */ }
  })()
  return () => ac.abort()
}

// ── the simulated web client ────────────────────────────────────────────────────────────────────
interface ClientStats { fleet: Timed[]; data: Timed[]; health: Timed[]; sseBytes: number; changes: number }
function startClient(sessionId: string | null, stats: ClientStats): () => void {
  const closers: (() => void)[] = []
  let etag: string | undefined
  let stopped = false
  const fetchData = async () => {
    const r = await timedGet('/api/data?partial=1', etag ? { 'If-None-Match': etag } : {})
    if (r.etag) etag = r.etag
    stats.data.push(r)
  }
  const every = (ms: number, f: () => Promise<unknown>) => {
    let t: Timer | null = null
    const loop = async () => { if (stopped) return; await f().catch(() => {}); if (!stopped) t = setTimeout(loop, ms) }
    t = setTimeout(loop, Math.random() * ms)
    closers.push(() => { if (t) clearTimeout(t) })
  }
  every(5000, async () => { stats.fleet.push(await timedGet('/api/fleet?lang=pt')) })
  every(30_000, fetchData)
  every(2000, async () => { stats.health.push(await timedGet('/api/health')) })
  closers.push(sse('/api/events', ev => { if (ev === 'change') { stats.changes++; void fetchData() } }, n => { stats.sseBytes += n }))
  if (sessionId) {
    closers.push(sse(`/api/fleet/chat-stream?id=${encodeURIComponent(sessionId)}&lang=pt`, () => {}, n => { stats.sseBytes += n }))
    closers.push(sse(`/api/fleet/stream?id=${encodeURIComponent(sessionId)}`, () => {}, n => { stats.sseBytes += n }))
  }
  void fetchData()
  return () => { stopped = true; for (const c of closers) c() }
}

// ── the fleet ───────────────────────────────────────────────────────────────────────────────────
async function fleetIds(): Promise<{ id: string; state: string; harness: string; linked: boolean }[]> {
  const r = await fetch(`${BASE}/api/fleet?lang=en`)
  const j = await r.json() as { rows?: { id: string; state: string; title?: string; harness?: string; actionable?: boolean; conversationId?: string }[] }
  // Only the sessions THIS server started and that are alive: the copied consolidate store also
  // contributes hundreds of `closed:` conversation rows, which are real rows of the fleet payload
  // (and part of its cost) but not sessions to type into.
  const LIVE = new Set(['working', 'waiting', 'waiting-approval'])
  return (j.rows ?? []).filter(x => HARNESSES.includes(x.harness ?? '') && x.actionable === true && LIVE.has(x.state)).map(x => ({ id: x.id, state: x.state, harness: x.harness!, linked: Boolean(x.conversationId) }))
}
async function spawnUpTo(n: number): Promise<{ spawnMs: number[] }> {
  const spawnMs: number[] = []
  let have = (await fleetIds()).length
  while (have < n) {
    // 5 folders round-robin: two sessions of one harness share a folder only from N=30 on (mixed fleet of 6)
    const group = have % 5
    const cwd = join(ROOT, 'work', `repo${group}`)
    Bun.spawnSync(['mkdir', '-p', cwd])
    const harness = HARNESSES[have % HARNESSES.length]!
    const r = await post('/api/fleet/new?lang=en', { harness, cwd, label: `bench-${have}-${harness}` })
    if (!r.json?.ok) { log('spawn refused:', JSON.stringify(r.json)); break }
    spawnMs.push(r.ms)
    have++
  }
  // wait until the fleet shows them all running
  for (let i = 0; i < 60; i++) { if ((await fleetIds()).length >= n) break; await sleep(1000) }
  return { spawnMs }
}

// ── probes ──────────────────────────────────────────────────────────────────────────────────────
interface ChatWatch { close(): void; turns: () => any[]; pending: () => string[]; events: { t: number; turns: any[]; pending: string[] }[] }
function watchChat(id: string): ChatWatch {
  let turns: any[] = []
  let pending: string[] = []
  const events: ChatWatch['events'] = []
  const close = sse(`/api/fleet/chat-stream?id=${encodeURIComponent(id)}&lang=en`, (ev, data) => {
    try {
      if (ev === 'chat') { const p = JSON.parse(data); turns = p.turns ?? []; pending = (p.pending ?? []).map((x: any) => x.text) }
      else if (ev === 'chat-delta') {
        const d = JSON.parse(data)
        turns = [...turns.slice(d.drop, d.drop + d.keep), ...d.append]
        pending = (d.meta?.pending ?? []).map((x: any) => x.text)
      } else return
      events.push({ t: now(), turns, pending })
    } catch { /* */ }
  })
  return { close, turns: () => turns, pending: () => pending, events }
}
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<number | null> {
  const t0 = now()
  while (now() - t0 < timeoutMs) { if (pred()) return now(); await sleep(5) }
  return null
}

interface SendProbe { ack: string; actMs: number; echoMs: number | null; userTurnMs: number | null; answerShownMs: number | null; answerLagMs: number | null; idleAfterWriteMs: number | null }
async function sendProbe(id: string, k: number): Promise<SendProbe> {
  const w = watchChat(id)
  await waitFor(() => w.events.length > 0, 10_000)
  const text = `probe-${k}-${Math.random().toString(36).slice(2, 7)}`
  const t0 = now()
  const act = await post('/api/fleet/act?lang=en', { id, action: 'prompt', text })
  const echoAt = await waitFor(() => w.pending().some(p => p.includes(text)) || w.turns().some(t => t.role === 'user' && String(t.text).includes(text)), 8_000)
  // An unlinked row never shows the conversation: do not spend the full waits on it.
  const userAt = await waitFor(() => w.turns().some(t => t.role === 'user' && String(t.text).includes(text)), echoAt ? 15_000 : 4_000)
  const ansAt = userAt ? await waitFor(() => w.turns().some(t => t.role === 'assistant' && String(t.text).includes(`[${text}]`)), 15_000) : null
  let lag: number | null = null
  if (ansAt) {
    const turn = w.turns().find(t => t.role === 'assistant' && String(t.text).includes(`[${text}]`))
    const written = Number(/written_at=(\d+)/.exec(String(turn?.text))?.[1])
    if (written) lag = ansAt - written
  }
  w.close()
  // Turn-end as the list sees it: the row leaves `working` (screen stillness confirmed on two polls).
  let idleAfter: number | null = null
  if (ansAt) {
    const written = ansAt - (lag ?? 0)
    for (let i = 0; i < 20; i++) {
      const row = (await fleetIds()).find(x => x.id === id)
      if (row && row.state === 'waiting') { idleAfter = now() - written; break }
      await sleep(1000)
    }
  }
  return { idleAfterWriteMs: idleAfter, ack: String(act.json?.message ?? ''), actMs: act.ms, echoMs: echoAt ? echoAt - t0 : null, userTurnMs: userAt ? userAt - t0 : null, answerShownMs: ansAt ? ansAt - t0 : null, answerLagMs: lag }
}
async function switchProbe(id: string): Promise<{ getMs: number; firstFrameMs: number | null }> {
  const g = await timedGet(`/api/fleet/chat?id=${encodeURIComponent(id)}&lang=en`)
  const t0 = now()
  const w = watchChat(id)
  const at = await waitFor(() => w.events.length > 0, 15_000)
  w.close()
  return { getMs: g.ms, firstFrameMs: at ? at - t0 : null }
}

// ── one condition ───────────────────────────────────────────────────────────────────────────────
interface Row {
  label: string; n: number; c: number
  cpuSelf: number; cpuChildren: number; cpuTmuxServer: number | null; rssMB: number
  rcharMBmin: number; syscrMin: number; tmuxPerMin: number; tmuxBySub: Record<string, number>
  fleetP50: number; fleetP95: number; fleetKB: number
  dataP50: number; dataP95: number; dataKB: number; dataColdP50: number; dataColdKB: number; dataWireKB: number
  healthP50: number; changesPerMin: number; clientKBmin: number
  sendAct?: number; turnEnd?: number; sendEcho?: number; sendEchoP95?: number; answerLag?: number; answerLagP95?: number
  switchGet?: number; switchFirst?: number; switchGetP95?: number; switchFirstP95?: number
  perHarness?: Record<string, { linked: boolean; ack: string; sendAck: number; echo: number; shown: number; idle: number; chatGetMs: number; chatKB: number }>
}
async function condition(n: number, c: number, windowS: number, probes: boolean): Promise<Row> {
  const ids = (await fleetIds()).map(x => x.id)
  const stats: ClientStats[] = Array.from({ length: c }, () => ({ fleet: [], data: [], health: [], sseBytes: 0, changes: 0 }))
  const stops = stats.map((s, i) => startClient(ids.length ? ids[i % ids.length]! : null, s))
  await sleep(15_000) // warm-up: first polls, streams open
  for (const s of stats) { s.fleet.length = 0; s.data.length = 0; s.health.length = 0; s.sseBytes = 0; s.changes = 0 }
  const tPid = tmuxServerPid()
  const a = sample(PID)!, ta = tPid ? sample(tPid) : null
  const t0 = now()
  await sleep(windowS * 1000)
  const b = sample(PID)!, tb = tPid ? sample(tPid) : null
  const t1 = now()
  const mins = (t1 - t0) / 60_000
  const secs = (b.t - a.t) / 1000
  const calls = tmuxCalls(t0, t1)
  const totalCalls = Object.values(calls).reduce((x, y) => x + y, 0)
  // cold /api/data: no If-None-Match
  const cold: Timed[] = []
  for (let i = 0; i < 5; i++) cold.push(await timedGet('/api/data?partial=1'))
  const fleet = stats.flatMap(s => s.fleet), data = stats.flatMap(s => s.data).filter(d => d.status === 200 || d.status === 304)
  const row: Row = {
    label: LABEL, n, c,
    cpuSelf: r1(100 * (b.self - a.self) / secs), cpuChildren: r1(100 * (b.children - a.children) / secs),
    cpuTmuxServer: ta && tb ? r1(100 * (tb.self - ta.self) / secs) : null,
    rssMB: r0(b.rss / 1048576),
    rcharMBmin: b.ioOk ? r1((b.rchar - a.rchar) / 1048576 / mins) : NaN, syscrMin: b.ioOk ? r0((b.syscr - a.syscr) / mins) : NaN,
    tmuxPerMin: r0(totalCalls / mins), tmuxBySub: Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, r0(v / mins)])),
    fleetP50: r0(pct(fleet.map(x => x.ms), 50)), fleetP95: r0(pct(fleet.map(x => x.ms), 95)), fleetKB: r1(pct(fleet.map(x => x.bytes), 50) / 1024),
    dataP50: r0(pct(data.map(x => x.ms), 50)), dataP95: r0(pct(data.map(x => x.ms), 95)), dataKB: r1(pct(data.map(x => x.bytes), 50) / 1024),
    dataColdP50: r0(pct(cold.map(x => x.ms), 50)), dataColdKB: r1(pct(cold.map(x => x.bytes), 50) / 1024), dataWireKB: r1(pct(cold.map(x => x.wire), 50) / 1024),
    healthP50: r0(pct(stats.flatMap(s => s.health).map(x => x.ms), 50)),
    changesPerMin: r1(stats.reduce((x, s) => x + s.changes, 0) / Math.max(1, c) / mins),
    clientKBmin: r1(stats.reduce((x, s) => x + s.sseBytes + s.fleet.reduce((y, f) => y + f.bytes, 0) + s.data.reduce((y, f) => y + f.bytes, 0) + s.health.reduce((y, f) => y + f.bytes, 0), 0) / Math.max(1, c) / 1024 / mins),
  }
  if (probes && ids.length > 0) {
    const fleetNow = await fleetIds()
    const sends: SendProbe[] = []
    row.perHarness = {}
    for (const h of HARNESSES) {
      const target = fleetNow.find(x => x.harness === h)
      if (!target) continue
      const ph: SendProbe[] = []
      for (let k = 0; k < 2; k++) { const sp = await sendProbe(target.id, k); ph.push(sp); sends.push(sp); await sleep(1000) }
      const read = await timedGet(`/api/fleet/chat?id=${encodeURIComponent(target.id)}&lang=en`)
      const after = (await fleetIds()).find(x => x.id === target.id)
      const nnh = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null)
      row.perHarness[h] = {
        linked: Boolean(after?.linked), ack: String(ph[0]?.ack ?? ''), sendAck: r0(pct(ph.map(x => x.actMs), 50)),
        echo: r0(pct(nnh(ph.map(x => x.echoMs)), 50)), shown: r0(pct(nnh(ph.map(x => x.answerLagMs)), 50)),
        idle: r0(pct(nnh(ph.map(x => x.idleAfterWriteMs)), 50)), chatGetMs: r0(read.ms), chatKB: r1(read.bytes / 1024),
      }
    }
    const sw: { getMs: number; firstFrameMs: number | null }[] = []
    for (let k = 0; k < 10; k++) sw.push(await switchProbe(ids[(ids.length - 1 - k % ids.length + ids.length) % ids.length]!))
    const nn = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null)
    row.sendAct = r0(pct(sends.map(s => s.actMs), 50))
    row.turnEnd = r0(pct(nn(sends.map(s => s.idleAfterWriteMs)), 50))
    row.sendEcho = r0(pct(nn(sends.map(s => s.echoMs)), 50)); row.sendEchoP95 = r0(pct(nn(sends.map(s => s.echoMs)), 95))
    row.answerLag = r0(pct(nn(sends.map(s => s.answerLagMs)), 50)); row.answerLagP95 = r0(pct(nn(sends.map(s => s.answerLagMs)), 95))
    row.switchGet = r0(pct(sw.map(s => s.getMs), 50)); row.switchFirst = r0(pct(nn(sw.map(s => s.firstFrameMs)), 50))
    row.switchGetP95 = r0(pct(sw.map(s => s.getMs), 95)); row.switchFirstP95 = r0(pct(nn(sw.map(s => s.firstFrameMs)), 95))
    log(`probes n=${n} c=${c}`, JSON.stringify({ sends, sw }))
  }
  for (const s of stops) s()
  await sleep(3000)
  return row
}

// ── soak ────────────────────────────────────────────────────────────────────────────────────────
async function soak(minutes: number, c: number): Promise<{ startMB: number; endMB: number; maxMB: number; slopeMBh: number; samples: [number, number][] }> {
  const ids = (await fleetIds()).map(x => x.id)
  const stats: ClientStats[] = Array.from({ length: c }, () => ({ fleet: [], data: [], health: [], sseBytes: 0, changes: 0 }))
  const stops = stats.map((s, i) => startClient(ids[i % ids.length] ?? null, s))
  const samples: [number, number][] = []
  const t0 = now()
  let k = 0
  while (now() - t0 < minutes * 60_000) {
    const s = sample(PID)
    if (s) samples.push([Math.round((s.t - t0) / 1000), r1(s.rss / 1048576)])
    if (ids.length && (k % 2 === 0)) {
      // one prompt a minute, round-robin — sessions that talk, as a real fleet does
      void post('/api/fleet/act?lang=en', { id: ids[(k / 2) % ids.length]!, action: 'prompt', text: `soak-${k}` })
    }
    k++
    await sleep(30_000)
  }
  for (const s of stops) s()
  const xs = samples.map(([t]) => t / 3600), ys = samples.map(([, m]) => m)
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / Math.max(1e-9, xs.reduce((a, x) => a + (x - mx) ** 2, 0))
  return { startMB: ys[0]!, endMB: ys[ys.length - 1]!, maxMB: Math.max(...ys), slopeMBh: r1(slope), samples }
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
const W = PLAN === 'smoke' ? 15 : PLAN === 'quick' ? 30 : 60
const rows: Row[] = []
const spawnLog: number[] = []
log(`base=${BASE} pid=${PID} plan=${PLAN}`)
if (PLAN !== 'smoke') { rows.push(await condition(0, 0, W, false)); log(`row ${JSON.stringify(rows[0])}`) }
for (const n of PLAN === 'smoke' ? [1] : PLAN === 'quick' ? [1, 10] : [1, 10, 50]) {
  spawnLog.push(...(await spawnUpTo(n)).spawnMs)
  await sleep(10_000)
  const cs = n === 1 ? [1] : [0, 1, 5]
  for (const c of cs) {
    log(`condition n=${n} c=${c}`)
    rows.push(await condition(n, c, W, c > 0))
    // Saved after EVERY condition: a watchdog stop must still leave the numbers measured so far.
    await Bun.write(OUT + '.partial', JSON.stringify(rows, null, 2))
    log(`row ${JSON.stringify(rows[rows.length - 1])}`)
  }
}
let soakResult: Awaited<ReturnType<typeof soak>> | null = null
if (SOAK_MIN > 0) {
  // back to 10 live sessions is not possible without killing — the soak runs on the fleet as it is
  log(`soak ${SOAK_MIN} min, 5 clients`)
  soakResult = await soak(SOAK_MIN, 5)
}

const result = { label: LABEL, at: new Date().toISOString(), base: BASE, spawnMs: { p50: r0(pct(spawnLog, 50)), p95: r0(pct(spawnLog, 95)), n: spawnLog.length }, rows, soak: soakResult }
await Bun.write(OUT, JSON.stringify(result, null, 2))

// ── the summary table ───────────────────────────────────────────────────────────────────────────
const cols: [string, (r: Row) => unknown][] = [
  ['N', r => r.n], ['C', r => r.c], ['cpu%', r => r.cpuSelf], ['cpu%kids', r => r.cpuChildren], ['tmuxSrv%', r => r.cpuTmuxServer ?? '-'],
  ['rssMB', r => r.rssMB], ['tmux/min', r => r.tmuxPerMin], ['rcharMB/min', r => r.rcharMBmin], ['readSys/min', r => r.syscrMin],
  ['fleet p50/p95 ms', r => `${r.fleetP50}/${r.fleetP95}`], ['fleetKB', r => r.fleetKB],
  ['data p50/p95 ms', r => `${r.dataP50}/${r.dataP95}`], ['data cold ms', r => r.dataColdP50], ['dataKB decoded/wire', r => `${r.dataColdKB}/${r.dataWireKB}`],
  ['change/min', r => r.changesPerMin], ['client KB/min', r => r.clientKBmin],
  ['send ack ms', r => r.sendAct ?? '-'], ['send→echo p50/p95', r => r.sendEcho !== undefined ? `${r.sendEcho}/${r.sendEchoP95}` : '-'],
  ['write→shown p50/p95', r => r.answerLag !== undefined ? `${r.answerLag}/${r.answerLagP95}` : '-'],
  ['write→idle ms', r => r.turnEnd ?? '-'],
  ['switch GET/first', r => r.switchGet !== undefined ? `${r.switchGet}/${r.switchFirst}` : '-'],
  ['switch first p95', r => r.switchFirstP95 ?? '-'],
]
const table = [
  `| ${cols.map(c => c[0]).join(' | ')} |`,
  `|${cols.map(() => '---').join('|')}|`,
  ...rows.map(r => `| ${cols.map(c => String(c[1](r))).join(' | ')} |`),
]
console.log(`\n## ENGINE.MAP bench — ${LABEL} — ${result.at}\n`)
console.log(`spawn (POST /api/fleet/new) p50/p95: ${result.spawnMs.p50}/${result.spawnMs.p95} ms over ${result.spawnMs.n}\n`)
console.log(table.join('\n'))
const lastWithPer = [...rows].reverse().find(r => r.perHarness)
if (lastWithPer?.perHarness) {
  console.log(`\n### Per harness (N=${lastWithPer.n}, C=${lastWithPer.c}) — fake harnesses writing each real transcript shape\n`)
  console.log('| harness | linked | send ack ms | send→echo ms | write→shown ms | write→idle ms | chat GET ms | chat KB |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const [h, v] of Object.entries(lastWithPer.perHarness)) console.log(`| ${h} | ${v.linked ? 'yes' : 'NO'} | ${v.sendAck} | ${v.echo} | ${v.shown} | ${v.idle} | ${v.chatGetMs} | ${v.chatKB} |`)
}
if (soakResult) console.log(`\nsoak ${SOAK_MIN} min (5 clients, 1 prompt/min): RSS ${soakResult.startMB} → ${soakResult.endMB} MB (max ${soakResult.maxMB}), slope ${soakResult.slopeMBh} MB/h`)
console.log(`\ntmux calls/min by subcommand (last row): ${JSON.stringify(rows[rows.length - 1]?.tmuxBySub)}`)
