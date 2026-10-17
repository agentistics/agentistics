import { afterEach, beforeEach, expect, test } from 'bun:test'
import { CODEX_DIR } from './config'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarnessAccounts, probeAccountIdentity, __setHarnessAccountsForTest } from './harness-accounts'
import { planLimitsTool } from '../../mcp/plan-limits-tool'
import { HARNESS_ORDER, routeRecommendation } from '@agentistics/core'
import { noteFreshSpawn, resetHarnessSpawnability } from './sessions/harness-spawnable'
import { spawnOutcome } from './sessions/spawn-outcome'
import {
  __resetPlanLimitsForTest, __setLiveTranscriptPathForTest, foldAliasedLimits, __setManagedLookupForTest, __settleCodexRolloutsForTest, ingestPlanLimits, latestCodexLimits, noteCodexRollout,
  noteStructuredLine, planLimitsPayload, planAccountKey, sampleLivePlanSessions, sessionAccountOf, setPlanLimitsSink, syncPlanLimitsFromFile,
  watchPlanLimitsFile,
} from './plan-limits'
import type { PlanThresholdNotice } from '@agentistics/core'

const fx = (n: string) => readFileSync(join(import.meta.dir, '../../core/src/__fixtures__', n), 'utf8').trim()
let dir = ''
let savedPath: string | undefined
let savedHome: string | undefined
beforeEach(() => {
  __resetPlanLimitsForTest()
  resetHarnessSpawnability()
  // Attribution reads the managed-session registry: a test never reads the owner's real one.
  __setManagedLookupForTest(async () => [])
  __setLiveTranscriptPathForTest(async () => null)
  dir = mkdtempSync(join(tmpdir(), 'pl-test-'))
  savedPath = process.env.PATH
  savedHome = process.env.HOME
  process.env.PATH = dir
  process.env.HOME = dir
  for (const bin of ['claude', 'codex']) {
    writeFileSync(join(dir, bin), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, bin), 0o755)
  }
  __setHarnessAccountsForTest(createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: 'default', label: 'Conta padrão' }) }))
})
afterEach(() => {
  process.env.PATH = savedPath
  process.env.HOME = savedHome
  resetHarnessSpawnability()
  setPlanLimitsSink(null)
  __setManagedLookupForTest(null)
  __setLiveTranscriptPathForTest(null)
  if (dir.includes('pl-test-')) rmSync(dir, { recursive: true, force: true })
})

async function spawnabilityBudget(now: number) {
  for (const harness of ['claude', 'codex'] as const) await ingestPlanLimits({
    harness, account: 'default', plan: harness === 'claude' ? 'Max' : 'Plus',
    windows: [{ kind: '5h', usedPct: 11, resetsAt: now + 3_600_000 }],
    updatedAt: now, source: harness === 'claude' ? 'claude-stream' : 'codex-rollout',
  })
  return planLimitsPayload(undefined, now)
}

test('missing binary keeps usage but removes slots and routing eligibility', async () => {
  unlinkSync(join(dir, 'codex'))
  const body = await spawnabilityBudget(Date.now())
  expect(body.budgets.find(b => b.harness === 'codex')).toMatchObject({
    spawnable: false, freeSlots: 0, suggestedParallel: 0, fiveHourPct: 11,
  })
  expect(body.harnesses.codex?.unavailableReason).toContain('PATH')
  expect(body.freeSlotsByHarness.codex).toBe(0)
  expect(body.freeSlots).toBe(body.freeSlotsByHarness.claude!)
  const rec = routeRecommendation(body.budgets, 'spec-impl')
  expect(rec.harness).toBe('claude')
  expect(rec.alternatives).not.toContain('codex')
})

test('startup failure blocks workers; a later success restores slots and recommendation', async () => {
  const now = Date.now()
  noteFreshSpawn('codex', spawnOutcome(['error: unexpected argument', 'Pane is dead (status 2)']), now, now)
  const failed = await spawnabilityBudget(now)
  expect(failed.harnesses.codex?.spawnable).toBe(false)
  expect(failed.budgets.find(b => b.harness === 'codex')).toMatchObject({ freeSlots: 0, suggestedParallel: 0, fiveHourPct: 11 })
  expect(routeRecommendation(failed.budgets, 'spec-impl').harness).toBe('claude')
  noteFreshSpawn('codex', undefined, now + 1, now + 1)
  const healthy = await planLimitsPayload(undefined, now + 1)
  expect(healthy.harnesses.codex).toEqual({ spawnable: true })
  expect(healthy.budgets.find(b => b.harness === 'codex')!.suggestedParallel).toBeGreaterThan(0)
  expect(routeRecommendation(healthy.budgets, 'spec-impl').harness).toBe('codex')
})

test('when every binary is missing there are no aggregate slots or recommended workers', async () => {
  unlinkSync(join(dir, 'codex'))
  unlinkSync(join(dir, 'claude'))
  const body = await spawnabilityBudget(Date.now())
  expect(body.freeSlots).toBe(0)
  expect(body.freeSlotsByHarness).toEqual({ claude: 0, codex: 0 })
  expect(body.limits).toHaveLength(2)
  expect(routeRecommendation(body.budgets, 'spec-impl')).toMatchObject({
    harness: null, alternatives: [], cadence: { parallel: 0 },
  })
})

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

for (const harness of HARNESS_ORDER) {
  const session = (id: string, tokens: number) => ({ session_id: id, harness, model: 'unknown', input_tokens: tokens })
  const burn = { [`${harness}:default`]: 2 }
  const ids = ['a', 'b', 'c']

  test(`${harness}: idle sessions never share measured plan burn`, async () => {
    const sessions = ids.map(id => session(id, 100))
    expect((await sampleLivePlanSessions(sessions, ids, 0, burn))).toEqual([])
    expect((await sampleLivePlanSessions(sessions, ids, 60_000, burn))).toEqual([])
  })

  test(`${harness}: one working session with token growth takes the whole burn`, async () => {
    await sampleLivePlanSessions(ids.map(id => session(id, 100)), ids, 0, burn)
    const live = await sampleLivePlanSessions([session('a', 103), session('b', 100), session('c', 100)], ids, 60_000, burn, new Set(['a']))
    expect(live).toEqual([{ id: 'a', harness, account: 'default', model: 'unknown', burnPctPerHour: 2 }])
  })

  test(`${harness}: working sessions share burn by token delta, never equally`, async () => {
    await sampleLivePlanSessions(ids.map(id => session(id, 100)), ids, 0, burn)
    const live = await sampleLivePlanSessions([session('a', 103), session('b', 101), session('c', 100)], ids, 60_000, burn, new Set(ids))
    expect(live.map(s => s.burnPctPerHour)).toEqual([1.5, 0.5, 0])
  })

  test(`${harness}: external sessions need a second sample with recent token growth`, async () => {
    expect((await sampleLivePlanSessions([session('a', 100)], ['a'], 0, burn))).toEqual([])
    expect((await sampleLivePlanSessions([session('a', 101)], ['a'], 10 * 60_000, burn))[0]?.burnPctPerHour).toBe(2)
    expect((await sampleLivePlanSessions([session('a', 102)], ['a'], 20 * 60_000 + 1, burn))).toEqual([])
    expect((await sampleLivePlanSessions([session('a', 103)], ['a'], 21 * 60_000, burn))[0]?.burnPctPerHour).toBe(2)
  })

  test(`${harness}: working sessions without billed tokens stay at zero burn`, async () => {
    const sessions = [session('a', 100)]
    const expected = [{ id: 'a', harness, account: 'default', model: 'unknown', burnPctPerHour: 0 }]
    expect((await sampleLivePlanSessions(sessions, ['a'], 0, burn, new Set(['a'])))).toEqual(expected)
    expect((await sampleLivePlanSessions(sessions, ['a'], 60_000, burn, new Set(['a'])))).toEqual(expected)
    expect((await sampleLivePlanSessions(sessions, ['a'], 120_000, burn))).toEqual([])
  })
}

