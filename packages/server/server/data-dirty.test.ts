/**
 * PERF.SERVIDOR-OCIOSO — with nobody connected the watcher no longer rebuilds every 5–10 s; it marks the data DIRTY
 * and paces the build (`sse.ts`, 30–60 s). This pins the reader half of that contract:
 *
 *  - a REST/MCP read (`buildApiResponse`) of dirty data BUILDS FIRST and answers with the change in it;
 *  - several readers arriving together share ONE on-demand build;
 *  - the browser's partial read and the live-sessions poll (`cachedApiResponse`) answer at once with the previous
 *    build and start the build in the background;
 *  - a clean cache is served without any build (nothing regressed for the watched path).
 *
 * The build keeps per-file state in module memory, so it runs in its own child over a throwaway synthetic HOME.
 */
import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuildRoute } from './sse-route'

const REPO = join(import.meta.dir, '..', '..', '..')

const SCRIPT = `
import { appendFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const out = process.argv[2]!
let builds = 0
const log = console.log
console.log = (...a: unknown[]) => { if (String(a[0]).startsWith('[data] built')) builds++; else log(...a) }
const data = await import('./data')
data.useWatcherDrivenRefresh()
const first = (d: string, t: (n: string) => boolean): string => {
  for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) { const r = first(p, t); if (r) return r } else if (t(n)) return p }
  return ''
}
const msgs = (d: { sessions: { user_message_count?: number }[] }) => d.sessions.reduce((n, s) => n + (s.user_message_count ?? 0), 0)
const base = await data.buildApiResponse()
const b0 = builds
const clean = await data.buildApiResponse()
const cleanBuilds = builds - b0
const transcript = first(join(process.env.HOME!, '.claude', 'projects'), n => n.endsWith('.jsonl'))
const sid = transcript.split('/').pop()!.replace('.jsonl', '')
const append = (i: number) => appendFileSync(transcript, JSON.stringify({ type: 'user', sessionId: sid, uuid: 'dirty-' + i, timestamp: '2026-10-02T11:0' + i + ':00.000Z', message: { role: 'user', content: 'dirty ' + i } }) + '\\n')
// 1) REST read of dirty data builds first, once, for three concurrent readers
append(0)
data.markDataDirty()
const b1 = builds
const [r1, r2, r3] = await Promise.all([data.buildApiResponse(), data.buildApiResponse(), data.buildApiResponse()])
const restBuilds = builds - b1
// 2) the poll path answers at once with the previous build, and starts one
append(1)
data.markDataDirty()
const b2 = builds
const t = performance.now()
const polled = await data.cachedApiResponse()
const pollMs = performance.now() - t
const pollSameObject = polled === r1
await Bun.sleep(50)
while (data.dataDirty()) await Bun.sleep(20)
await data.buildApiResponse()
const pollBuilds = builds - b2
const after = await data.buildApiResponse()
// 3) R1: a reader arriving DURING a scheduler build (rebuildNow, not awaited) that covers the change joins it
append(2)
data.markDataDirty()
const b3 = builds
const inflight = data.rebuildNow()
await Bun.sleep(1)
const mid = await data.buildApiResponse()
await inflight
const midBuilds = builds - b3
// 4) R1: a change counted AFTER the in-flight build started is owed to the reader that arrives after it
append(3)
data.markDataDirty()
const b4 = builds
const early = data.rebuildNow()
append(4)
data.markDataDirty()
const late = await data.buildApiResponse()
await early
const lateBuilds = builds - b4
// 5) R5: the bounded full read answers the previous build flagged stale when the build does not land in time
append(5)
data.markDataDirty()
const t5 = performance.now()
const bounded = await data.buildApiResponseWithin(0)
const boundedMs = performance.now() - t5
while (data.dataGenerations().done < data.dataGenerations().change) await Bun.sleep(20)
const boundedAfter = await data.buildApiResponseWithin(5000)
// 6) R3: a client connecting while the data is dirty triggers the build (at the watched pace); a clean one does not
const sse = await import('./sse')
sse.enableRebuildOnChange()
const b6 = builds
sse.onSseClientConnected()
await Bun.sleep(900)
const connectCleanBuilds = builds - b6
append(6)
data.markDataDirty()
const b7 = builds
sse.onSseClientConnected()
const t7 = Date.now()
while (builds === b7 && Date.now() - t7 < 5000) await Bun.sleep(20)
const connectBuilds = builds - b7
const connectFresh = msgs(await data.buildApiResponse()) > msgs(boundedAfter.data)
writeFileSync(out, JSON.stringify({
  connectCleanBuilds, connectBuilds, connectFresh,
  midSawChange: msgs(mid) > msgs(after), midBuilds,
  lateSawBoth: msgs(late) >= msgs(mid) + 2, lateBuilds,
  boundedStale: bounded.stale, boundedPrevious: bounded.data === late, boundedMs,
  boundedFreshAfter: !boundedAfter.stale && msgs(boundedAfter.data) > msgs(late),
  cleanSame: clean === base, cleanBuilds,
  restBuilds, restShared: r1 === r2 && r2 === r3, restSawChange: msgs(r1) > msgs(base),
  pollSameObject, pollMs, pollBuilds, pollEventuallyFresh: msgs(after) > msgs(r1),
}))
process.exit(0)
`

