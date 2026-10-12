import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routeRecommendation } from '@agentistics/core'
import {
  __resetPlanLimitsForTest, ingestPlanLimits, latestCodexLimits, noteStructuredLine, planLimitsPayload,
  sampleLivePlanSessions, setPlanLimitsSink, syncPlanLimitsFromFile, watchPlanLimitsFile,
} from './plan-limits'

const fx = (n: string) => readFileSync(join(import.meta.dir, '../../core/src/__fixtures__', n), 'utf8').trim()
let dir = ''
beforeEach(() => { __resetPlanLimitsForTest(); dir = mkdtempSync(join(tmpdir(), 'pl-test-')) })
afterEach(() => { setPlanLimitsSink(null); if (dir.includes('pl-test-')) rmSync(dir, { recursive: true, force: true }) })

test('codex: the newest rate_limits line of a rollout tail', async () => {
  const p = join(dir, 'rollout-x.jsonl')
  const line = fx('plan-limits-codex.jsonl')
  writeFileSync(p, `{"type":"session_meta"}\n${line}\n{"type":"event_msg","payload":{"type":"agent_message"}}\n`)
  const l = await latestCodexLimits(p)
  expect(l?.harness).toBe('codex')
  expect(l?.windows).toHaveLength(2)
})

test('claude: a relayed stream line is stored; older records never replace newer', async () => {
  const rec = JSON.parse(fx('plan-limits-claude.jsonl')) as { t: number; l: string }
  let changed = 0
  setPlanLimitsSink({ changed: () => { changed++ }, notify: () => {} })
  noteStructuredLine(rec.l, rec.t)
  noteStructuredLine('{"type":"assistant"}', rec.t + 1)
  await new Promise(r => setTimeout(r, 10))
  const { limits } = await planLimitsPayload(undefined)
  expect(limits.map(l => l.harness)).toEqual(['claude'])
  expect(changed).toBe(1)
  const older = { ...limits[0]!, updatedAt: rec.t - 1000 }
  expect(await ingestPlanLimits(older)).toBe(false)
})

test('payload exposes pacing budgets alongside limits', async () => {
  const now = Date.now()
  await ingestPlanLimits({ harness: 'codex', account: 'default', plan: 'Plus', windows: [
    { kind: '5h', usedPct: 11, resetsAt: now + 3_600_000 },
    { kind: 'week', usedPct: 35, resetsAt: now + 3 * 86_400_000 },
  ], updatedAt: now, source: 'codex-rollout' })
  const body = await planLimitsPayload(undefined, now)
  expect(body).toHaveProperty('budgets')
  expect(body.budgets[0]).toMatchObject({ harness: 'codex', fiveHourPct: 11, weekPct: 35, paceStatus: 'on' })
  expect(body.budgets[0]!.suggestedParallel).toBeGreaterThanOrEqual(1)
  // The payload row is the FLAT shape the router reads, with no hand-built nested `pace`.
  expect(body.budgets[0]).not.toHaveProperty('pace')
  const rec = routeRecommendation(body.budgets, 'spec-impl')
  expect(rec.harness).toBe('codex')
  expect(rec.cadence.parallel).toBe(body.budgets[0]!.suggestedParallel)
  expect(rec.reason).toContain(body.budgets[0]!.note)
})

test('live usage drops sessions that are no longer live', () => {
  const session = (id: string, tokens: number) => ({ session_id: id, harness: 'codex' as const, model: 'sonnet', input_tokens: tokens })
  sampleLivePlanSessions([session('a', 100), session('b', 0)], ['a', 'b'], 0, { codex: 5 })
  sampleLivePlanSessions([session('a', 200), session('b', 0)], ['a', 'b'], 3_600_000, { codex: 5 })
  sampleLivePlanSessions([session('b', 0)], ['b'], 7_200_000, { codex: 5 })
  const rates = sampleLivePlanSessions([session('a', 300), session('b', 0)], ['a', 'b'], 10_800_000, { codex: 5 })
  expect(rates.find(s => s.id === 'a')?.burnPctPerHour).toBe(2.5)
})

