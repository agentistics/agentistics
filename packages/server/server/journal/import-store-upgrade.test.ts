/**
 * CUSTO.DECLARADO-TOPO, the repair half: a machine that ALREADY imported a store record under the 1.0.0
 * mapping holds a `model.completed` without the harness-declared cost, and `UNIQUE(event_id)` keeps it
 * forever — so fixing the mapping alone changes nothing for anybody who had already imported. The store
 * half records the mapping version per record and REPLACES the events of a record whose events changed.
 *
 * The "old" machine is built faithfully: a real import (real journal on a temp dir), then its state is
 * aged to the 1.0.0 shape (no `version`) and the record's events are put back exactly as 1.0.0 wrote
 * them (no `costUSD`/`costSource`, `adapterVersion: '1.0.0'`). Then the next import — what every server
 * start runs (`scheduleBackfillCheck(true)`) — must lift the OpenCode cost from 0.1765 to 0.25 by itself,
 * and the one after it must touch nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent, AnyAgentisticsEvent, HarnessId, SessionMeta } from '@agentistics/core'
import type { HarnessEntityIds, HarnessReplay } from '@agentistics/engine-api'
import { costByDimensionProjection } from '../projections/cost-by-dimension'
import { parseMetricsQuery, runMetricsQuery } from '../runtime-metrics-query'
import { fakeReader } from '../runtime-metrics-fixtures'
import { openJournal } from './journal'
import { runImport, type ImportOptions } from './import'
import { parseImportState, planStore, type ImportReport, type ImportState } from './import-plan'
import { IMPORT_STORE_ADAPTER_VERSION, storeReplaceNeeded } from './import-store'

const MODEL = 'claude-sonnet-5-5'
const ids = (h: string): HarnessEntityIds => ({ sessionIdOf: c => `ses_${h}_${c}`, runIdOf: c => `run_${h}_${c}`, mainAgentIdOf: c => `agt_${h}_${c}` })
const ENTITY_IDS = { claude: ids('claude'), opencode: ids('opencode') }
/** No artifacts anywhere: both sessions are store orphans, as on the proof machine. */
const noArtifacts: HarnessReplay<AgentisticsEvent> = { discover: async () => [], replay: async () => ({ events: [], cursor: null }) }

function meta(harness: HarnessId, id: string, u: Record<string, unknown>): SessionMeta {
  return {
    session_id: id, harness, project_path: '/work/app', start_time: '2026-11-20T10:00:00Z', end_time: '2026-11-20T11:00:00Z',
    model: MODEL, input_tokens: u.inputTokens, output_tokens: u.outputTokens,
    cache_read_input_tokens: u.cacheReadInputTokens, cache_creation_input_tokens: u.cacheCreationInputTokens,
    model_usage: { [MODEL]: { webSearchRequests: 0, costUSD: 0, ...u } },
  } as unknown as SessionMeta
}

let root = ''
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-store-upgrade-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

async function world() {
  const dir = join(root, `w${Math.random().toString(36).slice(2)}`)
  const store = join(dir, 'sessions')
  await mkdir(join(store, 'claude'), { recursive: true })
  await mkdir(join(store, 'opencode'), { recursive: true })
  await writeFile(join(store, 'claude', 'c-a.json'), JSON.stringify(meta('claude', 'c-a', { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadInputTokens: 5_000_000, cacheCreationInputTokens: 0 })))
  await writeFile(join(store, 'opencode', 'oc-1.json'), JSON.stringify(meta('opencode', 'oc-1', {
    inputTokens: 60_000, outputTokens: 4_000, cacheReadInputTokens: 90_000, cacheCreationInputTokens: 3_000, costUSD: 0.25, costSource: 'harness',
  })))
  const journalPath = join(dir, 'journal.db')
  return { dir, store, journalPath, statePath: `${journalPath}.import.json` }
}

const opts = (w: { store: string; journalPath: string }): ImportOptions => ({
  harnesses: ['claude', 'opencode'], journalPath: w.journalPath, storeDir: w.store,
  replays: { claude: noArtifacts, opencode: noArtifacts }, entityIds: ENTITY_IDS, stamps: { claude: null, opencode: null },
})

