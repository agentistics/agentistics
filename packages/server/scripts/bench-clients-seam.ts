/** Measure the pushed client protocol against the compiled server in a pure throwaway environment.
 * Run under blocking flock + the leader's resource scope. ENGINE.MAP's unchanged bench simulates
 * the former polling/terminal client; this companion measures the shared fleet consumer we ship.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { applyDataPatch, followFleet, type DataPatch, type FleetWire } from '@agentistics/core'

const workspace = process.cwd(), realHome = process.env.HOME!
const scripts = process.env.ENGINE_MAP_SCRIPTS
if (!scripts) throw new Error('Set ENGINE_MAP_SCRIPTS to the engine-map scripts directory')
const binary = join(workspace, 'release/agentop')
if (!existsSync(binary)) throw new Error('Build the compiled binary first')
const available = () => Number(readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0)
if (available() < 3 * 1024 * 1024) throw new Error('Requires at least 3 GB available')
const apiPort = 48981, webPort = 48982, base = `http://127.0.0.1:${apiPort}`
for (const port of [apiPort, webPort]) await new Promise<void>((resolve, reject) => {
  const probe = createServer(); probe.once('error', reject)
  probe.listen(port, '127.0.0.1', () => probe.close(e => e ? reject(e) : resolve()))
})
const evidence = mkdtempSync(join(workspace, '.cache/f1-3-bench-'))
const root = mkdtempSync('/tmp/f13b-')
const configs = ['.claude.json', '.codex/config.toml', '.gemini/settings.json', '.copilot/mcp-config.json']
const config = (f: string) => existsSync(join(realHome, f)) ? readFileSync(join(realHome, f), 'utf8') : ''
const value = (f: string, text: string) => f === '.claude.json' && text ? JSON.stringify(JSON.parse(text).mcpServers ?? {}) : text
const before = configs.map(f => value(f, config(f)))
const setup = spawnSync('bash', [join(scripts, 'env-setup.sh'), '--transcripts', '40'], { env: { ...process.env, ROOT: root }, stdio: 'inherit' })
if (setup.status !== 0) throw new Error('Throwaway environment setup failed')
const home = join(root, 'home'), tmp = join(home, '.cache/agentistics-tmp/f1-3')
mkdirSync(tmp, { recursive: true })
const preferences = join(root, 'data/preferences.json')
writeFileSync(preferences, JSON.stringify({ ...JSON.parse(readFileSync(preferences, 'utf8')), experimental: true }))
// The setup's sanitized copy may contain notification subscriptions from the owner's sessions.
// This benchmark only records local events; it never delivers a desktop or peer notification.
writeFileSync(join(root, 'data/event-subscriptions.json'), JSON.stringify({ subscriptions: [] }))
const env = { HOME: home, USER: process.env.USER ?? 'qa', LOGNAME: process.env.USER ?? 'qa', SHELL: '/bin/bash', LANG: 'C.UTF-8', TERM: 'xterm-256color', PATH: `${root}/bin:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, TMPDIR: tmp, TMUX_TMPDIR: join(root, 'tmux'), TMUX_SHIM_LOG: join(root, 'logs/tmux-calls.log'), AGENTISTICS_DIR: join(root, 'data'), PORT: String(apiPort), WEB_PORT: String(webPort), AGENTISTICS_THROWAWAY: '1', AGENTISTICS_TELEMETRY: '0', FAKE_THINK_S: '1' }
const server = spawn(binary, ['server'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
writeFileSync(join(root, 'server.pid'), String(server.pid))
let log = '', aborted = false
const record = (chunk: Buffer) => { log += chunk; writeFileSync(join(root, 'logs/server.log'), log) }
server.stdout?.on('data', record); server.stderr?.on('data', record)
const stops: Array<() => void> = []
const watchdog = setInterval(() => {
  const load = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0])
  if (available() < 2 * 1024 * 1024 || load > 8) { aborted = true; for (const close of stops) close(); server.kill('SIGTERM') }
}, 5_000)
const wait = async (ms: number) => { await Bun.sleep(ms); if (aborted) throw new Error('Watchdog stopped benchmark') }
async function json(path: string, body?: object) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(40_000), ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return await res.json() as Record<string, any>
}
function cpu() {
  const text = readFileSync(`/proc/${server.pid}/stat`, 'utf8')
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  // Linux sysconf CLK_TCK is read instead of assuming one clock frequency.
  return Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14])
}
const hz = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim())
interface Client { id: string; bytes: number; dataGets: number; patchCount: number; chatSource?: string; snapshotBytes: number[]; deltaBytes: number[]; stream: ReturnType<typeof followFleet>; close(): void }
function client(id: string): Client {
  const ac = new AbortController()
  let data: object | null = null, revision: string | null = null
  const result: Client = { id, bytes: 0, dataGets: 0, patchCount: 0, snapshotBytes: [], deltaBytes: [], stream: null!, close: () => { ac.abort(); result.stream.close(); clearInterval(health) } }
  const readData = async () => {
    const res = await fetch(base + '/api/data', { signal: ac.signal })
    const text = await res.text(); result.bytes += new TextEncoder().encode(text).byteLength; result.dataGets++
    data = JSON.parse(text); revision = res.headers.get('X-Agentistics-Data-Revision')
    if (!revision) throw new Error('Full dashboard baseline has no patch revision')
  }
  const sse = async (path: string, receive: (event: string, body: any) => void) => {
    try {
      const res = await fetch(base + path, { signal: ac.signal }); const reader = res.body!.getReader(), decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read(); if (done) break
        result.bytes += value.byteLength; buffer += decoder.decode(value, { stream: true })
        let at: number
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2)
          const event = /^event: (.*)$/m.exec(frame)?.[1], text = /^data: (.*)$/m.exec(frame)?.[1]
          if (event && text) receive(event, JSON.parse(text))
        }
      }
    } catch (error) { if (!ac.signal.aborted) console.error('client stream', String(error)) }
  }
  result.stream = followFleet(base + '/api/fleet/events?lang=en&closed=0', (_wire: FleetWire) => {}, {
    onBytes: n => { result.bytes += n },
    onEventBytes: (event, bytes) => { if (event === 'snapshot') result.snapshotBytes.push(bytes); if (event === 'delta') result.deltaBytes.push(bytes) },
  })
  void readData().then(() => sse('/api/events', (event, body) => {
    if (event === 'data-patch' && data) {
      const next = applyDataPatch(data, revision, body as DataPatch)
      if (next) { data = next; revision = body.revision; result.patchCount++ } else void readData()
    } else if (event === 'change' && body.revision !== revision) void readData()
  })).catch(error => { if (!ac.signal.aborted) console.error(String(error)) })
  void sse(`/api/fleet/chat-stream?id=${encodeURIComponent(id)}&lang=en`, (event, body) => { if (event === 'chat') result.chatSource = body.source ?? 'legacy' })
  const health = setInterval(() => { void fetch(base + '/api/health', { signal: ac.signal }).then(r => r.text()).then(t => { result.bytes += t.length }).catch(() => {}) }, 2_000)
  stops.push(result.close)
  return result
}
const results: Array<{ clients: number; cpuPercent: number; snapshotBytes: number[]; deltaBytes: number[]; chatSources: Array<string | undefined> }> = []
try {
  let ready = false
  for (let i = 0; i < 120; i++) {
    try { await json('/api/health'); ready = true; break } catch {}
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Server exited: ${log.slice(-4000)}`)
    await wait(1_000)
  }
  if (!ready) throw new Error('Server did not become healthy')
  const harnesses = ['claude', 'codex', 'gemini', 'copilot', 'kimi', 'antigravity']
  // The unchanged ENGINE.MAP fake-harness supports these six CLI formats. The browser contract
  // matrix covers all eight; real OpenCode/native and independent Q1/Q11 remain separate evidence.
  const started = new Set<string>()
  for (let i = 0; i < 10; i++) {
    const cwd = join(root, 'work', `repo${i % 5}`); mkdirSync(cwd, { recursive: true })
    const response = await json('/api/fleet/new?lang=en', { harness: harnesses[i % harnesses.length], cwd, label: `clients-bench-${i}` })
    if (!response.ok || typeof response.id !== 'string') throw new Error(`Spawn refused: ${JSON.stringify(response)}`)
    started.add(response.id)
  }
  await wait(5_000)
  const fleet = await json('/api/fleet?lang=en')
  const rows = (fleet.rows as Array<{ id: string; harness?: string; actionable?: boolean }>).filter(r => started.has(r.id) && r.actionable)
  if (rows.length < 10) throw new Error(`Expected ten fake sessions, got ${rows.length}`)
  for (const row of rows) await json('/api/fleet/act?lang=en', { id: row.id, action: 'prompt', text: 'QA warmup' })
  await wait(10_000)
  await json('/api/data?partial=1')
  // Automatic backfill starts after boot, so a fixed sleep can put its first import inside C=0.
  // Refuse a misleading CPU baseline if this throwaway journal has not finished importing.
  const progressPath = join(root, 'data/journal.db.backfill.json')
  let imported = false
  for (let i = 0; i < 180; i++) {
    if (existsSync(progressPath)) {
      const progress = JSON.parse(readFileSync(progressPath, 'utf8')) as { state?: string; completedAt?: string }
      if (progress.state === 'failed') throw new Error('Journal backfill failed before measurement')
      if (progress.completedAt) { imported = true; break }
    }
    await wait(5_000)
  }
  if (!imported) throw new Error('Journal backfill did not finish; CPU baseline would be invalid')
  await wait(15_000)
  for (const count of [0, 1, 5, 0]) {
    const clients = Array.from({ length: count }, (_, i) => client(rows[i % rows.length]!.id))
    await wait(5_000)
    if (clients.some(c => !c.stream.healthy())) throw new Error('Fleet SSE not healthy')
    const bytes = clients.map(c => c.bytes), gets = clients.map(c => c.dataGets), patches = clients.map(c => c.patchCount), ticks = cpu(), start = performance.now()
    await wait(30_000)
    const seconds = (performance.now() - start) / 1000
    const cpuPercent = 100 * (cpu() - ticks) / hz / seconds
    const result = { sessions: 10, clients: count, seconds, cpuPercent, chatSources: clients.map(c => c.chatSource), chatSessions: clients.map(c => ({ id: c.id, harness: rows.find(r => r.id === c.id)?.harness, source: c.chatSource })), patchCounts: clients.map((c, i) => c.patchCount - patches[i]!), clientKBmin: clients.map((c, i) => (c.bytes - bytes[i]!) / 1024 * 60 / seconds), extraDataGets: clients.map((c, i) => c.dataGets - gets[i]!), snapshotBytes: clients.flatMap(c => c.snapshotBytes), deltaBytes: clients.flatMap(c => c.deltaBytes) }
    results.push(result); console.log(JSON.stringify(result)); for (const c of clients) c.close()
  }
  const baselines = results.filter(r => r.clients === 0)
  const baselineCPU = baselines.reduce((sum, r) => sum + r.cpuPercent, 0) / baselines.length
  const deltaSizes = results.flatMap(r => r.deltaBytes)
  const checks = {
    idleCPU: baselines.every(r => r.cpuPercent <= 1),
    perClientCPU: results.filter(r => r.clients > 0).every(r => (r.cpuPercent - baselineCPU) / r.clients <= 1),
    snapshotBytes: results.every(r => r.snapshotBytes.every(n => n <= 51200)),
    deltaBytes: deltaSizes.length ? deltaSizes.every(n => n <= 2048) : null,
    adapterSources: results.every(r => r.chatSources.every(s => s === 'adapter')),
  }
  writeFileSync(join(root, 'logs/clients.json'), JSON.stringify({ results, checks, baselineCPU, scope: 'compiled server, 10 fake CLI sessions, 6 transcript formats; all 8 browser contracts and 30-minute memory soak are separate', budgets: { idleCPU: 1, perClientCPU: 1, snapshotBytes: 51200, deltaBytes: 2048 } }, null, 2))
  if (Object.values(checks).some(ok => !ok)) process.exitCode = 1
} finally {
  clearInterval(watchdog); for (const close of stops) close(); server.kill('SIGTERM')
  await Promise.race([new Promise<void>(resolve => server.once('exit', () => resolve())), Bun.sleep(2_000)])
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
  const tmuxRoot = join(root, 'tmux')
  for (const folder of readdirSync(tmuxRoot)) {
    const path = join(tmuxRoot, folder)
    for (const socket of readdirSync(path)) if (socket.startsWith('agentop')) spawnSync('/usr/bin/tmux', ['-S', join(path, socket), 'kill-server'], { env, stdio: 'ignore' })
  }
  cpSync(join(root, 'logs'), join(evidence, 'logs'), { recursive: true })
  rmSync(root, { recursive: true, force: true })
  for (const f of configs) {
    const after = config(f)
    if (after.includes(root) || /(?:localhost|127\.0\.0\.1):4898[12]/.test(after) || value(f, after) !== before[configs.indexOf(f)]) throw new Error(`Real config changed: ${f}`)
  }
  console.log(`Benchmark evidence: ${evidence}/logs`)
}
