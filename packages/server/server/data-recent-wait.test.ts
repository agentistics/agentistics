/**
 * PERF.STORM-DATA-P95 — a full `/api/data` read must not sit for the whole FULL_READ_WAIT_MS behind a build when a
 * recent one exists (CI #1548: stormDataP95Ms 2758 against a 500 ceiling, 62 ms on the same sha in the other runs).
 */
import { test, expect } from 'bun:test'
import { fullReadWaitMs, FULL_READ_WAIT_MS, RECENT_BUILD_AGE_MS, RECENT_READ_WAIT_MS } from './data'

test('a recent build shortens the wait of a full read well under the storm budget', () => {
  expect(RECENT_READ_WAIT_MS).toBeLessThan(500)
  expect(fullReadWaitMs(FULL_READ_WAIT_MS, 0)).toBe(RECENT_READ_WAIT_MS)
  expect(fullReadWaitMs(FULL_READ_WAIT_MS, RECENT_BUILD_AGE_MS - 1)).toBe(RECENT_READ_WAIT_MS)
})

test('without a recent build (none, or an old one) the full wait stands', () => {
  expect(fullReadWaitMs(FULL_READ_WAIT_MS, null)).toBe(FULL_READ_WAIT_MS)
  expect(fullReadWaitMs(FULL_READ_WAIT_MS, RECENT_BUILD_AGE_MS)).toBe(FULL_READ_WAIT_MS)
  expect(fullReadWaitMs(FULL_READ_WAIT_MS, 10 * RECENT_BUILD_AGE_MS)).toBe(FULL_READ_WAIT_MS)
})

test('a caller that asked for less keeps it', () => {
  expect(fullReadWaitMs(0, 1000)).toBe(0)
  expect(fullReadWaitMs(100, 1000)).toBe(100)
})

// ---- Integration: the call itself, on the path the storm and CI take (NO client on /api/events) -------------------
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..', '..')

const WARM = `
import { writeFileSync } from 'node:fs'
const data = await import('./data')
await data.buildApiResponse()
await Bun.sleep(1500) // the first build writes the previous-run snapshot
writeFileSync(process.argv[2]!, '{}')
process.exit(0)
`

const COLD = `
import { writeFileSync } from 'node:fs'
const data = await import('./data')
data.setBuildDelayForTest(1500)
const t = performance.now()
const r = await data.buildApiResponseWithin(5000)
writeFileSync(process.argv[2]!, JSON.stringify({ ms: performance.now() - t, stale: r.stale, sessions: r.data.sessions.length }))
process.exit(0)
`

const STORM = `
import { appendFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const data = await import('./data')
const first = (d: string, t: (n: string) => boolean): string => {
  for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) { const r = first(p, t); if (r) return r } else if (t(n)) return p }
  return ''
}
const transcript = first(join(process.env.HOME!, '.claude', 'projects'), n => n.endsWith('.jsonl'))
const sid = transcript.split('/').pop()!.replace('.jsonl', '')
const append = (i: number) => appendFileSync(transcript, JSON.stringify({ type: 'user', sessionId: sid, uuid: 'w-' + i, timestamp: '2026-10-02T11:0' + i + ':00.000Z', message: { role: 'user', content: 'w ' + i } }) + '\\n')
const base = await data.buildApiResponse()
data.setBuildDelayForTest(1500)
// a scheduler build in flight, then a change it does not cover — no SSE client, so markDataDirty zeroes the cache clock
const inflight = data.rebuildNow()
await Bun.sleep(20)
append(1)
data.markDataDirty()
const t = performance.now()
const r = await data.buildApiResponseWithin(5000)
const ms = performance.now() - t
await inflight
data.setBuildDelayForTest(0)
while (data.dataGenerations().done < data.dataGenerations().change) { void data.buildApiResponseWithin(0); await Bun.sleep(50) }
const after = await data.buildApiResponseWithin(5000)
writeFileSync(process.argv[2]!, JSON.stringify({ ms, stale: r.stale, previous: r.data === base, builtAt: r.builtAt ?? 0, afterStale: after.stale }))
process.exit(0)
`