async function ok(o: ImportOptions): Promise<ImportReport> {
  const r = await runImport(o)
  if (!r.ok) throw new Error(r.error)
  return r.report
}

async function allEvents(path: string): Promise<AgentisticsEvent[]> {
  const j = await openJournal({ path })
  try { return (await j.readFrom(0, 100_000)).events } finally { j.close() }
}

/**
 * The projected cost per harness, through the real fold and the real `/api/runtime/metrics` aggregation.
 * The projection's state is one SESSION (the materializer folds each session's events on their own).
 */
async function costByHarness(path: string): Promise<Record<string, number>> {
  const bySession = new Map<string, AnyAgentisticsEvent[]>()
  for (const e of await allEvents(path)) {
    const k = e.sessionId ?? ''
    bySession.set(k, [...(bySession.get(k) ?? []), e as AnyAgentisticsEvent])
  }
  const facts = [...bySession.values()].flatMap(events => {
    const s = costByDimensionProjection.empty()
    costByDimensionProjection.fold(s, events)
    return costByDimensionProjection.finish(s).facts
  })
  const parsed = parseMetricsQuery(new URLSearchParams('groupBy=harness&metrics=cost&limit=1000'))
  if (!parsed.ok) throw new Error('query')
  const body = await runMetricsQuery(fakeReader(facts, []), parsed.query) as unknown as { groups: { key: { harness: string }; metrics: { cost: { usd: number } } }[] }
  return Object.fromEntries(body.groups.map(g => [g.key.harness, g.metrics.cost.usd]))
}

/** Turns a freshly imported world into what a 2.229.x machine holds: 1.0.0 state and 1.0.0 events. */
async function ageTo100(w: { journalPath: string; statePath: string }) {
  const state = JSON.parse(readFileSync(w.statePath, 'utf8')) as { store: Record<string, Record<string, unknown>> }
  for (const rec of Object.values(state.store)) delete rec.version
  writeFileSync(w.statePath, JSON.stringify(state))
  const ref = 'consolidate:opencode/oc-1.json'
  const old = (await allEvents(w.journalPath)).filter(e => e.provenance.sourceRef === ref).map(e => {
    const data = { ...(e.data as Record<string, unknown>) }
    delete data.costUSD
    delete data.costSource
    return {
      ...e, data,
      source: { ...e.source, version: '1.0.0' },
      provenance: { ...e.provenance, adapterVersion: '1.0.0' },
    } as AgentisticsEvent
  })
  expect(old.length).toBeGreaterThan(0)
  const j = await openJournal({ path: w.journalPath })
  try { expect((await j.replaceBySourcePrefix!(ref, old)).ok).toBe(true) } finally { j.close() }
}

describe('a store record imported under 1.0.0 is repaired by the next import (CUSTO.DECLARADO-TOPO)', () => {
  test('old journal at 0.1765 → 0.25 on the next run; the run after that re-imports nothing', async () => {
    const w = await world()
    await ok(opts(w))
    await ageTo100(w)
    const before = await costByHarness(w.journalPath)
    expect(before.opencode).toBeCloseTo(0.1765, 10)
    expect(before.claude).toBeCloseTo(4.5, 10)
    const rowsBefore = (await allEvents(w.journalPath)).length

    // The first start after the update.
    const first = await ok(opts(w))
    const oc = first.harnesses.find(h => h.harness === 'opencode')!
    const cl = first.harnesses.find(h => h.harness === 'claude')!
    expect(oc.store.replaced).toBe(1)
    expect(cl.store.replaced ?? 0).toBe(0)          // nothing declared: re-stamped, never rewritten
    expect(cl.store.written).toBe(0)
    const after = await costByHarness(w.journalPath)
    expect(after.opencode).toBeCloseTo(0.25, 10)
    expect(after.claude).toBeCloseTo(4.5, 10)
    expect((await allEvents(w.journalPath)).length).toBe(rowsBefore) // replaced, not duplicated
    const state = JSON.parse(readFileSync(w.statePath, 'utf8')) as { store: Record<string, { version?: string }> }
    expect(Object.values(state.store).every(r => r.version === '1.1.0')).toBe(true)

    // The second start: idempotent.
    const second = await ok(opts(w))
    for (const h of second.harnesses) {
      expect(h.store.replaced ?? 0).toBe(0)
      expect(h.store.processed).toBe(0)
      expect(h.store.written).toBe(0)
      expect(h.store.skipped.unchanged).toBe(1)
    }
    expect((await costByHarness(w.journalPath)).opencode).toBeCloseTo(0.25, 10)
  })
})