test('live usage drops samples for sessions that are no longer live', async () => {
  const session = (tokens: number) => ({ session_id: 'a', harness: HARNESS_ORDER[0]!, input_tokens: tokens })
  await sampleLivePlanSessions([session(100)], ['a'], 0)
  await sampleLivePlanSessions([], [], 60_000)
  expect((await sampleLivePlanSessions([session(200)], ['a'], 120_000))).toEqual([])
})

test('token resets and samples from the future do not establish activity', async () => {
  const session = (tokens: number) => ({ session_id: 'a', harness: HARNESS_ORDER[0]!, input_tokens: tokens })
  await sampleLivePlanSessions([session(100)], ['a'], 60_000)
  expect((await sampleLivePlanSessions([session(101)], ['a'], 0))).toEqual([])
  expect((await sampleLivePlanSessions([session(50)], ['a'], 60_000))).toEqual([])
})

test('waiting fleet payload has no live sessions and uses plan burn alone for slots', async () => {
  const now = Date.parse('2026-11-10T20:00:00Z')
  await ingestPlanLimits({ harness: 'codex', account: 'default', windows: [
    { kind: 'week', usedPct: 50, resetsAt: now + 10 * 3_600_000 },
  ], updatedAt: now - 3_600_000, source: 'codex-rollout' })
  await ingestPlanLimits({ harness: 'codex', account: 'default', windows: [
    { kind: 'week', usedPct: 52, resetsAt: now + 10 * 3_600_000 },
  ], updatedAt: now, source: 'codex-rollout' })
  const sessions = ['a', 'b', 'c'].map(session_id => ({ session_id, harness: 'codex', input_tokens: 100 }))
  const ids = sessions.map(s => s.session_id)
  await sampleLivePlanSessions(sessions, ids, now - 60_000, { 'codex:default': 2 })
  const live = await sampleLivePlanSessions(sessions, ids, now, { 'codex:default': 2 }, new Set())
  const body = await planLimitsPayload(undefined, now, live)
  expect(body.liveSessions).toEqual([])
  expect(body.budgets[0]?.burnPctPerHour).toBe(2)
  expect(body.freeSlotsByHarness.codex).toBe(2)

  const measured = [{ id: 'measured', harness: 'codex' as const, model: 'unknown', burnPctPerHour: 2 }]
  const baseline = await planLimitsPayload(undefined, now, measured)
  const withUnbilled = await planLimitsPayload(undefined, now, [
    ...measured, { id: 'unbilled', harness: 'codex', model: 'unknown', burnPctPerHour: 0 },
  ])
  expect(withUnbilled.freeSlotsByHarness).toEqual(baseline.freeSlotsByHarness)
  expect(withUnbilled.budgets[0]?.liveSessions).toEqual(baseline.budgets[0]?.liveSessions)
  expect(withUnbilled.liveSessions.map(s => s.id)).toEqual(['measured', 'unbilled'])
  const onlyUnbilled = await planLimitsPayload(undefined, now, [
    { id: 'unbilled', harness: 'codex', model: 'unknown', burnPctPerHour: 0 },
  ])
  expect(onlyUnbilled.freeSlotsByHarness).toEqual(body.freeSlotsByHarness)
})

test('plan limits handler peeks at working fleet identities without reading the hub', () => {
  const source = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
  const handler = source.slice(source.indexOf("if (url.pathname === '/api/plan-limits'"), source.indexOf("if (url.pathname === '/api/events'"))
  expect(handler).toContain('processSessionHub()?.last()')
  expect(handler).not.toMatch(/\.read\s*\(/)
  expect(handler).toContain("s.activity === 'working'")
  expect(handler).toContain('s.conversationId')
  expect(handler).toContain('s.conversationStoreId')
  expect(handler).toContain('s.id')
  expect(handler).toContain('burnByAccount, working)')
  expect(handler).not.toContain('burnByHarness')
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

test('aggregate free slots ignore held plans', async () => {
  const now = Date.parse('2026-11-10T20:00:00Z')
  const hour = 3_600_000
  const weekReset = now + 20 * hour
  const record = (harness: 'claude' | 'codex', five: number, week: number) => ingestPlanLimits({
    harness, account: 'default', plan: harness === 'claude' ? 'Max' : 'Plus',
    windows: [
      { kind: '5h', usedPct: five, resetsAt: now + 4 * hour },
      { kind: 'week', usedPct: week, resetsAt: weekReset },
    ], updatedAt: now, source: harness === 'claude' ? 'claude-stream' : 'codex-rollout',
  })
  await record('claude', 92, 35)
  await record('codex', 10, 35)
  const body = await planLimitsPayload(undefined, now)
  expect(body.freeSlotsByHarness.claude).toBe(0)
  expect(body.freeSlots).toBe(body.freeSlotsByHarness.codex ?? 0)
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

test('unavailable current accounts disappear from agent budgets, slots, sessions and recommendations', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async harness => ({ key: `${harness}-login`, label: harness }) })
  __setHarnessAccountsForTest(store)
  await store.current(['claude', 'codex'])
  await store.setAvailable('claude', 'claude-login', false)
  const now = Date.now()
  for (const harness of ['claude', 'codex'] as const) await ingestPlanLimits({
    harness, account: 'default', plan: 'Plus', windows: [{ kind: '5h', usedPct: 10, resetsAt: now + 3_600_000 }],
    updatedAt: now, source: harness === 'claude' ? 'claude-stream' : 'codex-rollout',
  })
  const body = await planLimitsPayload(undefined, now, [{ id: 'hidden-session', harness: 'claude', model: 'opus', burnPctPerHour: 1 }])
  // The probe confirmed each harness's login, so the legacy 'default' meters moved to its account.
  expect(body.limits.every(l => l.account.startsWith('acc_'))).toBe(true)
  expect(body.budgets.map(b => b.harness)).toEqual(['codex'])
  expect(body.hiddenFromAgents.map(b => b.harness)).toEqual(['claude'])
  expect(body.freeSlotsByHarness.claude).toBeUndefined()
  expect(body.freeSlots).toBe(body.freeSlotsByHarness.codex!)
  expect(body.liveSessions).toEqual([])
  const rec = routeRecommendation(body.budgets, 'spec-impl')
  expect(rec.harness).toBe('codex')
  expect(rec.alternatives).not.toContain('claude')
  const agentResponse = planLimitsTool({ kind: 'spec-impl' }, body)
  expect(agentResponse).not.toHaveProperty('hiddenFromAgents')
  expect(JSON.stringify(agentResponse)).not.toContain('claude')
  await store.setAvailable('codex', 'codex-login', false)
  const hidden = await planLimitsPayload(undefined, now)
  expect(hidden.budgets).toEqual([])
  expect(hidden.freeSlots).toBe(0)
  expect(hidden.freeSlotsByHarness).toEqual({})
  expect(hidden.pauseUntil).toBeUndefined()
  expect(routeRecommendation(hidden.budgets, 'spec-impl').harness).toBeNull()
})

test('real auth and config file probes expose only identity fields in results, registry and payload', async () => {
  const home = join(dir, 'home')
  const directories = { codexHome: join(home, '.codex'), copilotHome: join(home, '.copilot') }
  const file = join(dir, 'accounts.json')
  mkdirSync(join(home, '.codex'), { recursive: true })
  mkdirSync(join(home, '.copilot'), { recursive: true })
  // Obviously fake placeholders exercise the actual credential-document I/O boundary.
  const fake = {
    OPENAI_API_KEY: 'FAKE_API_KEY',
    tokens: { access_token: 'FAKE_ACCESS_TOKEN', refresh_token: 'FAKE_REFRESH_TOKEN', id_token: 'FAKE_ID_TOKEN' },
  }
  writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ account_id: 'fixture-account', ...fake }))
  writeFileSync(join(home, '.copilot', 'config.json'), JSON.stringify({
    lastLoggedInUser: { login: 'fixture-user', host: 'github.com', token: 'FAKE_USER_TOKEN' },
    github_token: 'FAKE_GITHUB_TOKEN', ...fake,
  }))
  const results = await Promise.all([probeAccountIdentity('codex', directories), probeAccountIdentity('copilot', directories)])
  expect(results).toEqual([
    { key: 'fixture-account', label: 'fixture-account' },
    { key: 'github.com:fixture-user', label: 'fixture-user' },
  ])
  // Use the real file-reading probes with explicit roots; never rely on HOME or read owner files.
  const store = createHarnessAccounts({ file, probe: harness => probeAccountIdentity(harness, directories) })
  __setHarnessAccountsForTest(store)
  const accounts = await store.current(['codex', 'copilot'])
  const now = Date.now()
  await ingestPlanLimits({ harness: 'codex', account: 'default', windows: [{ kind: '5h', usedPct: 10, resetsAt: now + 3_600_000 }], updatedAt: now, source: 'codex-rollout' })
  const body = await planLimitsPayload(undefined, now, [{ id: 'fixture-session', harness: 'copilot', model: 'fixture-model', burnPctPerHour: 0 }])
  for (const output of [JSON.stringify(results), JSON.stringify(accounts), readFileSync(file, 'utf8'), JSON.stringify(body), JSON.stringify(planLimitsTool({ kind: 'spec-impl' }, body))]) {
    expect(output).not.toContain('FAKE')
    for (const field of ['tokens', 'access_token', 'refresh_token', 'id_token', 'OPENAI_API_KEY', 'github_token']) expect(output).not.toContain(field)
  }
})

