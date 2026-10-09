/** Browser contract QA of the real app against an isolated SSE fixture host.
 * Run under the leader's blocking flock/resource cap. Real harness Q1/Q11 remains independent QA.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { planDataPatch } from '@agentistics/core'

const root = process.cwd()
const dist = join(root, 'packages/web/dist')
if (!existsSync(join(dist, 'index.html'))) throw new Error('Build the web app first')
const availableKb = Number(readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0)
if (availableKb < 3 * 1024 * 1024) throw new Error('QA requires at least 3 GB available')
const apiPort = 48971, webPort = 48972
for (const port of [apiPort, webPort]) {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()))
  })
}
const out = mkdtempSync(join(root, '.cache/f1-3-qa-'))
// Unix socket paths are limited to 108 bytes. Keep the pure HOME short; evidence stays in-repo.
const sandbox = mkdtempSync('/tmp/f13q-')
const home = join(sandbox, 'h')
const tmp = join(home, '.cache/agentistics-tmp/q')
mkdirSync(tmp, { recursive: true })
mkdirSync(join(sandbox, 'data')); mkdirSync(join(sandbox, 'tmux'))
const realHome = process.env.HOME!
const configs = ['.claude.json', '.codex/config.toml', '.gemini/settings.json', '.copilot/mcp-config.json']
const before = configs.map(f => existsSync(join(realHome, f)) ? readFileSync(join(realHome, f)) : null)
const configValue = (file: string, bytes: Buffer | null) => file === '.claude.json' && bytes ? JSON.stringify(JSON.parse(bytes.toString()).mcpServers ?? {}) : String(bytes)
const mentionsRun = (bytes: Buffer | null) => bytes && /(?:localhost|127\.0\.0\.1):4897[12]/.test(bytes.toString()) || bytes?.includes(Buffer.from(out))
if (before.some(mentionsRun)) throw new Error('real config already mentions QA ports/paths')
const harnesses = ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode', 'agentistics']
const nativeId = 'ses_00000000000000000000000000000001'
const idOf = (harness: string) => harness === 'agentistics' ? nativeId : `fixture-${harness}`
const rows = harnesses.map(harness => ({ id: idOf(harness), harness, title: `QA ${harness}`, cwd: '/throwaway/qa', project: 'QA', state: 'waiting', stateLabel: 'needs you', actionable: true, conversationId: `conversation-${harness}`, verbs: [{ action: 'prompt', enabled: true, label: 'Send' }, { action: 'interrupt', enabled: true, label: 'Stop' }], lastUserMessage: '', lastAssistantMessage: '' }))
const data = { statsCache: { version: 1, lastComputedDate: '2026-10-09', dailyActivity: [], dailyModelTokens: [], modelUsage: {}, totalSessions: 0, totalMessages: 0, longestSession: { sessionId: '', duration: 0, messageCount: 0 }, firstSessionDate: '2026-10-09', hourCounts: {}, totalSpeculationTimeSavedMs: 0 }, projects: [], sessions: [], allSessions: [], harnesses, homeDir: home, healthIssues: [], workflows: [] }
let revision = 'qa:1'
let currentData: Record<string, unknown> = data
const calls: Record<string, number> = {}
const timers = new Set<ReturnType<typeof setInterval>>()
const events = new Set<ReadableStreamDefaultController<Uint8Array>>()
const chats = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>()
const turns = new Map<string, unknown[]>()
const nativeControllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
let nativeSeq = 0
const encode = new TextEncoder()
function send(c: ReadableStreamDefaultController<Uint8Array>, event: string, body: unknown) { try { c.enqueue(encode.encode(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`)) } catch {} }
function stream(req: Request, event: string, body: unknown, bucket: Set<ReadableStreamDefaultController<Uint8Array>>) {
  let ping: ReturnType<typeof setInterval>
  const s = new ReadableStream<Uint8Array>({ start(c) {
    bucket.add(c); send(c, event, body)
    ping = setInterval(() => send(c, 'ping', {}), 5_000); timers.add(ping)
    req.signal.addEventListener('abort', () => { bucket.delete(c); clearInterval(ping); try { c.close() } catch {} }, { once: true })
  }, cancel() { clearInterval(ping) } })
  return new Response(s, { headers: { 'Content-Type': 'text/event-stream' } })
}
writeFileSync(join(out, 'host.pid'), String(process.pid))
const backend = Bun.serve({ hostname: '127.0.0.1', port: webPort, fetch(req) {
  const u = new URL(req.url), p = u.pathname
  if (!p.startsWith('/api/') && !p.startsWith('/qa/')) {
    const file = join(dist, p)
    if (file.startsWith(dist + '/') && existsSync(file) && p !== '/') return new Response(Bun.file(file))
    return new Response(Bun.file(join(dist, 'index.html')))
  }
  calls[p] = (calls[p] ?? 0) + 1
  if (p === '/api/data') return Response.json(currentData, { headers: { 'X-Agentistics-Data-Revision': revision } })
  if (p === '/api/events') return stream(req, 'connected', {}, events)
  if (p === '/api/fleet/events') return stream(req, 'snapshot', { seq: 1, sessions: rows, rows, attention: 8, tasks: [], finishedTasks: [], closed: { total: 0, sent: 0 } }, new Set())
  if (p === '/api/fleet') return Response.json({ sessions: rows, rows, attention: 8, tasks: [], finishedTasks: [] })
  if (p === `/api/runtime/sessions/${nativeId}/messages`) return Response.json({ session: { sessionId: nativeId, title: 'QA agentistics', status: 'open', model: 'qa', provider: 'qa', cwd: '/throwaway/qa' }, messages: (turns.get(nativeId) ?? []).map((turn, i) => ({ seq: i + 1, message: { role: (turn as { role: string }).role, content: (turn as { text: string }).text } })) })
  if (p === `/api/runtime/sessions/${nativeId}/runs`) return Response.json({ runs: [] })
  if (p === `/api/runtime/sessions/${nativeId}/stream`) return stream(req, 'message', { kind: 'hello', sessionId: nativeId, cursor: nativeSeq, protocol: 1 }, nativeControllers)
  if (p === '/api/fleet/chat') return Response.json({ turns: turns.get(u.searchParams.get('id')!) ?? [], source: 'adapter', live: true })
  if (p === '/api/fleet/chat-stream') {
    const id = u.searchParams.get('id')!
    const bucket = chats.get(id) ?? new Set(); chats.set(id, bucket)
    return stream(req, 'chat', { turns: turns.get(id) ?? [], source: 'adapter', live: true }, bucket)
  }
  if (p === '/qa/live') {
    const id = u.searchParams.get('id')!
    if (id === nativeId) for (const c of nativeControllers) {
      send(c, 'message', { kind: 'event', seq: ++nativeSeq, event: { type: 'run.started', runId: 'qa-run' } })
      send(c, 'message', { kind: 'delta', seq: ++nativeSeq, runId: 'qa-run', text: `LIVE ${id}` })
    }
    for (const c of chats.get(id) ?? []) { send(c, 'state', { working: true }); send(c, 'live', { text: `LIVE ${id}` }) }
    return Response.json({ ok: true })
  }
  if (p === '/qa/finish') {
    const id = u.searchParams.get('id')!, answer = [{ role: 'user', text: 'QA-1 say only OK' }, { role: 'assistant', text: `DONE ${id}` }]
    turns.set(id, answer)
    if (id === nativeId) for (const c of nativeControllers) send(c, 'message', { kind: 'event', seq: ++nativeSeq, event: { type: 'run.ended', runId: 'qa-run', data: { status: 'done' } } })
    for (const c of chats.get(id) ?? []) {
      send(c, 'chat-delta', { drop: 0, keep: 0, append: answer, meta: { source: 'adapter', live: true } })
      send(c, 'state', { working: false })
    }
    return Response.json({ ok: true })
  }
  if (p === '/qa/patch') {
    const next = { ...currentData, deferredRepos: ['/qa/patch-applied'] }
    const nextRevision = 'qa:2'
    const patch = planDataPatch(currentData, next, revision, nextRevision)
    currentData = next; revision = nextRevision
    for (const c of events) { send(c, 'data-patch', patch); send(c, 'change', { revision }) }
    return Response.json({ ok: true })
  }
  if (p === '/api/preferences' || p === '/api/user-prefs') return Response.json({ archiveMode: 'off', telemetryNoticeDismissed: true, experimental: true, lang: 'en' })
  if (p === '/api/engine') return Response.json({ present: true, manifest: { provides: { nativeRuntime: true } }, nativeExperimental: true })
  if (p === '/api/provider') return Response.json({ providers: [], enabled: true })
  if (p === '/api/hardware-resources') return Response.json({ host: { usedMemoryBytes: null, totalMemoryBytes: null, disk: { usedBytes: null, totalBytes: null, available: false }, loadavg: null, cpuCores: null }, sessions: [], processes: [] })
  if (p === '/api/tasks' || p === '/api/notifications') return Response.json({ tasks: [], notifications: [], items: [], count: 0 })
  if (p === '/api/health') return Response.json({ ok: true })
  if (p === '/api/fleet/act') return Response.json({ ok: true, message: 'Delivered' })
  if (p === '/api/fleet/new') return Response.json({ harnesses: [], projects: [], tasks: [] })
  if (p === '/api/live-sessions') return Response.json({ liveSessionIds: [], liveProcesses: [] })
  return Response.json({})
} })
const env: Record<string, string> = { PATH: process.env.PATH!, USER: process.env.USER ?? 'qa', LANG: 'C.UTF-8', HOME: home, TMPDIR: tmp, AGENTISTICS_DIR: join(sandbox, 'data'), TMUX_TMPDIR: join(sandbox, 'tmux'), PORT: String(apiPort), WEB_PORT: String(webPort), AGENTISTICS_THROWAWAY: '1', AGENTISTICS_TELEMETRY: '0' }
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let page: Page | undefined
const errors: string[] = []
const results: unknown[] = []
const watchdog = setInterval(() => {
  const available = Number(readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0)
  const load = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0])
  if (available < 2 * 1024 * 1024 || load > 8) {
    console.error(`watchdog stopping QA: available=${available}KB load=${load}`)
    void browser?.close(); backend.stop(true)
  }
}, 5_000)
try {
  console.log(`Browser QA ready: ${out}`)
  browser = await chromium.launch({ executablePath: chromium.executablePath(), env })
  page = await browser.newPage()
  page.setDefaultTimeout(20_000)
  page.setDefaultNavigationTimeout(45_000)
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    for (const harness of harnesses) {
      const id = idOf(harness)
      turns.set(id, [])
      await page.goto(`http://127.0.0.1:${webPort}/sessions/${id}`)
      await page.waitForFunction(harness => document.body.textContent?.includes(`QA ${harness}`), harness)
      const connectedAt = Date.now()
      while (!(id === nativeId ? nativeControllers.size : chats.get(id)?.size)) {
        if (Date.now() - connectedAt > 20_000) throw new Error(`chat subscription did not open for ${id}: ${errors.join('; ')}`)
        await Bun.sleep(50)
      }
      await page.waitForTimeout(250)
      await fetch(`http://127.0.0.1:${webPort}/qa/live?id=${id}`)
      await page.getByText(`LIVE ${id}`, { exact: true }).waitFor()
      await page.screenshot({ path: join(out, `${width}-${harness}-live.png`) })
      await fetch(`http://127.0.0.1:${webPort}/qa/finish?id=${id}`)
      await page.getByText(`DONE ${id}`, { exact: true }).waitFor()
      if (await page.getByText(`LIVE ${id}`, { exact: true }).count()) throw new Error(`partial persisted for ${id}`)
      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      if (!noOverflow) throw new Error(`horizontal overflow ${width}/${harness}`)
      if (errors.length) throw new Error(`browser errors: ${errors.join('; ')}`)
      await page.screenshot({ path: join(out, `${width}-${harness}-done.png`) })
      results.push({ width, harness, live: true, done: true, noOverflow })
      console.log(`${width}/${harness}: structured live + done + no overflow`)
    }
  }
  const dataBefore = calls['/api/data'] ?? 0, fleetBefore = calls['/api/fleet'] ?? 0
  await fetch(`http://127.0.0.1:${webPort}/qa/patch`)
  await page.waitForTimeout(31_000)
  if ((calls['/api/data'] ?? 0) !== dataBefore) throw new Error('healthy patch/interval caused a full data GET')
  if ((calls['/api/fleet'] ?? 0) !== fleetBefore) throw new Error('healthy fleet stream caused polling')
  if (calls['/api/fleet/stream']) throw new Error('adapter chat opened terminal captures')
  console.log(JSON.stringify({ out, results, calls, healthyNoPolling: true }, null, 2))
  writeFileSync(join(out, 'results.json'), JSON.stringify({ results, calls, healthyNoPolling: true }, null, 2))
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
  const body = await page?.locator('body').textContent().catch(() => '')
  writeFileSync(join(out, 'failure.json'), JSON.stringify({ error: String(error), errors, body, results, calls }, null, 2))
  throw error
} finally {
  clearInterval(watchdog)
  for (const timer of timers) clearInterval(timer)
  await browser?.close()
  backend.stop(true)
  rmSync(sandbox, { recursive: true, force: true })
  configs.forEach((f, i) => {
    const after = existsSync(join(realHome, f)) ? readFileSync(join(realHome, f)) : null
    // Claude rewrites counters/trust records while other sessions run. Compare its MCP config,
    // and reject this run's ports/paths anywhere; the other three files are config-only.
    if (mentionsRun(after) || configValue(f, before[i]!) !== configValue(f, after)) throw new Error(`real harness MCP config changed: ${f}`)
  })
  console.log(`Evidence: ${out}`)
}
