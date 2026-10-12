/**
 * import-replace.test.ts — METRICS.FIX (owner D8): a source imported under an older adapter version
 * is RE-READ and its old events are REPLACED, not deduplicated (`UNIQUE(event_id)` would keep the old,
 * wrong `session.ended`). An unchanged version is not reprocessed. Real journal on a temp dir, a
 * synthetic replay whose output depends on the version it runs as.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CANONICAL_EVENT_SCHEMA, deriveEventId, type AgentisticsEvent } from '@agentistics/core'
import type { HarnessEntityIds, HarnessReplay } from '@agentistics/engine-api'
import { openJournal } from './journal'
import { runImport, type ImportOptions } from './import'
import type { ImportReport } from './import-plan'
import { catchUpProjections } from '../projections/catch-up'

const IDS: HarnessEntityIds = { sessionIdOf: c => `ses_g_${c}`, runIdOf: c => `run_g_${c}`, mainAgentIdOf: c => `agt_g_${c}` }

/** v1.0.0: `:close` at 03:05 and no usage. v1.1.0: `:close` at 04:30 and a model.completed with tokens. */
function events(id: string, version: '1.0.0' | '1.1.0'): AgentisticsEvent[] {
  const mk = (type: AgentisticsEvent['type'], ref: string, at: string, data: unknown): AgentisticsEvent => ({
    eventId: deriveEventId({ sourceKind: 'harness', sourceId: 'gemini', sourceRef: `gemini:${id}:${ref}`, type, ordinal: 0 }),
    schema: CANONICAL_EVENT_SCHEMA,
    type,
    occurredAt: at,
    recordedAt: '2026-01-02T06:00:00.000Z',
    sessionId: IDS.sessionIdOf(id),
    runId: IDS.runIdOf(id),
    source: { kind: 'harness', id: 'gemini', version },
    provenance: { mode: 'replayed', confidence: 'exact', adapterVersion: version, sourceRef: `gemini:${id}:${ref}` },
    data: data as AgentisticsEvent['data'],
  })
  const out = [
    mk('session.started', 'open', '2026-01-02T03:00:00.000Z', { origin: 'adapter' }),
    mk('run.started', 'open', '2026-01-02T03:00:00.000Z', { harness: 'gemini', conversationId: id, conversationLink: 'observed' }),
  ]
  if (version === '1.1.0') {
    out.push(mk('model.completed', 'msg:1', '2026-01-02T04:00:00.000Z', {
      provider: 'google', model: 'gemini-3-pro', status: 'completed', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    }))
  }
  out.push(mk('run.ended', 'close', version === '1.0.0' ? '2026-01-02T03:05:00.000Z' : '2026-01-02T04:30:00.000Z', { status: 'completed' }))
  out.push(mk('session.ended', 'close', version === '1.0.0' ? '2026-01-02T03:05:00.000Z' : '2026-01-02T04:30:00.000Z', {}))
  return out
}

function replayAs(version: '1.0.0' | '1.1.0', ids: string[]): HarnessReplay<AgentisticsEvent> {
  return {
    discover: async () => ids.map(id => ({ sessionId: id, sourceRef: `gemini:${id}` })),
    replay: async (src, cursor) => {
      const all = events(src.sessionId, version)
      const from = cursor ? Number(cursor) : 0
      return { events: all.slice(from), cursor: String(all.length) }
    },
  }
}

let root = ''
let seq = 0
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-import-replace-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function world() {
  const dir = join(root, `w${++seq}`)
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  return { dir, store: join(dir, 'sessions'), journalPath: join(dir, 'journal.db') }
}

function run(w: ReturnType<typeof world>, version: '1.0.0' | '1.1.0', ids = ['a', 'b']): Promise<ImportReport> {
  const o: ImportOptions = {
    harnesses: ['gemini'],
    journalPath: w.journalPath,
    storeDir: w.store,
    integrations: { gemini: { id: 'gemini', version, entityIds: IDS } } as never,
    replays: { gemini: replayAs(version, ids) },
    entityIds: { gemini: IDS },
    stamps: { gemini: null },
  }
  return runImport(o).then(r => { if (!r.ok) throw new Error(r.error); return r.report })
}

async function all(path: string): Promise<AgentisticsEvent[]> {
  const j = await openJournal({ path })
  try { return (await j.readFrom(0, 1000)).events } finally { j.close() }
}