test('disabled account stays hidden through probe timeout, restart, error and successful recovery', async () => {
  let now = Date.now()
  let mode: 'success' | 'timeout' | 'error' = 'success'
  const file = join(dir, 'accounts.json')
  const options = { file, now: () => now, timeoutMs: 15, probe: async () => {
    if (mode === 'timeout') return await new Promise<{ key: string; label: string }>(() => {})
    if (mode === 'error') throw new Error('Probe unavailable')
    return { key: 'known-login', label: 'Known account' }
  } }
  let store = createHarnessAccounts(options)
  __setHarnessAccountsForTest(store)
  const [account] = await store.current(['claude'])
  await store.setAvailable('claude', 'known-login', false)
  // Routing requires a registered plan, independently of the account availability toggle.
  await ingestPlanLimits({ harness: 'claude', account: 'default', plan: 'Max', windows: [{ kind: '5h', usedPct: 10, resetsAt: now + 3_600_000 }], updatedAt: now, source: 'claude-stream' })
  const registry = readFileSync(file, 'utf8')
  const assertHidden = async () => {
    const body = await planLimitsPayload(undefined, now, [{ id: 'disabled-session', harness: 'claude', model: 'opus', burnPctPerHour: 1 }])
    expect(body.budgets).toEqual([])
    expect(body.freeSlots).toBe(0)
    expect(body.freeSlotsByHarness).toEqual({})
    expect(body.liveSessions).toEqual([])
    expect(body.hiddenFromAgents.map(b => b.harness)).toEqual(['claude'])
    const output = planLimitsTool({ kind: 'spec-impl' }, body)
    expect(output.recommendation?.harness).toBeNull()
    expect(JSON.stringify(output)).not.toContain('claude')
    expect(JSON.stringify(output)).not.toContain('disabled-session')
  }
  await assertHidden()
  now += 60_000
  mode = 'timeout'
  expect((await store.current(['claude']))[0]).toMatchObject({ key: 'default', available: false })
  await assertHidden()
  expect(readFileSync(file, 'utf8')).toBe(registry)
  store = createHarnessAccounts(options)
  __setHarnessAccountsForTest(store)
  await assertHidden() // A cold cache timeout preserves the persisted restriction.
  now += 60_000
  mode = 'error'
  await assertHidden()
  expect(readFileSync(file, 'utf8')).toBe(registry)
  now += 60_000
  mode = 'success'
  expect((await store.current(['claude']))[0]).toMatchObject({ key: 'known-login', available: false })
  await assertHidden()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    version: 2,
    accounts: [{ ...account, available: false, lastSeen: now }],
    bindings: { 'claude:': account!.id },
    segments: {},
  })
  await store.setAvailable('claude', 'known-login', true)
  const recovered = await planLimitsPayload(undefined, now)
  expect(recovered.budgets.map(b => b.harness)).toEqual(['claude'])
  expect(recovered.hiddenFromAgents).toEqual([])
  expect(recovered.budgets[0]).toMatchObject({ plan: 'Max', status: 'ok' })
  expect(planLimitsTool({ kind: 'spec-impl' }, recovered).recommendation?.harness).toBe('claude')
})

test('disabled meterless account live sessions are hidden from payload and MCP', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: 'default', label: 'Conta padrão' }) })
  __setHarnessAccountsForTest(store)
  await store.current(['gemini'])
  await store.setAvailable('gemini', 'default', false)
  const now = Date.now()
  await ingestPlanLimits({ harness: 'codex', account: 'default', windows: [{ kind: '5h', usedPct: 10, resetsAt: now + 3_600_000 }], updatedAt: now, source: 'codex-rollout' })
  const sessions = [
    { id: 'meterless-disabled', harness: 'gemini' as const, model: 'gemini', burnPctPerHour: 0 },
    { id: 'visible-session', harness: 'codex' as const, model: 'codex', burnPctPerHour: 1 },
  ]
  const body = await planLimitsPayload(undefined, now, sessions)
  expect(body.limits.map(l => l.harness)).toEqual(['codex'])
  expect(body.liveSessions.map(s => s.id)).toEqual(['visible-session'])
  expect(body.freeSlotsByHarness.gemini).toBeUndefined()
  const output = planLimitsTool({ kind: 'spec-impl' }, body)
  expect(output.liveSessions.map(s => s.id)).toEqual(['visible-session'])
  expect(JSON.stringify(output)).not.toContain('gemini')
  expect(JSON.stringify(output)).not.toContain('meterless-disabled')
  await store.setAvailable('gemini', 'default', true)
  expect((await planLimitsPayload(undefined, now, sessions)).liveSessions.map(s => s.id)).toEqual(['meterless-disabled', 'visible-session'])
})

test('a hidden harness is absent from the harnesses map while a visible non-spawnable one keeps its reason', async () => {
  const now = Date.now()
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), now: () => now, probe: async () => ({ key: 'known-login', label: 'Known account' }) })
  __setHarnessAccountsForTest(store)
  await store.current(['claude'])
  await store.setAvailable('claude', 'known-login', false)
  await ingestPlanLimits({ harness: 'claude', account: 'default', plan: 'Max', windows: [{ kind: '5h', usedPct: 10, resetsAt: now + 3_600_000 }], updatedAt: now, source: 'claude-stream' })
  const body = await planLimitsPayload(undefined, now, [])
  expect(Object.keys(body.harnesses)).not.toContain('claude')
  expect(JSON.stringify(planLimitsTool({ kind: 'spec-impl' }, body))).not.toContain('claude')
  // gemini has no binary on this PATH: visible to agents, not spawnable, reason kept.
  expect(body.harnesses.gemini?.spawnable).toBe(false)
  expect(body.harnesses.gemini?.unavailableReason).toBeTruthy()
})

// ─── C1: meter attribution + switch detection (spec §5; D1–D3 of §1) ─────────────────────────

