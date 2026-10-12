/**
 * qa3-replace-atomic.test.ts (QA r3, not committed) — METRICS.FIX (owner D8): a source imported under an older adapter version
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
import { Database } from 'bun:sqlite'
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
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-qa3-')) })
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


describe('QA r3 — replaceBySourcePrefix is atomic', () => {
  test('failure mid-insert rolls back: old events intact, report says journal-replace-failed', async () => {
    const w = world()
    await run(w, '1.0.0')
    const before = await all(w.journalPath)
    expect(before.length).toBe(8)
    const db = new Database(w.journalPath)
    db.exec('CREATE TABLE qa_c(n INTEGER); INSERT INTO qa_c VALUES (0);')
    db.exec('CREATE TRIGGER qa_cnt AFTER INSERT ON events BEGIN UPDATE qa_c SET n = n + 1; END;')
    db.exec("CREATE TRIGGER qa_boom BEFORE INSERT ON events WHEN (SELECT n FROM qa_c) = 3 BEGIN SELECT RAISE(ABORT, 'boom'); END;")
    db.close()
    const r = await run(w, '1.1.0')
    const a = r.harnesses[0]!.artifacts
    expect((a.failed as Record<string, number>)['journal-replace-failed']).toBeGreaterThan(0)
    const after = await all(w.journalPath)
    expect(after.length).toBe(8)
    expect(after.every(e => e.provenance.adapterVersion === '1.0.0')).toBe(true)
    expect(after.map(e => e.eventId).sort()).toEqual(before.map(e => e.eventId).sort())
  })
})