test('pacing pools are per harness: Claude over does not remove Codex slots', async () => {
  const now = Date.parse('2026-11-10T20:00:00Z')
  const hour = 3_600_000
  const weekReset = now + 20 * hour
  const record = (harness: 'claude' | 'codex', used: number, at: number) => ingestPlanLimits({
    harness, account: 'default', plan: harness === 'claude' ? 'Max' : 'Plus',
    windows: [
      { kind: '5h', usedPct: used, resetsAt: now + 4 * hour },
      { kind: 'week', usedPct: used, resetsAt: weekReset },
    ], updatedAt: at, source: harness === 'claude' ? 'claude-stream' : 'codex-rollout',
  })
  await record('claude', 90, now - hour)
  await record('claude', 95, now)
  await record('codex', 10, now - hour)
  await record('codex', 10.1, now)
  const body = await planLimitsPayload(undefined, now, [
    { id: 'c1', harness: 'claude', model: 'opus', burnPctPerHour: 1 },
    { id: 'x1', harness: 'codex', model: 'sonnet', burnPctPerHour: 2 },
  ])
  expect(body.freeSlotsByHarness.claude).toBe(0)
  expect(body.freeSlotsByHarness.codex).toBe(1)
  expect(body.freeSlots).toBe(1)
  const rec = routeRecommendation(body.budgets, 'spec-impl')
  expect(rec.harness).toBe('codex')
  expect(rec.cadence.parallel).toBe(1)
})

test('notices fire once per threshold, the 100% one names an alternative with room', async () => {
  const told: [number, string | null][] = []
  setPlanLimitsSink({ changed: () => {}, notify: (n, alt) => told.push([n.threshold, alt]) })
  const R = Date.now() + 3_600_000
  await ingestPlanLimits({ harness: 'codex', account: 'default', windows: [{ kind: '5h', usedPct: 10, resetsAt: R }], updatedAt: 1, source: 'codex-rollout' })
  const c = (pct: number, at: number) => ingestPlanLimits({ harness: 'claude', account: 'default', windows: [{ kind: '5h', usedPct: pct, resetsAt: R }], updatedAt: at, source: 'claude-stream' })
  await c(80, 2); await c(82, 3); await c(100, 4); await c(100, 5)
  expect(told).toEqual([[75, null], [100, 'codex']])
})

test('a record ANOTHER process wrote reaches the server and the browser (the preview bug)', async () => {
  const file = join(dir, 'plan-limits.json')
  __resetPlanLimitsForTest(file)
  const told: number[] = []
  let changed = 0
  setPlanLimitsSink({ changed: () => { changed++ }, notify: n => told.push(n.threshold) })
  // The server has read the file once: nothing from claude yet.
  expect((await planLimitsPayload(undefined)).limits).toEqual([])
  // Another process (no sink) writes claude's record to the shared file.
  const now = Date.now()
  const rec = { harness: 'claude', account: 'default', windows: [{ kind: '5h', usedPct: 86, resetsAt: now + 3_600_000 }], updatedAt: now, source: 'claude-stream' }
  await new Promise(r => setTimeout(r, 15)) // a different mtime
  writeFileSync(file, JSON.stringify({ limits: { 'claude:default': rec }, notices: {} }))
  expect(await syncPlanLimitsFromFile()).toBe(1)
  expect(changed).toBe(1) // the SSE signal the browser refetches on
  expect(told).toEqual([85]) // the owner raises the notice the writer could not
  expect((await planLimitsPayload(undefined)).limits.map(l => l.harness)).toEqual(['claude'])
  expect(await syncPlanLimitsFromFile()).toBe(0) // unchanged file: nothing again
})

test('the server WATCHES the file: no read needed for the signal', async () => {
  const file = join(dir, 'plan-limits.json')
  writeFileSync(file, JSON.stringify({ limits: {}, notices: {} }))
  __resetPlanLimitsForTest(file)
  let changed = 0
  setPlanLimitsSink({ changed: () => { changed++ }, notify: () => {} })
  await planLimitsPayload(undefined)
  const stop = watchPlanLimitsFile()
  const now = Date.now()
  await new Promise(r => setTimeout(r, 15))
  // Written the way every writer writes it: an atomic rename of a sibling temp file.
  writeFileSync(`${file}.999.tmp`, JSON.stringify({ limits: { 'codex:default': { harness: 'codex', account: 'default', windows: [{ kind: 'week', usedPct: 30, resetsAt: now + 86_400_000 }], updatedAt: now, source: 'codex-rollout' } }, notices: {} }))
  renameSync(`${file}.999.tmp`, file)
  for (let i = 0; i < 40 && changed === 0; i++) await new Promise(r => setTimeout(r, 50))
  stop()
  expect(changed).toBe(1)
})

test('a process with no sink stores the record but judges no threshold', async () => {
  const file = join(dir, 'plan-limits.json')
  __resetPlanLimitsForTest(file)
  setPlanLimitsSink(null)
  const now = Date.now()
  await ingestPlanLimits({ harness: 'claude', account: 'default', windows: [{ kind: '5h', usedPct: 99, resetsAt: now + 3_600_000 }], updatedAt: now, source: 'claude-stream' })
  await new Promise(r => setTimeout(r, 700)) // persistSoon
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  expect(Object.keys(disk.limits)).toEqual(['claude:default'])
  expect(disk.notices).toEqual({})
})