describe('the pure rules behind the repair', () => {
  const declared = meta('opencode', 'x', { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.25, costSource: 'harness' })
  const tabled = meta('claude', 'y', { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  const mixed = meta('opencode', 'z', { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.3, costSource: 'mixed' })

  test('storeReplaceNeeded: only a 1.0.0 record with a harness-declared row changed; the running version never; an unknown one always', () => {
    expect(storeReplaceNeeded(declared, '1.0.0')).toBe(true)
    expect(storeReplaceNeeded(tabled, '1.0.0')).toBe(false)
    expect(storeReplaceNeeded(mixed, '1.0.0')).toBe(false)
    expect(storeReplaceNeeded(declared, IMPORT_STORE_ADAPTER_VERSION)).toBe(false)
    expect(storeReplaceNeeded(tabled, '0.9.0')).toBe(true)
  })

  test('planStore revisits an unchanged record imported under another mapping, and skips it under the same one', () => {
    const entry = { ok: true as const, harness: 'opencode' as HarnessId, sessionId: 'oc-1', file: 'opencode/oc-1.json', stamp: '10:20' }
    const state = (version?: string): ImportState => ({ v: 1, identity: 'j', sources: {}, store: { 'opencode:oc-1': { stamp: '10:20', importedAtMs: 1, ...(version ? { version } : {}) } } })
    const plan = (s: ImportState, current?: string) => planStore([entry], new Set(), c => `run_${c}`, new Set(), s, undefined, current)
    expect(plan(state(), IMPORT_STORE_ADAPTER_VERSION).import).toHaveLength(1)          // legacy record (no version) = 1.0.0
    expect(plan(state('1.0.0'), IMPORT_STORE_ADAPTER_VERSION).import).toHaveLength(1)
    expect(plan(state(IMPORT_STORE_ADAPTER_VERSION), IMPORT_STORE_ADAPTER_VERSION).skipped.unchanged).toBe(1)
    expect(plan(state()).skipped.unchanged).toBe(1)                                      // version unknown: as before
  })

  test('parseImportState keeps a store record\'s version and drops a junk one', () => {
    const text = JSON.stringify({ v: 1, identity: 'j', sources: {}, store: { a: { stamp: 's', importedAtMs: 1, version: '1.1.0' }, b: { stamp: 's', importedAtMs: 1, version: 7 } } })
    const s = parseImportState(text, 'j')
    expect(s.store.a!.version).toBe('1.1.0')
    expect('version' in s.store.b!).toBe(false)
  })
})

describe('the repair replaces ONLY the repaired record (QA note 1: a wider replace prefix must fail)', () => {
  test('a second OpenCode record keeps its events when the first one is repaired', async () => {
    const w = await world()
    await writeFile(join(w.store, 'opencode', 'oc-2.json'), JSON.stringify(meta('opencode', 'oc-2', {
      inputTokens: 10_000, outputTokens: 1_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    })))
    await ok(opts(w))
    await ageTo100(w)
    const ref2 = 'consolidate:opencode/oc-2.json'
    const oc2Before = (await allEvents(w.journalPath)).filter(e => e.provenance.sourceRef === ref2)
    expect(oc2Before.length).toBeGreaterThan(0)

    const first = await ok(opts(w))
    expect(first.harnesses.find(h => h.harness === 'opencode')!.store.replaced).toBe(1)
    const oc2After = (await allEvents(w.journalPath)).filter(e => e.provenance.sourceRef === ref2)
    expect(oc2After.map(e => e.eventId).sort()).toEqual(oc2Before.map(e => e.eventId).sort())
  })
})