// The first build is OLDER than RECENT_BUILD_AGE_MS (a fake clock, never a real 10 s wait), and a later rebuild
// landed: the age is measured from THAT rebuild (`adoptBuild` stamps it), so the cap still acts. If only the first
// build stamped the clock, every read after the first 10 s of uptime would wait the whole build again (CI #1548).
const LATE = `
import { appendFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const data = await import('./data')
let offset = 0
const realNow = Date.now.bind(Date)
Date.now = () => realNow() + offset
const first = (d: string, t: (n: string) => boolean): string => {
  for (const n of readdirSync(d).sort()) { const p = join(d, n); if (statSync(p).isDirectory()) { const r = first(p, t); if (r) return r } else if (t(n)) return p }
  return ''
}
const transcript = first(join(process.env.HOME!, '.claude', 'projects'), n => n.endsWith('.jsonl'))
const sid = transcript.split('/').pop()!.replace('.jsonl', '')
const append = (i: number) => appendFileSync(transcript, JSON.stringify({ type: 'user', sessionId: sid, uuid: 'l-' + i, timestamp: '2026-10-02T12:0' + i + ':00.000Z', message: { role: 'user', content: 'l ' + i } }) + '\\n')
await data.buildApiResponse()
offset = data.RECENT_BUILD_AGE_MS + 1_000 // the first build is now older than the window
append(1)
data.markDataDirty()
await data.rebuildNow() // a later rebuild lands (the scheduler's), through adoptBuild
const base = await data.buildApiResponseWithin(5000)
data.setBuildDelayForTest(1500)
const inflight = data.rebuildNow()
await Bun.sleep(20)
append(2)
data.markDataDirty()
const t = performance.now()
const r = await data.buildApiResponseWithin(5000)
const ms = performance.now() - t
await inflight
writeFileSync(process.argv[2]!, JSON.stringify({ ms, stale: r.stale, previous: r.data === base.data, baseStale: base.stale }))
process.exit(0)
`

function runChild(src: string, home: string, tag: string): Record<string, number | boolean> {
  const script = join(import.meta.dir, `.data-recent-wait-${tag}-${process.pid}.ts`)
  try {
    writeFileSync(script, src)
    const out = join(home, `out-${tag}.json`)
    const p = Bun.spawnSync([process.execPath, script, out], {
      env: { ...process.env, HOME: home, AGENTISTICS_DIR: join(home, '.agentistics'), AGENTISTICS_TELEMETRY: '0', AGENTISTICS_JOURNAL: '0' },
      cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(`${tag} exited ${p.exitCode}: ${p.stderr.toString().slice(-2000)}`)
    return JSON.parse(readFileSync(out, 'utf-8'))
  } finally {
    rmSync(script, { force: true })
  }
}

function synthHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'data-recent-wait-'))
  const p = Bun.spawnSync([process.execPath, join(REPO, 'scripts/perf/synth-home.ts'), home, '--projects', '6', '--sessions', '60', '--scale', '0.01', '--big', '0'], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().slice(-1000))
  mkdirSync(join(home, '.agentistics'), { recursive: true })
  writeFileSync(join(home, '.agentistics', 'preferences.json'), JSON.stringify({ archiveMode: 'consolidate' }))
  return home
}

test('no client on /api/events (markDataDirty clears the cache clock): a read behind a slow build still gets the cap', () => {
  const home = synthHome()
  try {
    const r = runChild(STORM, home, 'storm')
    expect(r.stale).toBe(true)
    expect(r.previous).toBe(true)
    expect(r.ms as number).toBeLessThan(900) // the build takes 1500 ms; the cap is 250
    expect(r.builtAt as number).toBeGreaterThan(0) // the stale note keeps the time of the build it serves
    expect(r.afterStale).toBe(false) // never stale for ever
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)

test('cold start with a previous-run snapshot: no build yet, so the read WAITS for the first build (never the 250 ms cap)', () => {
  const home = synthHome()
  try {
    runChild(WARM, home, 'warm')
    const r = runChild(COLD, home, 'cold')
    expect(r.stale).toBe(false)
    expect(r.ms as number).toBeGreaterThan(1200)
    expect(r.sessions as number).toBeGreaterThan(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)

test('a rebuild after the first build has aged out keeps the cap: the age runs from the LAST build, not the first', () => {
  const home = synthHome()
  try {
    const r = runChild(LATE, home, 'late')
    expect(r.baseStale).toBe(false)
    expect(r.stale).toBe(true)
    expect(r.previous).toBe(true)
    expect(r.ms as number).toBeLessThan(900) // the build takes 1500 ms; the cap is 250
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)
