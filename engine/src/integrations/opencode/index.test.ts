/** The opencode replay's IO half over the fixture: discovery, one full read, idempotency, chunking. */
import { describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildFixtureDb, loadFixture } from './fixture-db'
import { createOpencodeReplay, orderedRecords } from './index'
import { emptyOpencodeReplay, finishOpencodeReplay, foldOpencodeReplay, type OpencodeRecord } from './replay'
import { opencodeContext } from './replay-core'

const LATER = Date.parse('2027-01-01T00:00:00Z')

async function withFixtureDb<T>(fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  const fixture = loadFixture()
  const dbPath = buildFixtureDb(fixture)
  try {
    return await fn(dbPath)
  } finally {
    rmSync(dirname(dbPath), { recursive: true, force: true })
  }
}

describe('opencode replay — discovery', () => {
  test('every fixture session is discovered, in id order', async () => {
    await withFixtureDb(async dbPath => {
      const r = createOpencodeReplay({ dbPath, now: () => LATER })
      const sources = await r.discover()
      expect(sources.map(s => s.sessionId)).toEqual([
        'ses_fixture0000000000000001', 'ses_fixture0000000000000002',
      ])
      expect(sources[0]).toEqual({ sessionId: 'ses_fixture0000000000000001', sourceRef: 'opencode:ses_fixture0000000000000001' })
    })
  })

  test('an unreadable store is an empty list, never a throw', async () => {
    const r = createOpencodeReplay({ dbPath: '/nonexistent/opencode.db', now: () => LATER })
    expect(await r.discover()).toEqual([])
    expect((await r.replay({ sessionId: 'x', sourceRef: 'x' }, null)).events).toEqual([])
  })

  test('opening the fixture db {readonly:true} never creates a -wal/-shm file (CLAUDE.md step 18)', async () => {
    await withFixtureDb(async dbPath => {
      const r = createOpencodeReplay({ dbPath, now: () => LATER })
      const [a] = await r.discover()
      await r.replay(a!, null)
      expect(existsSync(`${dbPath}-wal`)).toBe(false)
      expect(existsSync(`${dbPath}-shm`)).toBe(false)
    })
  })
})

describe('opencode replay — one session, settled', () => {
  test('the tool-calls turn, the aborted message and the model switch all replay', async () => {
    await withFixtureDb(async dbPath => {
      const r = createOpencodeReplay({ dbPath, now: () => LATER })
      const [a] = await r.discover()
      const { events } = await r.replay(a!, null)

      expect(events.filter(e => e.type === 'session.started')).toHaveLength(1)
      expect(events.filter(e => e.type === 'run.started')).toHaveLength(1)
      expect(events.filter(e => e.type === 'agent.started')).toHaveLength(1)
      expect(events.filter(e => e.type === 'session.ended')).toHaveLength(1)

      // 4 user turns; the aborted assistant message still counts as a settled response.
      expect(events.filter(e => e.type === 'turn.started')).toHaveLength(3)
      expect(events.filter(e => e.type === 'turn.ended')).toHaveLength(3)
      for (const e of events.filter(e => e.type === 'turn.ended')) expect(e.data).toMatchObject({ close: 'last-line' })

      const completed = events.filter(e => e.type === 'model.completed')
      const failed = events.filter(e => e.type === 'model.failed')
      expect(completed).toHaveLength(3) // msg_a2, msg_a6, msg_a7
      expect(failed).toHaveLength(1) // msg_a4 (aborted)
      expect(failed[0]!.data).toMatchObject({ status: 'cancelled', errorClass: 'MessageAbortedError' })

      // The reasoning counter is additive, never folded into output.
      const bashCompleted = completed[0]!
      expect(bashCompleted.data).toMatchObject({ usage: { input: 100, output: 20, cacheRead: 10 }, reasoning: { tokens: 5, billing: 'additive' } })

      const toolReq = events.filter(e => e.type === 'tool.requested')
      expect(toolReq.map(e => (e.data as { canonicalName: string }).canonicalName).sort()).toEqual(['Bash', 'Read', 'Write'])
      const toolFailed = events.filter(e => e.type === 'tool.failed')
      expect(toolFailed).toHaveLength(1)

      // Every event id is derived, so this run has no collisions and no accidental dupes.
      expect(new Set(events.map(e => e.eventId)).size).toBe(events.length)
    })
  })

  test('replaying twice re-derives identical ids (idempotent under a cold re-read)', async () => {
    await withFixtureDb(async dbPath => {
      const r1 = createOpencodeReplay({ dbPath, now: () => LATER })
      const [a1] = await r1.discover()
      const first = (await r1.replay(a1!, null)).events.map(e => e.eventId).sort()

      const r2 = createOpencodeReplay({ dbPath, now: () => LATER })
      const [a2] = await r2.discover()
      const second = (await r2.replay(a2!, null)).events.map(e => e.eventId).sort()

      expect(second).toEqual(first)
    })
  })

  test('an unchanged, settled cursor returns nothing on the next call', async () => {
    await withFixtureDb(async dbPath => {
      const r = createOpencodeReplay({ dbPath, now: () => LATER })
      const [a] = await r.discover()
      const batch1 = await r.replay(a!, null)
      expect(batch1.events.length).toBeGreaterThan(0)
      const batch2 = await r.replay(a!, batch1.cursor)
      expect(batch2.events).toEqual([])
    })
  })
})

