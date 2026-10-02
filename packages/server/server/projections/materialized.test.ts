/**
 * The materialised store, end to end, over REAL SQLite in a throwaway directory (never
 * `~/.agentistics`) and a real journal filled with a synthetic event stream (`synthetic-events.ts`,
 * standing in for the deleted `p3-fixture-events.ts`'s real-replay fixtures — see that module's
 * header for why: this used to replay `../integrations/claude` / `../integrations/codex`, both now
 * FROZEN engine code and absent from the public tree):
 *
 * - rebuild == resume: a store caught up in two passes (half the journal, then the rest, in small
 *   pages) holds exactly what a store built in one pass holds — and what the pure folds produce;
 * - a resume reads only the NEW events (P3 §6: cost proportional to new events, not to history);
 * - a `projectionVersion` bump rebuilds and CHANGES THE ANSWER (P3 §8.4), and says why;
 * - an adapter-version change rebuilds (§19.4); a replaced journal rebuilds;
 * - an interrupted rebuild continues from its last committed page;
 * - re-appending, re-folding (cursors rewound) and shuffled ingestion change nothing;
 * - with the flag OFF nothing is opened or created.
 *
 * `CURRENT_ADAPTER_VERSIONS` no longer exists (ES.4 moved adapter-version discovery behind the
 * engine slot — `adapter-versions.ts`'s `currentAdapterVersions()` now reads the loaded engine's
 * registry, empty in a community build). The adapter-version-change test below passes its own
 * explicit `adapterVersions` on both catch-up calls instead of relying on that global, which is
 * equivalent and does not depend on whether an engine is loaded.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { project, type AnyAgentisticsEvent } from '@agentistics/core'
import { openJournal } from '../journal/journal'
import type { Journal } from '../journal/types'
import { COST_BY_DIMENSION, RUN_METRICS, STORED_PROJECTIONS, type StoredProjection } from './catalog'
import { catchUpProjections, runProjectionCatchUp } from './catch-up'
import { costByDimensionProjection } from './cost-by-dimension'
import type { CostFact, RunFact } from './facts'
import { fixtureEvents, groupBy, shuffled } from './synthetic-events'
import { createProjectionReader, openProjectionReader } from './reader'
import { canonicalJson } from './state-codec'
import { runMetricsProjection, type RunMetricsResult } from './run-metrics'
import { openProjectionStore, projectionsEnabled, type ProjectionStore } from './store'

const ON = { AGENTISTICS_PROJECTIONS: '1' }
const ADAPTERS_V1 = { claude: '1.0.0', codex: '1.0.0' }
const ROOT = mkdtempSync(join(tmpdir(), 'agentistics-p3-'))
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })
let n = 0
const freshDir = () => join(ROOT, `case-${++n}`)

const EVENTS = await fixtureEvents()

async function journalAt(dir: string, events: readonly AnyAgentisticsEvent[]): Promise<Journal> {
  const j = await openJournal({ path: join(dir, 'journal.db'), scheduleCheckpoint: () => () => {} })
  expect(j.status().state).toBe('open')
  for (let i = 0; i < events.length; i += 97) await j.append(events.slice(i, i + 97))
  return j
}

/** Every output row of every projection, keyed and sorted — independent of rid and arrival order. */
function snapshot(store: ProjectionStore): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const d of STORED_PROJECTIONS) {
    const rows: string[] = []
    let after = 0
    for (;;) {
      const page = store.outputs(d.id, {}, after, 1000)
      if (page.length === 0) break
      for (const r of page) rows.push(`${r.key}\u0000${r.day}\u0000${r.data}`)
      after = page[page.length - 1]!.rid
    }
    out[d.id] = rows.sort()
  }
  return out
}

async function storeAt(dir: string): Promise<ProjectionStore> {
  const s = await openProjectionStore({ path: join(dir, 'projections.db'), projections: STORED_PROJECTIONS })
  expect(s.state).toBe('open')
  return s
}

/** One store, built in one pass over the whole journal: the reference every other case compares to. */
const REF_DIR = freshDir()
const REF_JOURNAL = await journalAt(REF_DIR, EVENTS)
const REF_STORE = await storeAt(REF_DIR)
const REF_REPORT = await catchUpProjections({ journal: REF_JOURNAL, store: REF_STORE, env: ON, adapterVersions: ADAPTERS_V1 })
const REF = snapshot(REF_STORE)
afterAll(() => { REF_STORE.close(); REF_JOURNAL.close() })