const H = 3_600_000
/** A claude `rate_limit_event` stream line; `week`/`fiveHour` are [percent, resetsAt ms]. */
const claudeLine = (week: [number, number], fiveHour?: [number, number]) => JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: { unifiedWindows: {
    seven_day: { utilization: week[0] / 100, resetsAt: week[1] / 1000 },
    ...(fiveHour ? { five_hour: { utilization: fiveHour[0] / 100, resetsAt: fiveHour[1] / 1000 } } : {}),
  } },
})
/** Wait until the fire-and-forget taps have landed; a condition never met FAILS, never passes on. */
const until = async (ok: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out waiting for the plan-limits tap')
    await new Promise(r => setTimeout(r, 10))
  }
}
const sinkLog = () => {
  const told: PlanThresholdNotice[] = []
  const segments: { harness: string; account: string; at: number }[] = []
  setPlanLimitsSink({ changed: () => {}, notify: n => { told.push(n) }, segment: x => { segments.push(x) } })
  return { told, segments }
}
const accountsWithLogin = (key: { value: string }) => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async harness => ({ key: `${harness}-${key.value}`, label: key.value }) })
  __setHarnessAccountsForTest(store)
  return store
}
const now0 = () => Math.floor(Date.now() / 1000) * 1000

test('D1: a login switch in one root stores the new account apart; the old record and its hold stay', async () => {
  const login = { value: 'alice' }
  const store = accountsWithLogin(login)
  await store.current(['claude'])
  const alice = (await store.readAccounts()).bindings['claude:']!
  const { told } = sinkLog()
  const now = now0()
  noteStructuredLine(claudeLine([96, now + 72 * H], [50, now + 2 * H]), now - 60_000)
  await until(async () => (await planLimitsPayload(undefined, now)).limits.length === 1)
  login.value = 'bob' // the owner logged another account into the same root
  noteStructuredLine(claudeLine([10, now + 24 * H], [5, now + 4 * H]), now)
  await until(async () => (await planLimitsPayload(undefined, now)).limits.length === 2)
  const bob = (await store.readAccounts()).bindings['claude:']!
  expect(bob).not.toBe(alice)
  const body = await planLimitsPayload(undefined, now)
  const byAccount = Object.fromEntries(body.limits.map(l => [l.account, l]))
  expect(Object.keys(byAccount).sort()).toEqual([alice, bob].sort())
  expect(byAccount[alice]!.windows.find(w => w.kind === 'week')!.usedPct).toBe(96)
  expect(byAccount[bob]!.windows.find(w => w.kind === 'week')!.usedPct).toBe(10)
  // Alice's weekly hold is not lifted by Bob's low reading.
  expect(body.budgets.some(b => b.status === 'hold' && b.weekPct === 96)).toBe(true)
  // Notices are independent: Bob's EARLIER weekly reset still tells 95 % (D3 through a switch).
  noteStructuredLine(claudeLine([96, now + 24 * H], [5, now + 4 * H]), now + 1000)
  await until(() => told.length === 2)
  expect(told.map(n => [n.account, n.kind, n.threshold])).toEqual([[alice, 'week', 95], [bob, 'week', 95]])
})

test('D2: a sharp drop the probe cannot explain starts a segment — burn restarts, no under dip', async () => {
  const store = accountsWithLogin({ value: 'alice' })
  await store.current(['claude'])
  const alice = (await store.readAccounts()).bindings['claude:']!
  const { segments } = sinkLog()
  const now = now0()
  noteStructuredLine(claudeLine([50, now + 72 * H]), now - 2 * H)
  await until(async () => (await planLimitsPayload(undefined, now)).limits.length === 1)
  noteStructuredLine(claudeLine([60, now + 72 * H]), now - H)
  await until(async () => (await planLimitsPayload(undefined, now)).limits[0]?.updatedAt === now - H)
  noteStructuredLine(claudeLine([20, now + 120 * H]), now)
  await until(() => segments.length === 1)
  expect(segments).toEqual([{ harness: 'claude', account: alice, at: now }])
  expect((await store.readAccounts()).segments[alice]).toBe(now)
  const body = await planLimitsPayload(undefined, now)
  expect(body.limits.map(l => l.account)).toEqual([alice])
  const [pace] = body.budgets
  // Only the new segment counts: one reading, so the burn reads at the sustainable rate.
  expect(pace!.paceStatus).not.toBe('under')
  expect(pace!.burnPctPerHour).toBeCloseTo(pace!.sustainablePctPerHour)
})

test('D3: a reading from another account\'s session neither lifts a hold nor mutes its own notice', async () => {
  const store = accountsWithLogin({ value: 'alice' })
  await store.current(['claude'])
  const alice = (await store.readAccounts()).bindings['claude:']!
  const { account: bob } = await store.bind(join(dir, 'claude-bob'), { harness: 'claude', key: 'claude-bob', label: 'bob' })
  const { told } = sinkLog()
  const now = now0()
  noteStructuredLine(claudeLine([96, now + 72 * H]), now - 60_000)
  await until(() => told.length === 1)
  // A structured session running on Bob's account: its stream carries Bob's (earlier) reset.
  noteStructuredLine(claudeLine([96, now + 24 * H]), now, Promise.resolve(bob.id))
  await until(() => told.length === 2)
  expect(told.map(n => [n.account, n.resetsAt])).toEqual([[alice, now + 72 * H], [bob.id, now + 24 * H]])
  const body = await planLimitsPayload(undefined, now)
  expect(Object.fromEntries(body.limits.map(l => [l.account, l.updatedAt]))).toEqual({ [alice]: now - 60_000, [bob.id]: now })
})