describe('opencode replay fold — chunk independence', () => {
  test('folding all records at once equals folding them in three uneven pieces', async () => {
    await withFixtureDb(async dbPath => {
      // Read the same rows the IO half would, then fold through the PURE function directly, split
      // two different ways — this is `foldOpencodeReplay`'s own contract (index.ts's header),
      // exercised without going through the replay's cursor/fingerprint machinery at all.
      const { Database } = await import('bun:sqlite')
      const db = new Database(dbPath, { readonly: true })
      const messages = db.query("SELECT id, time_created, data FROM message WHERE session_id = 'ses_fixture0000000000000001' ORDER BY time_created, id").all() as any[]
      const parts = db.query("SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = 'ses_fixture0000000000000001' ORDER BY time_created, id").all() as any[]
      db.close()
      const records: OpencodeRecord[] = orderedRecords(messages, parts)
      expect(records.length).toBeGreaterThan(4)

      const ctx = opencodeContext('ses_fixture0000000000000001', new Date(LATER).toISOString())

      const whole = emptyOpencodeReplay(ctx)
      const wholeEvents: any[] = []
      foldOpencodeReplay(whole, records, e => wholeEvents.push(e))

      const chunked = emptyOpencodeReplay(ctx)
      const chunkedEvents: any[] = []
      const cut1 = Math.floor(records.length / 3)
      const cut2 = Math.floor((records.length * 2) / 3)
      foldOpencodeReplay(chunked, records.slice(0, cut1), e => chunkedEvents.push(e))
      foldOpencodeReplay(chunked, records.slice(cut1, cut2), e => chunkedEvents.push(e))
      foldOpencodeReplay(chunked, records.slice(cut2), e => chunkedEvents.push(e))

      expect(chunkedEvents.map(e => e.eventId).sort()).toEqual(wholeEvents.map(e => e.eventId).sort())
      expect(chunked.maxMs).toBe(whole.maxMs)
      expect(chunked.opened).toBe(whole.opened)
    })
  })
})

describe('opencode replay — finish()', () => {
  test('final:true closes any still-open turn and emits the closing lifecycle events once', () => {
    const ctx = opencodeContext('ses_x', new Date(LATER).toISOString())
    const state = emptyOpencodeReplay(ctx)
    const events: any[] = []
    foldOpencodeReplay(state, [
      { kind: 'user_message', id: 'u1', createdAt: 1000 },
      { kind: 'assistant_message', id: 'a1', createdAt: 1500, completedAt: 2000, modelId: 'm', finish: 'stop', tokens: { input: 1, output: 1 } },
    ], e => events.push(e))
    finishOpencodeReplay(state, { projectPath: '', startedAtMs: 900 }, { final: true }, e => events.push(e))
    expect(events.filter(e => e.type === 'turn.ended')).toHaveLength(1)
    expect(events.filter(e => e.type === 'session.ended')).toHaveLength(1)
    expect(events.filter(e => e.type === 'run.ended')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent.ended')).toHaveLength(1)
  })
})