describe('a first build', () => {
  test('rebuilds every projection from rowid 0, says why, and reaches the head', async () => {
    expect(REF_REPORT.state).toBe('done')
    expect(REF_REPORT.eventsRead).toBe(EVENTS.length)
    expect(REF_REPORT.cursor).toBe((await REF_JOURNAL.head!())!)
    for (const p of REF_REPORT.projections) {
      expect(p.mode).toBe('rebuild')
      expect(p.rebuildReason).toContain('first build')
    }
  })

  test('its rows are exactly what the pure folds produce', () => {
    const facts: CostFact[] = []
    for (const [, evs] of groupBy(EVENTS, e => e.sessionId ?? null)) facts.push(...project(costByDimensionProjection, evs).facts)
    expect(REF[COST_BY_DIMENSION.id]!.map(r => r.split('\u0000')[2]!).sort()).toEqual(facts.map(f => canonicalJson(f)).sort())
    const runs: RunFact[] = []
    for (const [, evs] of groupBy(EVENTS, e => e.runId ?? null)) {
      const f = project(runMetricsProjection, evs).fact
      if (f) runs.push(f)
    }
    expect(REF[RUN_METRICS.id]!.map(r => r.split('\u0000')[2]!).sort()).toEqual(runs.map(f => canonicalJson(f)).sort())
  })
})

describe('rebuild == resume', () => {
  test('half the journal, then the rest, in small pages: identical to one pass — and the resume reads only new events', async () => {
    const dir = freshDir()
    const cut = Math.floor(EVENTS.length * 0.55)
    const j = await journalAt(dir, EVENTS.slice(0, cut))
    const s = await storeAt(dir)
    const first = await catchUpProjections({ journal: j, store: s, env: ON, pageSize: 13, adapterVersions: ADAPTERS_V1 })
    expect(first.state).toBe('done')
    for (let i = cut; i < EVENTS.length; i += 50) await j.append(EVENTS.slice(i, i + 50))
    const second = await catchUpProjections({ journal: j, store: s, env: ON, pageSize: 13, adapterVersions: ADAPTERS_V1 })
    expect(second.state).toBe('done')
    expect(second.eventsRead).toBe(EVENTS.length - cut)
    for (const p of second.projections) expect(p.mode).toBe('resume')
    expect(snapshot(s)).toEqual(REF)
    // Nothing new: a pass reads nothing.
    const third = await catchUpProjections({ journal: j, store: s, env: ON, adapterVersions: ADAPTERS_V1 })
    expect(third.eventsRead).toBe(0)
    s.close(); j.close()
  })

  test('shuffled ingestion order yields the same store', async () => {
    const dir = freshDir()
    const j = await journalAt(dir, shuffled(EVENTS, 11))
    const s = await storeAt(dir)
    await catchUpProjections({ journal: j, store: s, env: ON, pageSize: 17, adapterVersions: ADAPTERS_V1 })
    expect(snapshot(s)).toEqual(REF)
    s.close(); j.close()
  })

  test('re-appending every event, and re-folding every page (cursors rewound), change nothing', async () => {
    const dir = freshDir()
    const j = await journalAt(dir, EVENTS)
    const s = await storeAt(dir)
    await catchUpProjections({ journal: j, store: s, env: ON, adapterVersions: ADAPTERS_V1 })
    const again = await j.append(EVENTS)
    expect(again.written).toBe(0)
    expect((await catchUpProjections({ journal: j, store: s, env: ON, adapterVersions: ADAPTERS_V1 })).eventsRead).toBe(0)
    await s.transaction(tx => { for (const d of STORED_PROJECTIONS) tx.setCursor(d.id, 0) })
    const refold = await catchUpProjections({ journal: j, store: s, env: ON, pageSize: 31, adapterVersions: ADAPTERS_V1 })
    expect(refold.eventsRead).toBe(EVENTS.length)
    expect(snapshot(s)).toEqual(REF)
    s.close(); j.close()
  })
})