describe('import — a changed adapter version replaces the source', () => {
  test('1.0.0 then 1.1.0: old events gone, totals right, no duplicates', async () => {
    const w = world()
    const first = await run(w, '1.0.0')
    expect(first.harnesses[0]!.artifacts.written).toBe(8) // 2 sources x 4 events
    expect((await all(w.journalPath)).length).toBe(8)

    const second = await run(w, '1.1.0')
    const a = second.harnesses[0]!.artifacts
    expect(a.replaced).toBe(2)
    expect(a.duplicates).toBe(0)
    expect(a.written).toBe(10) // 2 sources x 5 events, all new rows

    const evs = await all(w.journalPath)
    expect(evs.length).toBe(10) // not 8 + 10, not 8 + 2: the old rows are gone
    const closes = evs.filter(e => e.type === 'session.ended')
    expect(closes.length).toBe(2)
    for (const c of closes) expect(c.occurredAt).toBe('2026-01-02T04:30:00.000Z') // the OLD 03:05 is gone
    expect(evs.every(e => e.provenance.adapterVersion === '1.1.0')).toBe(true)
    expect(evs.filter(e => e.type === 'model.completed').length).toBe(2)
  })

  test('an unchanged version is not reprocessed', async () => {
    const w = world()
    await run(w, '1.1.0')
    const again = await run(w, '1.1.0')
    expect(again.harnesses[0]!.artifacts.replaced).toBeUndefined()
    expect(again.harnesses[0]!.artifacts.written).toBe(0)
    expect((await all(w.journalPath)).length).toBe(10)
  })

  test('a state file from before adapterVersion existed counts as 1.0.0 for gemini', async () => {
    const w = world()
    await run(w, '1.0.0')
    const statePath = `${w.journalPath}.import.json`
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    for (const rec of Object.values(state.sources) as { adapterVersion?: string }[]) delete rec.adapterVersion
    writeFileSync(statePath, JSON.stringify(state))
    const r = await run(w, '1.1.0')
    expect(r.harnesses[0]!.artifacts.replaced).toBe(2)
    expect((await all(w.journalPath)).length).toBe(10)
  })

  test('a dry run reports the replacement and deletes nothing', async () => {
    const w = world()
    await run(w, '1.0.0')
    const res = await runImport({
      harnesses: ['gemini'], journalPath: w.journalPath, storeDir: w.store, dryRun: true,
      integrations: { gemini: { id: 'gemini', version: '1.1.0', entityIds: IDS } } as never,
      replays: { gemini: replayAs('1.1.0', ['a', 'b']) }, entityIds: { gemini: IDS }, stamps: { gemini: null },
    })
    if (!res.ok) throw new Error(res.error)
    expect(res.report.harnesses[0]!.artifacts.replaced).toBe(2)
    expect(res.report.harnesses[0]!.artifacts.duplicates).toBe(0)
    expect((await all(w.journalPath)).length).toBe(8)
  })

  test('a replacement bumps the journal epoch, so projections rebuild instead of double counting', async () => {
    const w = world()
    const storePath = join(w.dir, 'projections.db')
    const pass = async () => {
      const j = await openJournal({ path: w.journalPath })
      try {
        return await catchUpProjections({ journal: j, adapterVersions: null, env: { AGENTISTICS_PROJECTIONS: '1' }, storeOptions: { path: storePath } })
      } finally { j.close() }
    }
    await run(w, '1.0.0')
    const first = await pass()
    expect(first.state).toBe('done')
    const resumed = await pass()
    expect(resumed.projections.every(p => p.mode === 'resume')).toBe(true)
    await run(w, '1.1.0')
    const after = await pass()
    expect(after.projections.length).toBeGreaterThan(0)
    for (const p of after.projections) {
      expect(p.mode).toBe('rebuild')
      expect(p.rebuildReason).toContain('replaced')
    }
  })

  test('deleteBySourcePrefix: exact, :child and /child match; a longer id does not', async () => {
    const w = world()
    const j = await openJournal({ path: w.journalPath })
    const mk = (id: string, ref: string): AgentisticsEvent => ({ ...events('x', '1.0.0')[0]!, eventId: deriveEventId({ sourceKind: 'harness', sourceId: 'gemini', sourceRef: ref, type: 'session.started', ordinal: 0 }), provenance: { mode: 'replayed', confidence: 'exact', adapterVersion: '1.0.0', sourceRef: ref }, sessionId: id })
    await j.append([mk('s1', 'gemini:ab'), mk('s2', 'gemini:ab:msg:3'), mk('s3', 'gemini:ab/agents/main:7'), mk('s4', 'gemini:abc:msg:3'), mk('s5', 'gemini:ab_:1')])
    expect(await j.deleteBySourcePrefix!('gemini:ab')).toBe(3)
    const left = (await j.readFrom(0, 100)).events.map(e => e.sessionId).sort()
    expect(left).toEqual(['s4', 's5'])
    j.close()
  })
})