test('codex: a rollout under no known root is dropped; an account root and a linked session attribute it', async () => {
  const store = accountsWithLogin({ value: 'alice' })
  const line = fx('plan-limits-codex.jsonl')
  const uuid = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`
  const rollout = (root: string, n: number) => {
    const d = join(root, 'sessions', '2026', '10', '10')
    mkdirSync(d, { recursive: true })
    const p = join(d, `rollout-2026-10-10T00-00-0${n}-${uuid(n)}.jsonl`)
    writeFileSync(p, `${line}\n`)
    return p
  }
  noteCodexRollout(rollout(join(dir, 'elsewhere'), 1))
  await __settleCodexRolloutsForTest() // the read and its attribution have finished: nothing stored
  expect((await planLimitsPayload(undefined)).limits).toEqual([])
  const root = join(dir, 'codex-second')
  const { account } = await store.bind(root, { harness: 'codex', key: 'codex-second', label: 'second' })
  noteCodexRollout(rollout(root, 2))
  await __settleCodexRolloutsForTest()
  expect((await planLimitsPayload(undefined)).limits.map(l => l.account)).toEqual([account.id])
  __setManagedLookupForTest(async () => [{ id: 'm1', conversationId: uuid(3), accountId: 'acc_linked00000' }])
  noteCodexRollout(rollout(join(dir, 'elsewhere'), 3))
  await __settleCodexRolloutsForTest()
  expect((await planLimitsPayload(undefined)).limits.map(l => l.account).sort()).toEqual(['acc_linked00000', account.id].sort())
})

test('migration: a claude:default record and its notices move to the default root\'s confirmed account', async () => {
  const store = accountsWithLogin({ value: 'alice' })
  await store.current(['claude'])
  const alice = (await store.readAccounts()).bindings['claude:']!
  const now = now0()
  const file = join(dir, 'plan-limits.json')
  const rec = { harness: 'claude', account: 'default', windows: [{ kind: 'week', usedPct: 80, resetsAt: now + 72 * H }], updatedAt: now, source: 'claude-stream' }
  writeFileSync(file, JSON.stringify({ limits: { 'claude:default': rec }, notices: { 'claude:default:week': { resetsAt: now + 72 * H, told: 75 } } }))
  __resetPlanLimitsForTest(file)
  setPlanLimitsSink({ changed: () => {}, notify: () => {} })
  const body = await planLimitsPayload(undefined, now)
  expect(body.limits.map(l => l.account)).toEqual([alice])
  await new Promise(r => setTimeout(r, 700)) // persistSoon
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  expect(Object.keys(disk.limits)).toEqual([`claude:${alice}`])
  expect(disk.notices).toEqual({ [`claude:${alice}:week`]: { resetsAt: now + 72 * H, told: 75 } })
  // The migrated legacy record is never re-ingested from an older file under its old key.
  expect(await ingestPlanLimits({ ...rec, windows: rec.windows as never } as never)).toBe(false)
})

test('L1: two racing discontinuous readings — the newer one wins and ONE segment opens', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async harness => {
    await new Promise(r => setTimeout(r, 40)) // the probe is slow: both readings are in flight at once
    return { key: `${harness}-alice`, label: 'alice' }
  } })
  __setHarnessAccountsForTest(store)
  await store.current(['claude'])
  const alice = (await store.readAccounts()).bindings['claude:']!
  const { segments } = sinkLog()
  const now = now0()
  const rec = (week: number, resetsAt: number, updatedAt: number) => ({ harness: 'claude' as const, account: alice, windows: [{ kind: 'week' as const, usedPct: week, resetsAt }], updatedAt, source: 'claude-stream' as const })
  expect(await ingestPlanLimits(rec(60, now + 72 * H, now - 2 * H))).toBe(true)
  const [newer, older] = await Promise.all([
    ingestPlanLimits(rec(20, now + 120 * H, now)),
    ingestPlanLimits(rec(22, now + 120 * H, now - H)),
  ])
  expect([newer, older]).toEqual([true, false])
  const body = await planLimitsPayload(undefined, now)
  expect(body.limits.find(l => l.account === alice)!.updatedAt).toBe(now)
  expect(segments).toEqual([{ harness: 'claude', account: alice, at: now }])
})

test('L2: a session whose account is not known yet is looked up again on the next line', async () => {
  let calls = 0
  let rows: { id: string; accountId?: string }[] = []
  __setManagedLookupForTest(async () => { calls++; return rows })
  const accountOf = sessionAccountOf('m1')
  expect(await accountOf()).toBeUndefined()
  rows = [{ id: 'm1', accountId: 'acc_known' }]
  expect(await accountOf()).toBe('acc_known')
  expect(await accountOf()).toBe('acc_known')
  expect(calls).toBe(2) // the miss was retried; the hit was remembered
})

test('L4: a default binding confirmed after boot migrates the legacy record; removing it frees default readings', async () => {
  const login = { value: 'alice' }
  const store = accountsWithLogin(login)
  const now = now0()
  const legacy = (updatedAt: number) => ({ harness: 'claude' as const, account: 'default', windows: [{ kind: 'week' as const, usedPct: 40, resetsAt: now + 72 * H }], updatedAt, source: 'claude-stream' as const })
  setPlanLimitsSink({ changed: () => {}, notify: () => {} })
  expect(await ingestPlanLimits(legacy(now - H))).toBe(true) // no binding yet: stays 'default'
  await store.current(['claude']) // the login is confirmed AFTER boot
  const alice = (await store.readAccounts()).bindings['claude:']!
  const body = await planLimitsPayload(undefined, now)
  expect(body.limits.map(l => l.account)).toEqual([alice])
  // The binding goes away (the default root was removed): a 'default' reading is no longer dropped.
  const file = join(dir, 'accounts.json')
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...doc, bindings: {} }))
  expect(await ingestPlanLimits(legacy(now))).toBe(true)
})

test('C2: one row per visible account; off accounts only in hiddenFromAgents; slots summed; MCP clean', async () => {
  const store = accountsWithLogin({ value: 'alice' })
  const now = now0()
  const mk = async (harness: 'claude' | 'codex', n: string, patch: { available?: boolean; nickname?: string } = {}) => {
    const { account } = await store.bind(join(dir, `${harness}-${n}`), { harness, key: `${harness}-${n}`, label: `${n}@example.com` })
    if (Object.keys(patch).length) await store.update(account.id, patch)
    await ingestPlanLimits({ harness, account: account.id, plan: harness === 'claude' ? 'Max' : 'Plus', source: harness === 'claude' ? 'claude-stream' : 'codex-rollout', updatedAt: now,
      windows: [{ kind: '5h', usedPct: 10, resetsAt: now + 3 * H }, { kind: 'week', usedPct: 30, resetsAt: now + 72 * H }] })
    return account.id
  }
  const c1 = await mk('claude', 'one', { nickname: 'Work' })
  const c2 = await mk('claude', 'two', { available: false })
  const c3 = await mk('claude', 'three')
  const x1 = await mk('codex', 'one', { nickname: 'me@x.com' }) // an address is never a label
  const x2 = await mk('codex', 'two', { available: false })
  const body = await planLimitsPayload(undefined, now)
  expect(body.limits.map(l => l.account).sort()).toEqual([c1, c2, c3, x1, x2].sort())
  expect(body.limits.every(l => typeof l.label === 'string')).toBe(true) // owner-only login label
  expect(body.budgets.map(b => b.account).sort()).toEqual([c1, c3, x1].sort())
  expect(body.hiddenFromAgents.map(b => b.account).sort()).toEqual([c2, x2].sort())
  const labels = Object.fromEntries(body.budgets.map(b => [b.account, b.accountLabel]))
  expect(labels[c1]).toBe('Work')
  expect(labels[x1]).toMatch(/^Codex CLI #\d+$/)
  expect(labels[c3]).toMatch(/^Claude Code #\d+$/)
  // Σ over the harness's visible accounts, with the parts alongside.
  expect(Object.keys(body.freeSlotsByAccount).sort()).toEqual([c1, c3, x1].sort())
  expect(body.freeSlotsByHarness.claude).toBe(body.freeSlotsByAccount[c1]! + body.freeSlotsByAccount[c3]!)
  expect(body.freeSlotsByHarness.codex).toBe(body.freeSlotsByAccount[x1]!)
  const out = JSON.stringify(planLimitsTool({ kind: 'spec-impl' }, body))
  expect(out).not.toContain('@')
  expect(out).not.toContain('example.com')
  for (const hidden of [c2, x2, 'hiddenFromAgents', '"limits"', '"label"']) expect(out).not.toContain(hidden)
  for (const shown of [c1, c3, x1, 'freeSlotsByAccount']) expect(out).toContain(shown)
})

for (const harness of HARNESS_ORDER) {
  test(`N1 ${harness}: a bound default account keeps legacy and external session burn`, async () => {
    const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => { throw new Error('No probe') } })
    __setHarnessAccountsForTest(store)
    await store.bind(null, { harness, key: 'bound', label: 'Bound' })
    const registry = await store.readAccounts()
    const bound = registry.bindings[`${harness}:`]!
    // Use a stable, migrated id and no fictional SessionMeta.account field.
    writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ ...registry,
      accounts: registry.accounts.map(a => ({ ...a, id: 'acc_x' })), bindings: { [`${harness}:`]: 'acc_x' },
    }))
    const now = now0()
    for (const [at, used] of [[now - H, 20], [now, 24]] as const) {
      await ingestPlanLimits({ harness, account: 'acc_x', source: 'codex-rollout', updatedAt: at,
        windows: [{ kind: 'week', usedPct: used, resetsAt: now + 24 * H }] })
    }
    expect(bound).toBeTruthy()
    let reads = 0
    __setManagedLookupForTest(async () => { reads++; return [{ id: 'managed-legacy', conversationId: 'legacy' }] })
    const sampled = async (id: string) => {
      const latest = await planLimitsPayload(undefined, now)
      const burn = Object.fromEntries([...latest.budgets, ...latest.hiddenFromAgents].map(b => [planAccountKey(b.harness, b.account), b.burnPctPerHour]))
      const session = (tokens: number) => ({ session_id: id, harness, input_tokens: tokens })
      await sampleLivePlanSessions([session(100)], [id], now - 60_000, burn)
      const live = await sampleLivePlanSessions([session(101)], [id], now, burn, new Set([id]))
      expect(live[0]).toMatchObject({ account: 'acc_x', burnPctPerHour: latest.budgets[0]!.burnPctPerHour })
      expect(live[0]!.burnPctPerHour).toBeGreaterThan(0)
      const body = await planLimitsPayload(undefined, now, live)
      expect(body.budgets[0]!.liveSessions.map(s => s.id)).toEqual([id])
      expect(body.liveSessions.map(s => s.id)).toEqual([id])
      return body
    }
    const external = await sampled('external')
    const legacy = await sampled('legacy')
    expect(external.freeSlotsByAccount).toEqual(legacy.freeSlotsByAccount)
    expect(reads).toBe(4)
  })

  for (const retired of [false, true]) {
    test(`N2 ${harness}: ${retired ? 'retired' : 'hidden'} roots hide only their own external sessions`, async () => {
      const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => { throw new Error('No probe') } })
      __setHarnessAccountsForTest(store)
      const now = now0()
      const hiddenRoot = join(dir, 'hidden')
      const { account: hidden } = await store.bind(hiddenRoot, { harness, key: 'hidden', label: 'Hidden' })
      const { account: visible } = await store.bind(join(dir, 'visible'), { harness, key: 'visible', label: 'Visible' })
      if (retired) {
        const doc = await store.readAccounts()
        writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ ...doc, accounts: doc.accounts.map(a => a.id === hidden.id ? { ...a, retired: true } : a) }))
      } else await store.update(hidden.id, { available: false })
      for (const [account, burn] of [[hidden.id, 10], [visible.id, 2]] as const) {
        for (const [at, used] of [[now - H, 20], [now, 20 + burn]] as const) {
          await ingestPlanLimits({ harness, account, source: 'codex-rollout', updatedAt: at,
            windows: [{ kind: 'week', usedPct: used, resetsAt: now + 24 * H }] })
        }
      }
      let reads = 0
      __setManagedLookupForTest(async () => { reads++; return [{ id: 'managed-hidden', conversationId: 'linked-hidden', accountId: hidden.id }] })
      __setLiveTranscriptPathForTest(async s => s.session_id === 'path-hidden' ? join(hiddenRoot, 'sessions', 'transcript.jsonl') :
        s.session_id === 'path-visible' ? join(dir, 'visible', 'sessions', 'transcript.jsonl') : null)
      const sessions = (tokens: number) => ['linked-hidden', 'path-hidden', 'path-visible', 'external'].map(session_id => ({ session_id, harness, input_tokens: tokens }))
      const ids = sessions(0).map(s => s.session_id)
      const burn = { [planAccountKey(harness, hidden.id)]: 10, [planAccountKey(harness, visible.id)]: 2 }
      await sampleLivePlanSessions(sessions(100), ids, now - 60_000, burn)
      const live = await sampleLivePlanSessions(sessions(101), ids, now, burn, new Set(ids))
      expect(reads).toBe(2) // one registry read per call, independent of session count
      expect(live.map(s => [s.account, s.burnPctPerHour])).toEqual([[hidden.id, 5], [hidden.id, 5], [visible.id, 1], [visible.id, 1]])
      const body = await planLimitsPayload(undefined, now, live)
      expect(body.liveSessions.map(s => s.id)).toEqual(['path-visible', 'external'])
      expect(body.budgets[0]!.liveSessions.map(s => s.id)).toEqual(['path-visible', 'external'])
      expect(body.hiddenFromAgents[0]!.liveSessions.map(s => s.id)).toEqual(['linked-hidden', 'path-hidden'])
      const out = JSON.stringify(planLimitsTool({ kind: 'spec-impl' }, body))
      for (const value of [hidden.id, 'linked-hidden', 'path-hidden', '@']) expect(out).not.toContain(value)
      // Direct payload callers also retain unknown sessions despite old hidden roots.
      const direct = await planLimitsPayload(undefined, now, [{ id: 'direct', harness, model: 'unknown', burnPctPerHour: 2 }])
      expect(direct.budgets[0]!.liveSessions.map(s => s.id)).toEqual(['direct'])
    })
  }

  test(`H1 ${harness}: separate visible quotas distribute burn only within their account`, async () => {
    __setManagedLookupForTest(async () => [{ id: 'a', accountId: 'acc_a' }, { id: 'b', accountId: 'acc_b' }])
    const sessions = (tokens: number) => [
      { session_id: 'a', harness, input_tokens: tokens },
      { session_id: 'b', harness, input_tokens: tokens },
    ]
    const burn = { [`${harness}:acc_a`]: 10, [`${harness}:acc_b`]: 4 }
    await sampleLivePlanSessions(sessions(100), ['a', 'b'], 0, burn)
    const live = await sampleLivePlanSessions(sessions(101), ['a', 'b'], 60_000, burn)
    expect(live.map(s => s.burnPctPerHour)).toEqual([10, 4])
  })
}

test('N2: real external rollout lookup crosses account roots without sharing cached misses', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => { throw new Error('No probe') } })
  __setHarnessAccountsForTest(store)
  const hiddenRoot = join(dir, 'hidden')
  const visibleRoot = join(dir, 'visible')
  const { account: hidden } = await store.bind(hiddenRoot, { harness: 'codex', key: 'hidden', label: 'Hidden' })
  const { account: visible } = await store.bind(visibleRoot, { harness: 'codex', key: 'visible', label: 'Visible' })
  await store.update(hidden.id, { available: false })
  const id = '11111111-2222-4333-8444-555555555555'
  const day = join(visibleRoot, 'sessions', '2026', '10', '16')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, `rollout-2026-10-16T12-00-00-${id}.jsonl`), '')
  __setLiveTranscriptPathForTest(null)
  const session = (tokens: number) => ({ session_id: id, harness: 'codex', input_tokens: tokens })
  const burn = { [planAccountKey('codex', hidden.id)]: 10, [planAccountKey('codex', visible.id)]: 2 }
  await sampleLivePlanSessions([session(100)], [id], 0, burn)
  const live = await sampleLivePlanSessions([session(101)], [id], 60_000, burn)
  expect(live[0]).toMatchObject({ account: visible.id, burnPctPerHour: 2 })
  // A hit in visibleRoot must not leak through the memo when searching hiddenRoot for this id.
  const { resolveCodexTranscript } = await import('./sessions/harness-transcript')
  expect(await resolveCodexTranscript({ conversationId: id }, join(hiddenRoot, 'sessions'), Date.now() + 31_000)).toBeNull()
})

test('L7: default legacy labels do not duplicate real #1; hidden rows do not skip numbers', async () => {
  const store = accountsWithLogin({ value: 'unused' })
  const now = now0()
  const { account: hidden } = await store.bind(join(dir, 'hidden'), { harness: 'codex', key: 'hidden', label: 'Hidden' })
  await store.update(hidden.id, { available: false })
  const { account: first } = await store.bind(join(dir, 'first'), { harness: 'codex', key: 'first', label: 'First' })
  const { account: second } = await store.bind(join(dir, 'second'), { harness: 'codex', key: 'second', label: 'Second' })
  for (const account of ['default', first.id, second.id]) await ingestPlanLimits({ harness: 'codex', account, source: 'codex-rollout', updatedAt: now,
    windows: [{ kind: 'week', usedPct: 10, resetsAt: now + 24 * H }] })
  const body = await planLimitsPayload(undefined, now)
  const labels = Object.fromEntries([...body.budgets, ...body.hiddenFromAgents].map(b => [b.account, b.accountLabel]))
  expect(labels[first.id]).toBe('Codex CLI #1')
  expect(labels[second.id]).toBe('Codex CLI #2')
  expect(labels.default).toBe('Codex CLI')
})

test('L8: MCP fallback sums free slots per harness and excludes held accounts', () => {
  const now = now0()
  const mk = (harness: 'claude' | 'codex', account: string, freeSlots: number, status: 'ok' | 'hold' = 'ok') => ({
    harness, account, freeSlots, status, fiveHourPct: 0, weekPct: 0, weekResetsAt: now + H,
  })
  const result = planLimitsTool(undefined, { budgets: [mk('claude', 'a', 2), mk('claude', 'b', 3), mk('claude', 'held', 9, 'hold'), mk('codex', 'c', 4)] })
  expect(result.freeSlotsByHarness).toEqual({ claude: 5, codex: 4 })
  expect(result.freeSlots).toBe(5)
})

test('C2 LOW L1: a transcript that appears on the second poll does not drop that sample\'s burn', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => { throw new Error('No probe') } })
  __setHarnessAccountsForTest(store)
  const { account } = await store.bind(join(dir, 'root-a'), { harness: 'codex', key: 'a', label: 'A' })
  await store.bind(join(dir, 'root-b'), { harness: 'codex', key: 'b', label: 'B' })
  const id = 'late'
  const burn = { [planAccountKey('codex', account.id)]: 10 }
  const session = (tokens: number) => ({ session_id: id, harness: 'codex', input_tokens: tokens })
  await sampleLivePlanSessions([session(100)], [id], 0, burn) // two accounts, no transcript yet: unattributed
  __setLiveTranscriptPathForTest(async () => join(dir, 'root-a', 'sessions', 't.jsonl'))
  const live = await sampleLivePlanSessions([session(150)], [id], 30_000, burn, new Set([id]))
  expect(live[0]).toMatchObject({ account: account.id, burnPctPerHour: 10 })
})

test('C2 LOW L2: an attributed session resolves its transcript once, not on every request', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => { throw new Error('No probe') } })
  __setHarnessAccountsForTest(store)
  const { account } = await store.bind(join(dir, 'root-a'), { harness: 'codex', key: 'a', label: 'A' })
  let lookups = 0
  __setLiveTranscriptPathForTest(async () => { lookups++; return join(dir, 'root-a', 'sessions', 't.jsonl') })
  const s = { session_id: 's', harness: 'codex', input_tokens: 1 }
  for (let i = 0; i < 3; i++) await sampleLivePlanSessions([s], ['s'], i * 1000, {}, new Set(['s']))
  expect(lookups).toBe(1)
  const live = await sampleLivePlanSessions([s], ['s'], 4000, {}, new Set(['s']))
  expect(live[0]!.account).toBe(account.id)
})

test('C2 LOW L3: a default binding on a retired account yields to the only visible one', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => { throw new Error('No probe') } })
  __setHarnessAccountsForTest(store)
  const { account: old } = await store.bind(null, { harness: 'codex', key: 'old', label: 'Old' })
  const { account: current } = await store.bind(join(dir, 'root-b'), { harness: 'codex', key: 'cur', label: 'Cur' })
  const doc = await store.readAccounts()
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ ...doc, accounts: doc.accounts.map(a => a.id === old.id ? { ...a, retired: true } : a) }))
  const s = { session_id: 'd', harness: 'codex', input_tokens: 1 }
  await sampleLivePlanSessions([s], ['d'], 0, {})
  const live = await sampleLivePlanSessions([{ ...s, input_tokens: 2 }], ['d'], 1000, {}, new Set(['d']))
  expect(live[0]!.account).toBe(current.id)
})

test('C2 LOW L3b: a transcript RESOLVED under the default home, whose binding is a retired account, yields to the only visible one', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => { throw new Error('No probe') } })
  __setHarnessAccountsForTest(store)
  const { account: old } = await store.bind(null, { harness: 'codex', key: 'old', label: 'Old' })
  const { account: current } = await store.bind(join(dir, 'root-b'), { harness: 'codex', key: 'cur', label: 'Cur' })
  const doc = await store.readAccounts()
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ ...doc, accounts: doc.accounts.map(a => a.id === old.id ? { ...a, retired: true } : a) }))
  const home = CODEX_DIR // the module's own default home, fixed at import
  __setLiveTranscriptPathForTest(async () => join(home, 'sessions', 'x.jsonl'))
  const s = { session_id: 'dh', harness: 'codex', input_tokens: 1 }
  await sampleLivePlanSessions([s], ['dh'], 0, {})
  const live = await sampleLivePlanSessions([{ ...s, input_tokens: 2 }], ['dh'], 1000, {}, new Set(['dh']))
  expect(live).toHaveLength(1)
  expect(live[0]!.account).toBe(current.id)
})

test('C2 R7: a default-home attribution CACHED while the account was active yields once that account retires', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => { throw new Error('No probe') } })
  __setHarnessAccountsForTest(store)
  const { account: old } = await store.bind(null, { harness: 'codex', key: 'old', label: 'Old' })
  const { account: current } = await store.bind(join(dir, 'root-b'), { harness: 'codex', key: 'cur', label: 'Cur' })
  __setLiveTranscriptPathForTest(async () => join(CODEX_DIR, 'sessions', 'x.jsonl'))
  const s = { session_id: 'dhc', harness: 'codex', input_tokens: 1 }
  await sampleLivePlanSessions([s], ['dhc'], 0, {})
  const before = await sampleLivePlanSessions([{ ...s, input_tokens: 2 }], ['dhc'], 1000, {}, new Set(['dhc']))
  expect(before[0]!.account).toBe(old.id)
  const doc = await store.readAccounts()
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ ...doc, accounts: doc.accounts.map(a => a.id === old.id ? { ...a, retired: true } : a) }))
  const after = await sampleLivePlanSessions([{ ...s, input_tokens: 3 }], ['dhc'], 2000, {}, new Set(['dhc']))
  expect(after).toHaveLength(1)
  expect(after[0]!.account).toBe(current.id)
})

test('C2 LOW L4: default-home transcripts take the default binding; several visible accounts and no binding stay unattributed', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => { throw new Error('No probe') } })
  __setHarnessAccountsForTest(store)
  const { account: a } = await store.bind(null, { harness: 'codex', key: 'a', label: 'A' })
  const home = process.env.CODEX_HOME ?? join(process.env.HOME ?? dir, '.codex')
  __setLiveTranscriptPathForTest(async () => join(home, 'sessions', 'x.jsonl'))
  const s = { session_id: 'h', harness: 'codex', input_tokens: 1 }
  await sampleLivePlanSessions([s], ['h'], 0, {})
  const bound = await sampleLivePlanSessions([{ ...s, input_tokens: 2 }], ['h'], 1000, {}, new Set(['h']))
  expect(bound[0]!.account).toBe(a.id)

  __resetPlanLimitsForTest()
  const store2 = createHarnessAccounts({ file: join(dir, 'accounts2.json'), probe: async () => { throw new Error('No probe') } })
  __setHarnessAccountsForTest(store2)
  await store2.bind(join(dir, 'r1'), { harness: 'codex', key: 'one', label: 'One' })
  await store2.bind(join(dir, 'r2'), { harness: 'codex', key: 'two', label: 'Two' })
  __setLiveTranscriptPathForTest(async () => null)
  await sampleLivePlanSessions([s], ['h'], 0, {})
  const amb = await sampleLivePlanSessions([{ ...s, input_tokens: 2 }], ['h'], 1000, {}, new Set(['h']))
  expect(amb).toHaveLength(1)
  expect(amb[0]!.account).toBeUndefined()
})

// The duplicate plan row the owner saw on v2.140.0: claude's identity probe changed its key from
// `orgId` to `orgId:email`, the registry minted a SECOND account for the same login, and the first
// account's last meter (stale, frozen at that moment) was listed as a second "Claude Max 5x".
const ORG = '00000000-0000-4000-8000-000000000001'
const EMAIL = 'fixture@example.invalid'
function writeDuplicateRegistry(now: number) {
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({
    version: 2, segments: {},
    accounts: [
      { id: 'acc_old000000000', root: null, key: ORG, harness: 'claude', label: EMAIL, plan: 'max', available: true, firstSeen: now - 9e8, lastSeen: now - 6 * 3_600_000 },
      { id: 'acc_new000000000', root: null, key: `${ORG}:${EMAIL}`, harness: 'claude', label: EMAIL, plan: 'max', available: true, firstSeen: now - 6 * 3_600_000 + 6000, lastSeen: now },
    ],
    bindings: { 'claude:': 'acc_new000000000' },
  }))
  const meter = (account: string, five: number, week: number, at: number, resetMs: number) => ({
    harness: 'claude', account, plan: 'Claude Max 5x', source: 'claude-usage-api', updatedAt: at,
    windows: [{ kind: '5h', usedPct: five, resetsAt: now + 3_600_000 + resetMs }, { kind: 'week', usedPct: week, resetsAt: now + 3 * 86_400_000 + resetMs }],
  })
  writeFileSync(join(dir, 'plan-limits.json'), JSON.stringify({ notices: {}, limits: {
    'claude:acc_old000000000': meter('acc_old000000000', 0, 32, now - 6 * 3_600_000, 753),
    'claude:acc_new000000000': meter('acc_new000000000', 14, 43, now - 60_000, 0),
  } }))
}

test('one login stored under two account ids shows ONE plan row, the live one, with no e-mail', async () => {
  const now = Date.now()
  writeDuplicateRegistry(now)
  __resetPlanLimitsForTest(join(dir, 'plan-limits.json'))
  __setHarnessAccountsForTest(createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: `${ORG}:${EMAIL}`, label: EMAIL, plan: 'max' }) }))
  const body = await planLimitsPayload(undefined, now)
  const claude = body.budgets.filter(b => b.harness === 'claude')
  expect(claude).toHaveLength(1)
  expect(claude[0]!.account).toBe('acc_new000000000')
  expect(claude[0]!.fiveHourPct).toBe(14)
  expect(claude[0]!.weekPct).toBe(43)
  expect(claude[0]!.stale).toBe(false)
  expect(body.limits.filter(l => l.harness === 'claude')).toHaveLength(1)
  expect(body.hiddenFromAgents).toEqual([])
  const agent = JSON.stringify(planLimitsTool({ kind: 'spec-impl' }, body))
  expect(agent).not.toContain(EMAIL)
  expect(agent).not.toContain('acc_old000000000')
  // The registry folded the twin and remembers where it went.
  const registry = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'))
  expect(registry.accounts.filter((a: { harness: string }) => a.harness === 'claude')).toHaveLength(1)
  expect(registry.aliases).toEqual({ acc_old000000000: 'acc_new000000000' })
  // A tap that still names the old id (a session started before the merge) feeds the survivor.
  expect(await ingestPlanLimits({ harness: 'claude', account: 'acc_old000000000', plan: 'Claude Max 5x', source: 'claude-stream', updatedAt: now,
    windows: [{ kind: '5h', usedPct: 20, resetsAt: now + 3_600_000 }] })).toBe(true)
  const after = await planLimitsPayload(undefined, now)
  expect(after.budgets.filter(b => b.harness === 'claude').map(b => [b.account, b.fiveHourPct])).toEqual([['acc_new000000000', 20]])
})

test('two real Claude Max accounts both keep capacity and routing, even when one meter is stale', async () => {
  const store = createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async (_h, root) => root === null
    ? { key: `${ORG}:a@example.invalid`, label: 'a@example.invalid' }
    : { key: `${ORG}:b@example.invalid`, label: 'b@example.invalid' } })
  __setHarnessAccountsForTest(store)
  const a = await store.current('claude')
  const b = (await store.bind('/tmp/second-root', { harness: 'claude', key: `${ORG}:b@example.invalid`, label: 'b@example.invalid' })).account
  await store.setNickname(b.id, 'Work')
  expect(a.id).not.toBe(b.id)
  const now = Date.now()
  // A is fresh and at its limit; B was read hours ago and has room. Same plan name, different people.
  await ingestPlanLimits({ harness: 'claude', account: a.id, plan: 'Claude Max 5x', source: 'claude-usage-api', updatedAt: now - 60_000,
    windows: [{ kind: '5h', usedPct: 100, resetsAt: now + 3_600_000 }, { kind: 'week', usedPct: 70, resetsAt: now + 86_400_000 }] })
  await ingestPlanLimits({ harness: 'claude', account: b.id, plan: 'Claude Max 5x', source: 'claude-usage-api', updatedAt: now - 3 * 3_600_000,
    windows: [{ kind: '5h', usedPct: 0, resetsAt: now + 3_600_000 }, { kind: 'week', usedPct: 5, resetsAt: now + 86_400_000 }] })
  const body = await planLimitsPayload(undefined, now)
  const rows = body.budgets.filter(r => r.harness === 'claude')
  expect(rows.map(r => r.accountLabel).sort()).toEqual(['Claude Code #1', 'Work'])
  expect(JSON.stringify(rows)).not.toContain('@example.invalid')
  const stale = rows.find(r => r.account === b.id)!
  expect(stale.stale).toBe(true)
  expect(stale.yieldsTo).toBeUndefined()
  expect(stale.freeSlots).toBeGreaterThan(0)
  expect(body.freeSlotsByAccount[b.id]).toBeGreaterThan(0)
  const rec = routeRecommendation(body.budgets, 'lead')
  expect(rec.account).toBe(b.id)
})


test('a newer reading published under a folded id while the move is pending is kept, not deleted', async () => {
  const now = Date.now()
  writeDuplicateRegistry(now)
  const limitsFile = join(dir, 'plan-limits.json')
  __resetPlanLimitsForTest(limitsFile)
  __setHarnessAccountsForTest(createHarnessAccounts({ file: join(dir, 'accounts.json'), probe: async () => ({ key: `${ORG}:${EMAIL}`, label: EMAIL, plan: 'max' }) }))
  // Loading moves the old id's meter to the survivor and schedules the persist.
  await planLimitsPayload(undefined, now)
  // Another process, which accepted a reading under the old id before the fold, publishes it now.
  const disk = JSON.parse(readFileSync(limitsFile, 'utf8'))
  disk.limits['claude:acc_old000000000'] = { harness: 'claude', account: 'acc_old000000000', plan: 'Claude Max 5x', source: 'claude-stream', updatedAt: now,
    windows: [{ kind: '5h', usedPct: 77, resetsAt: now + 3_600_000 }] }
  writeFileSync(limitsFile, JSON.stringify(disk))
  await new Promise(r => setTimeout(r, 900))
  const after = JSON.parse(readFileSync(limitsFile, 'utf8')).limits
  expect(Object.keys(after).filter(k => k.startsWith('claude:'))).toEqual(['claude:acc_new000000000'])
  expect(after['claude:acc_new000000000'].windows[0].usedPct).toBe(77)
  expect(after['claude:acc_new000000000'].updatedAt).toBe(now)
})

test('foldAliasedLimits folds a registry alias into its survivor by timestamp, never by order', () => {
  const meter = (account: string, at: number) => ({ harness: 'claude' as const, account, plan: 'Claude Max 5x', source: 'claude-usage-api' as const, updatedAt: at, windows: [] })
  const limits: Record<string, ReturnType<typeof meter>> = { 'claude:old': meter('old', 50), 'claude:new': meter('new', 10), 'claude:other': meter('other', 1) }
  foldAliasedLimits(limits, new Map(), { aliases: { old: 'new' } })
  expect(Object.keys(limits).sort()).toEqual(['claude:new', 'claude:other'])
  expect(limits['claude:new']).toMatchObject({ account: 'new', updatedAt: 50 })
  const older: Record<string, ReturnType<typeof meter>> = { 'claude:new': meter('new', 90), 'claude:old': meter('old', 50) }
  foldAliasedLimits(older, new Map(), { aliases: { old: 'new' } })
  expect(older).toEqual({ 'claude:new': meter('new', 90) })
})