describe('the re-projection lever (§19.4, P3 §8.4)', () => {
  test('bumping a projectionVersion rebuilds THAT projection from the journal and changes the answer', async () => {
    const dir = freshDir()
    const j = await journalAt(dir, EVENTS)
    const s = await storeAt(dir)
    await catchUpProjections({ journal: j, store: s, env: ON, adapterVersions: ADAPTERS_V1 })
    const before = snapshot(s)

    // Version 2 of run-metrics: the same fold, a different answer (it no longer reports a model).
    const v2: StoredProjection = {
      ...RUN_METRICS,
      projection: {
        ...runMetricsProjection,
        version: 2,
        finish: st => {
          const r: RunMetricsResult = runMetricsProjection.finish(st)
          return r.fact ? { ...r, fact: { ...r.fact, model: 'v2' } } : r
        },
      },
    }
    const defs = STORED_PROJECTIONS.map(d => (d.id === RUN_METRICS.id ? v2 : d))
    const report = await catchUpProjections({ journal: j, store: s, env: ON, projections: defs, adapterVersions: ADAPTERS_V1 })
    expect(report.state).toBe('done')
    const run = report.projections.find(p => p.name === 'run-metrics')!
    expect(run.mode).toBe('rebuild')
    expect(run.fromCursor).toBe(0)
    expect(run.rebuildReason).toContain('projectionVersion changed (1 → 2)')
    for (const p of report.projections.filter(p => p.name !== 'run-metrics')) expect(p.mode).toBe('resume')

    const after = snapshot(s)
    expect(after[RUN_METRICS.id]).not.toEqual(before[RUN_METRICS.id])
    expect(after[RUN_METRICS.id]!.every(r => JSON.parse(r.split('\u0000')[2]!).model === 'v2')).toBe(true)
    for (const d of STORED_PROJECTIONS.filter(d => d.id !== RUN_METRICS.id)) expect(after[d.id]).toEqual(before[d.id])
    expect((await createProjectionReader(s).status()).versions['run-metrics']).toBe(2)

    // And it stays rebuilt: the next pass resumes at v2.
    const next = await catchUpProjections({ journal: j, store: s, env: ON, projections: defs, adapterVersions: ADAPTERS_V1 })
    expect(next.projections.find(p => p.name === 'run-metrics')!.mode).toBe('resume')
    s.close(); j.close()
  })

  test('an adapter version change rebuilds every projection and names the adapter', async () => {
    const dir = freshDir()
    const j = await journalAt(dir, EVENTS)
    const s = await storeAt(dir)
    await catchUpProjections({ journal: j, store: s, env: ON, adapterVersions: ADAPTERS_V1 })
    const bumped = { ...ADAPTERS_V1, claude: '9.9.9' }
    const r = await catchUpProjections({ journal: j, store: s, env: ON, adapterVersions: bumped })
    for (const p of r.projections) {
      expect(p.mode).toBe('rebuild')
      expect(p.rebuildReason).toContain(`claude ${ADAPTERS_V1.claude} → 9.9.9`)
    }
    expect(snapshot(s)).toEqual(REF)
    s.close(); j.close()
  })

  test('a journal that is not the one the store was folded from rebuilds from it', async () => {
    const dir = freshDir()
    const j1 = await journalAt(dir, EVENTS)
    const s = await storeAt(dir)
    await catchUpProjections({ journal: j1, store: s, env: ON, adapterVersions: ADAPTERS_V1 })
    j1.close()
    for (const f of ['journal.db', 'journal.db-wal', 'journal.db-shm']) rmSync(join(dir, f), { force: true })
    const subset = EVENTS.filter(e => e.source.id === 'codex')
    const j2 = await journalAt(dir, subset)
    const r = await catchUpProjections({ journal: j2, store: s, env: ON, adapterVersions: ADAPTERS_V1 })
    for (const p of r.projections) {
      expect(p.mode).toBe('rebuild')
      expect(p.rebuildReason).toContain('not the one this store was folded from')
    }
    const costs = snapshot(s)[COST_BY_DIMENSION.id]!.map(row => JSON.parse(row.split('\u0000')[2]!) as CostFact)
    expect(costs.length).toBeGreaterThan(0)
    expect(costs.every(f => f.harness === 'codex')).toBe(true)
    s.close(); j2.close()
  })
})

describe('an interrupted rebuild', () => {
  test('stops at a page budget, says so, and CONTINUES from its last committed page — ending equal to a whole build', async () => {
    const dir = freshDir()
    const j = await journalAt(dir, EVENTS)
    const s = await storeAt(dir)
    const progress: number[] = []
    const first = await catchUpProjections({ journal: j, store: s, env: ON, pageSize: 20, maxPages: 3, adapterVersions: ADAPTERS_V1, onProgress: p => progress.push(p.cursor) })
    expect(first.state).toBe('interrupted')
    expect(first.reason).toContain('page budget')
    expect(first.eventsRead).toBe(60)
    expect(progress).toHaveLength(3)
    expect((await createProjectionReader(s, { journal: j }).status()).rebuilding).toBe(true)

    const second = await catchUpProjections({ journal: j, store: s, env: ON, pageSize: 20, adapterVersions: ADAPTERS_V1 })
    expect(second.state).toBe('done')
    for (const p of second.projections) {
      expect(p.mode).toBe('rebuild')
      expect(p.fromCursor).toBe(first.cursor)
      expect(p.fromCursor).toBeGreaterThan(0)
    }
    expect(second.eventsRead).toBe(EVENTS.length - 60)
    expect(snapshot(s)).toEqual(REF)
    expect((await createProjectionReader(s, { journal: j }).status()).rebuilding).toBe(false)
    s.close(); j.close()
  })

  test('an aborted signal stops before the first page', async () => {
    const dir = freshDir()
    const j = await journalAt(dir, EVENTS)
    const ac = new AbortController()
    ac.abort()
    const r = await catchUpProjections({ journal: j, env: ON, signal: ac.signal, storeOptions: { path: join(dir, 'projections.db') } })
    expect(r.state).toBe('interrupted')
    expect(r.eventsRead).toBe(0)
    j.close()
  })
})

