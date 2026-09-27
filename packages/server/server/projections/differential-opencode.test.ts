/** The opencode parity row, over the committed fixture — no legacy adapter exists, so both sides
 *  of this comparison are built in this module; see its header for why. */
import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildFixtureDb, loadFixture } from '../integrations/opencode/fixture-db'
import {
  OPENCODE_DAILY_EXPLANATION, recountOpencode, reclassifyOpencodeRows, replayAndProjectOpencode, runOpencodeDifferential,
} from './differential-opencode'

const LATER = Date.parse('2027-01-01T00:00:00Z')

function withFixtureDb<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const fixture = loadFixture()
  const dbPath = buildFixtureDb(fixture)
  return fn(dbPath).finally(() => rmSync(dirname(dbPath), { recursive: true, force: true }))
}

describe('opencode differential — over the fixture', () => {
  test('every session compares EQUAL, EXPLAINED, PARTIAL or NOT-PROJECTABLE — never a bug', async () => {
    await withFixtureDb(async dbPath => {
      const report = await runOpencodeDifferential({ dbPath, now: () => LATER, keepDiffs: true })
      expect(report.sessions).toBe(2)
      expect(report.skipped).toEqual({ live: 0, unreadable: 0 })
      expect(report.sessionsWithBugs).toBe(0)
      for (const f of report.fields) expect(f.counts.bug).toBe(0)
    })
  })

  test('the daily.<day>.tokens rows are EXPLAINED, not silently dropped', async () => {
    await withFixtureDb(async dbPath => {
      const report = await runOpencodeDifferential({ dbPath, now: () => LATER, keepDiffs: true })
      const dailyRows = report.diffs!.flatMap(d => d.rows).filter(r => r.field.startsWith('daily.') && r.field.endsWith('.tokens'))
      expect(dailyRows.length).toBeGreaterThan(0)
      for (const r of dailyRows) {
        expect(r.verdict).toBe('explained')
        expect(r.reason).toBe(OPENCODE_DAILY_EXPLANATION)
      }
    })
  })

  test('files_modified / lines_added / lines_removed are PARTIAL, never asserted equal', async () => {
    await withFixtureDb(async dbPath => {
      const report = await runOpencodeDifferential({ dbPath, now: () => LATER, keepDiffs: true })
      for (const d of report.diffs!) {
        for (const f of ['files_modified', 'lines_added', 'lines_removed']) {
          const row = d.rows.find(r => r.field === f)!
          expect(row.verdict).toBe('partial')
        }
      }
    })
  })
})

describe('recountOpencode — the independent recount', () => {
  test('sums tokens from SETTLED messages only, and starts from the session row, not the first message', async () => {
    await withFixtureDb(async dbPath => {
      const { Database } = await import('bun:sqlite')
      const db = new Database(dbPath, { readonly: true })
      const messages = db.query("SELECT id, time_created, data FROM message WHERE session_id = 'ses_fixture0000000000000001' ORDER BY time_created, id").all() as any[]
      const parts = db.query("SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = 'ses_fixture0000000000000001' ORDER BY time_created, id").all() as any[]
      db.close()

      const r = recountOpencode(1700000000000, messages, parts)
      // input: 100 (msg_a2) + 80 (msg_a6) + 90 (msg_a7) = 270; msg_a4 is an ABORTED response and
      // contributes nothing, matching the replay's own rule (no usage on model.failed).
      expect(r.tokens).toEqual({ input: 270, output: 40, cacheRead: 10, cacheWrite: 0 })
      expect(r.model).toBe('fixture-model-a') // the EARLIEST settled successful response's model
      expect(r.startMs).toBe(1700000000000) // the session row's own time_created, not msg_a1's
      expect(r.toolCounts).toEqual({ Bash: 1, Write: 1, Read: 1 })
      expect(r.toolErrors).toBe(1)
      expect(r.toolErrorCategories).toEqual({ Read: 1 })
    })
  })
})

describe('reclassifyOpencodeRows', () => {
  test('reclassifies daily.<day>.tokens bugs to explained only when the days sum to the totals', async () => {
    await withFixtureDb(async dbPath => {
      const { Database } = await import('bun:sqlite')
      const db = new Database(dbPath, { readonly: true })
      const session = db.query("SELECT id, directory, version, time_created FROM session WHERE id = 'ses_fixture0000000000000001'").get() as any
      const messages = db.query("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(session.id) as any[]
      const parts = db.query("SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created, id").all(session.id) as any[]
      db.close()

      const projection = replayAndProjectOpencode(session.id, session, messages, parts, new Date(LATER).toISOString())
      const bugRow = { family: 'time' as const, field: 'daily.2023-11-14.tokens', verdict: 'bug' as const, legacy: undefined, projected: { input: 1 } }
      const [reclassified] = reclassifyOpencodeRows([bugRow], projection)
      expect(reclassified!.verdict).toBe('explained')

      // A row that is NOT a daily.<day>.tokens field is untouched.
      const other = { family: 'tokens' as const, field: 'input_tokens', verdict: 'bug' as const, legacy: 1, projected: 2 }
      const [untouched] = reclassifyOpencodeRows([other], projection)
      expect(untouched!.verdict).toBe('bug')
    })
  })
})