function run(args: string[], env: Record<string, string>): void {
  const p = Bun.spawnSync(args, { env: { ...process.env, ...env }, cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`${args.join(' ')} exited ${p.exitCode}: ${p.stderr.toString().slice(-2000)}`)
}

test('dirty data: a REST read builds first (once for concurrent readers); the poll read answers at once', () => {
  const home = mkdtempSync(join(tmpdir(), 'data-dirty-'))
  const script = join(import.meta.dir, `.data-dirty-${process.pid}.ts`)
  try {
    run([process.execPath, join(REPO, 'scripts/perf/synth-home.ts'), home, '--projects', '6', '--sessions', '60', '--scale', '0.01', '--big', '0'], {})
    mkdirSync(join(home, '.agentistics'), { recursive: true })
    writeFileSync(join(home, '.agentistics', 'preferences.json'), JSON.stringify({ archiveMode: 'consolidate' }))
    writeFileSync(script, SCRIPT)
    const out = join(home, 'out.json')
    run([process.execPath, script, out], { HOME: home, AGENTISTICS_DIR: join(home, '.agentistics'), AGENTISTICS_TELEMETRY: '0', AGENTISTICS_JOURNAL: '0' })
    const r = JSON.parse(readFileSync(out, 'utf-8')) as Record<string, number | boolean>
    expect(r.cleanSame).toBe(true)
    expect(r.cleanBuilds).toBe(0)
    expect(r.restBuilds).toBe(1)
    expect(r.restShared).toBe(true)
    expect(r.restSawChange).toBe(true)
    expect(r.pollSameObject).toBe(true)
    expect(r.pollMs as number).toBeLessThan(50)
    expect(r.pollBuilds).toBe(1)
    expect(r.pollEventuallyFresh).toBe(true)
    // R1 — a reader arriving mid-build gets that build (it covers the change), no second build
    expect(r.midSawChange).toBe(true)
    expect(r.midBuilds).toBe(1)
    // R1 — a change after the in-flight build started is in what the next reader gets
    expect(r.lateSawBoth).toBe(true)
    // R5 — bounded: past the bound the previous build, flagged stale, at once; then fresh
    expect(r.boundedStale).toBe(true)
    expect(r.boundedPrevious).toBe(true)
    expect(r.boundedMs as number).toBeLessThan(50)
    expect(r.boundedFreshAfter).toBe(true)
    // R3 — onSseClientConnected builds a dirty cache, and leaves a clean one alone
    expect(r.connectCleanBuilds).toBe(0)
    expect(r.connectBuilds).toBe(1)
    expect(r.connectFresh).toBe(true)
  } finally {
    rmSync(script, { force: true })
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)

test('the SSE stream route tells sse.ts a client connected (R3: the build of a dirty cache hangs off this call)', () => {
  const src = readFileSync(join(import.meta.dir, 'index.ts'), 'utf-8')
  const at = src.indexOf('sseClients.add(controller)')
  expect(at).toBeGreaterThan(0)
  const after = src.slice(at, at + 600).replace(/\/\/.*$/gm, '')
  expect(after).toContain('onSseClientConnected()')
})

test('a change goes to the watched pace with a client, to the unwatched pace without one', () => {
  expect(rebuildRoute({ rebuildOnChange: true, clients: 1 })).toBe('watched')
  expect(rebuildRoute({ rebuildOnChange: true, clients: 0 })).toBe('unwatched')
  expect(rebuildRoute({ rebuildOnChange: false, clients: 3 })).toBe('notify-only')
})