describe('the reader', () => {
  test('streams CostFacts and RunFacts by UTC day range, and states its freshness', async () => {
    const reader = createProjectionReader(REF_STORE, { journal: REF_JOURNAL })
    const all: CostFact[] = []
    for await (const f of reader.costFacts({})) all.push(f)
    expect(all.length).toBe(REF[COST_BY_DIMENSION.id]!.length)
    const days = [...new Set(all.map(f => f.day))].sort()
    const mid = days[Math.floor(days.length / 2)]!
    const later: CostFact[] = []
    for await (const f of reader.costFacts({ from: mid })) later.push(f)
    expect(later.length).toBe(all.filter(f => f.day >= mid).length)
    const one: RunFact[] = []
    for await (const f of reader.runFacts({ from: mid, to: mid })) one.push(f)
    expect(one.every(f => f.day === mid)).toBe(true)
    expect(one.length).toBeGreaterThan(0)

    const st = await reader.status()
    expect(st.cursor).toBe(st.journalHead)
    expect(st.rebuilding).toBe(false)
    expect(Object.keys(st.versions).sort()).toEqual(STORED_PROJECTIONS.map(d => d.projection.name).sort())
  })
})

describe('the flag (absent = OFF) and the open discipline', () => {
  const poisoned = new Proxy({}, { get() { throw new Error('the journal must not be touched while the flag is off') } }) as Journal

  test('projectionsEnabled reads only an explicit affirmative', () => {
    expect(projectionsEnabled({})).toBe(false)
    expect(projectionsEnabled({ AGENTISTICS_PROJECTIONS: '' })).toBe(false)
    expect(projectionsEnabled({ AGENTISTICS_PROJECTIONS: '0' })).toBe(false)
    expect(projectionsEnabled({ AGENTISTICS_PROJECTIONS: ' ON ' })).toBe(true)
  })

  test('flag off: the catch-up opens nothing, creates nothing, touches no journal', async () => {
    const dir = freshDir()
    const r = await runProjectionCatchUp({ journal: poisoned, env: {}, storeOptions: { path: join(dir, 'projections.db') } })
    expect(r.state).toBe('disabled')
    expect(r.reason).toContain('flag-off')
    expect(existsSync(dir)).toBe(false)
  })

  test('flag off: the reader factory opens nothing and yields nothing', async () => {
    const dir = freshDir()
    const { reader, store, close } = await openProjectionReader({ env: {}, storeOptions: { path: join(dir, 'projections.db') } })
    expect(store.state).toBe('disabled')
    const rows: unknown[] = []
    for await (const f of reader.costFacts({})) rows.push(f)
    expect(rows).toEqual([])
    close()
    expect(existsSync(dir)).toBe(false)
  })

  test('a network filesystem is refused BEFORE anything is created', async () => {
    const dir = freshDir()
    const probe = {
      platform: 'linux' as NodeJS.Platform,
      realpath: (p: string) => p,
      readMountinfo: () => `36 35 0:50 / ${ROOT} rw,relatime shared:1 - nfs4 server:/x rw\n`,
      readDarwinMounts: () => null,
    }
    const s = await openProjectionStore({ path: join(dir, 'projections.db'), probe })
    expect(s.state).toBe('disabled')
    expect(s.reason).toBe('network-filesystem')
    expect(existsSync(dir)).toBe(false)
  })

  test('a store written by a NEWER layout is refused untouched', async () => {
    const dir = freshDir()
    const s = await storeAt(dir)
    s.close()
    const { Database } = await import('bun:sqlite')
    const db = new Database(join(dir, 'projections.db'))
    db.exec('PRAGMA user_version = 99')
    db.close()
    const again = await openProjectionStore({ path: join(dir, 'projections.db') })
    expect(again.state).toBe('disabled')
    expect(again.reason).toBe('db-schema-too-new')
  })
})
