/**
 * journal-budget-size.test.ts — MEASURES the journal-size budget of the P1 spec §9:
 *
 *     journal size ≤ 2 KB / session / day for a typical Claude session, on the real store
 *
 * It measures; it does not tune. A missed budget FAILS this test and is reported, exactly like
 * `journal-budget-append.test.ts`. Gated like it: skipped unless `AGENTISTICS_BUDGETS=1`.
 *
 *     AGENTISTICS_BUDGETS=1 AGENTISTICS_DIR=<scratch> \
 *       [AGENTISTICS_SIZE_PROJECTS=<a COPY of ~/.claude/projects>] \
 *       [AGENTISTICS_SIZE_DIR=<where the journal goes>] [AGENTISTICS_SIZE_OUT=<report.json>] \
 *       bun test packages/server/server/journal/journal-budget-size.test.ts
 *
 * ── Method (A2.5's, docs/superpowers/research/2026-09-25-p1-parity-differential.md §5) ──────────
 * - A FIRST INGEST of the store into an EMPTY journal: every transcript the Claude replay discovers,
 *   replayed from a null cursor, appended in slices of `FLUSH_EVENTS` (the shadow writer's batch).
 *   The store is read only. Point `AGENTISTICS_SIZE_PROJECTS` at a COPY to compare two builds on the
 *   same bytes: the live store grows while you measure.
 * - The journal file is created in a scratch directory, never `~/.agentistics`, and the test refuses
 *   to run without an explicit `AGENTISTICS_DIR` so nothing it imports can touch the real data dir.
 * - Bytes are reported THREE times: file + `-wal` while the journal is still open (what A2.5
 *   reported as "264.5 MB plus a 6.9 MB WAL"), after `close()`, and after a `wal_checkpoint(TRUNCATE)`
 *   from a fresh connection. The budget is judged on the last, which holds every committed page once
 *   (`close()` checkpoints but leaves the `-wal` FILE on disk — see the comment where it runs).
 * - `sessions` = distinct `session_id` over the rows written; `session-days` = distinct
 *   (`session_id`, UTC day of `occurred_at`) pairs over the rows written. That is A2.5's definition.
 * - Per type and per column: the RECORD payload bytes each column costs (text/blob length, SQLite's
 *   serial-type size for an integer), summed over the rows of each type. Per b-tree (the table and
 *   each index): pages, bytes, payload and unused bytes, from `dbstat` through `python3`'s sqlite3
 *   when it has it (bun's SQLite is not compiled with `dbstat`); otherwise "unavailable".
 * - LOSSLESS, end to end: every event written is read back through `readFrom` and compared (canonical
 *   JSON, sha-256) with the event that was appended FIRST under its id. Any difference fails.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { AgentisticsEvent } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR, PROJECTS_DIR } from '../config'
import { createClaudeReplay } from '../integrations/claude'
import { openJournal } from './journal'
import { FLUSH_EVENTS } from './shadow'
import type { PathProbe } from './schema'

const RUN = process.env.AGENTISTICS_BUDGETS === '1'
const BUDGET_KB_PER_SESSION_DAY = 2

const localProbe: PathProbe = {
  platform: 'linux',
  realpath: p => p,
  readMountinfo: () => '58 42 8:32 / / rw,relatime - ext4 /dev/sdc rw',
  readDarwinMounts: () => null,
}

/** JSON with object keys sorted at every level — two deep-equal events serialise identically. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
const digest = (e: AgentisticsEvent) => createHash('sha256').update(canonical(e)).digest('base64')

const size = (p: string) => { try { return statSync(p).size } catch { return 0 } }
const mb = (b: number) => Math.round(b / 1e5) / 10

/** The record payload bytes of one column value: SQLite's serial-type sizes (file format 4). */
function payloadExpr(col: string): string {
  const c = `"${col}"`
  return `SUM(CASE typeof(${c})
    WHEN 'text' THEN length(CAST(${c} AS BLOB))
    WHEN 'blob' THEN length(${c})
    WHEN 'integer' THEN CASE
      WHEN ${c} BETWEEN 0 AND 1 THEN 0
      WHEN ${c} BETWEEN -128 AND 127 THEN 1
      WHEN ${c} BETWEEN -32768 AND 32767 THEN 2
      WHEN ${c} BETWEEN -8388608 AND 8388607 THEN 3
      WHEN ${c} BETWEEN -2147483648 AND 2147483647 THEN 4
      WHEN ${c} BETWEEN -140737488355328 AND 140737488355327 THEN 6
      ELSE 8 END
    WHEN 'real' THEN 8 ELSE 0 END)`
}

const DBSTAT_PY = `
import json, sqlite3, sys
c = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
rows = c.execute("select name, count(*), sum(pgsize), sum(payload), sum(unused) from dbstat group by name order by 3 desc").fetchall()
print(json.dumps([dict(name=r[0], pages=r[1], bytes=r[2], payload=r[3], unused=r[4]) for r in rows]))
`

function dbstat(path: string): unknown {
  try {
    const r = Bun.spawnSync(['python3', '-c', DBSTAT_PY, path])
    if (r.exitCode !== 0) return `unavailable: ${r.stderr.toString().trim().split('\n').pop()}`
    return JSON.parse(r.stdout.toString())
  } catch (e) {
    return `unavailable: ${String(e)}`
  }
}

describe.skipIf(!RUN)('journal size budget (P1 §9) — first ingest of the real store', () => {
  const dir = process.env.AGENTISTICS_SIZE_DIR ?? mkdtempSync(join(tmpdir(), 'agentistics-size-'))
  const path = join(dir, 'journal.db')
  const projectsDir = process.env.AGENTISTICS_SIZE_PROJECTS ?? PROJECTS_DIR

  afterAll(() => {
    if (!process.env.AGENTISTICS_SIZE_DIR) rmSync(dir, { recursive: true, force: true })
  })

  test('KB per session per day', async () => {
    // Nothing this imports may reach the real data dir.
    expect(process.env.AGENTISTICS_DIR).toBeTruthy()
    expect(AGENTISTICS_DATA_DIR).not.toBe(DEFAULT_AGENTISTICS_DATA_DIR)
    expect(existsSync(path)).toBe(false)

    const t0 = Date.now()
    const j = await openJournal({ path, probe: localProbe })
    expect(j.status().state).toBe('open')

    const replay = createClaudeReplay({ projectsDir })
    const sources = await replay.discover()
    const firstDigest = new Map<string, string>()
    let events = 0, written = 0, duplicates = 0, rejected = 0, dupDiffers = 0
    let logicalJsonBytes = 0
    const sessions = new Set<string>()
    const sessionDays = new Set<string>()
    const typeCount = new Map<string, number>()

    for (const src of sources) {
      const batch = await replay.replay(src, null)
      events += batch.events.length
      for (const e of batch.events) {
        const d = digest(e)
        const prev = firstDigest.get(e.eventId)
        if (prev !== undefined) { if (prev !== d) dupDiffers++; continue }
        firstDigest.set(e.eventId, d)
        logicalJsonBytes += Buffer.byteLength(JSON.stringify(e))
        typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1)
        if (e.sessionId) {
          sessions.add(e.sessionId)
          sessionDays.add(`${e.sessionId}\u0000${new Date(e.occurredAt).toISOString().slice(0, 10)}`)
        }
      }
      for (let i = 0; i < batch.events.length; i += FLUSH_EVENTS) {
        const r = await j.append(batch.events.slice(i, i + FLUSH_EVENTS))
        written += r.written; duplicates += r.duplicates; rejected += r.rejected.length
      }
    }
    const ingestMs = Date.now() - t0
    const openBytes = { file: size(path), wal: size(`${path}-wal`) }

    // Lossless, end to end: every row read back equals the event first appended under its id.
    let cursor = 0, readBack = 0, mismatched = 0
    const mismatchSamples: string[] = []
    for (;;) {
      const page = await j.readFrom(cursor, 1000)
      if (page.events.length === 0) break
      for (const e of page.events) {
        readBack++
        if (firstDigest.get(e.eventId) !== digest(e)) {
          mismatched++
          if (mismatchSamples.length < 3) mismatchSamples.push(canonical(e).slice(0, 400))
        }
      }
      cursor = page.cursor
    }
    j.close()
    const closedBytes = { file: size(path), wal: size(`${path}-wal`) }
    // `close()` runs a PASSIVE checkpoint (A1.7 item 1), so every committed page is already in the
    // main file here — but a PASSIVE checkpoint does not shrink the `-wal` file, and bun defers the
    // connection's own close while its prepared statements are alive, so the file is left behind at
    // its high-water size. The budget is judged after a TRUNCATE checkpoint: every committed page
    // counted once, in the file, and the stale `-wal` not counted at all.
    const ck = new Database(path)
    ck.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    ck.close()
    const checkpointedBytes = { file: size(path), wal: size(`${path}-wal`) }

    const db = new Database(path, { readonly: true })
    const cols = (db.query('PRAGMA table_info(events)').all() as { name: string; pk: number }[])
      .filter(c => c.pk === 0).map(c => c.name)
    const hasDict = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_strings'").get()
    const typeExpr = hasDict
      ? "COALESCE((SELECT s FROM event_strings WHERE id = events.type), events.type)"
      : 'events.type'
    const perType = db.query(
      `SELECT ${typeExpr} AS t, COUNT(*) AS n, ${cols.map(c => `${payloadExpr(c)} AS "${c}"`).join(', ')}
       FROM events GROUP BY 1 ORDER BY 2 DESC`,
    ).all() as Record<string, number | string>[]
    const pageSize = (db.query('PRAGMA page_size').get() as { page_size: number }).page_size
    const freelist = (db.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
    const rows = (db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    db.close()

    const compact = join(dir, 'vacuumed.db')
    rmSync(compact, { force: true })
    const vdb = new Database(path)
    vdb.exec(`VACUUM INTO '${compact.replace(/'/g, "''")}'`)
    vdb.close()
    const compactBytes = size(compact)
    const btrees = dbstat(path)
    rmSync(compact, { force: true })

    const perColumn: Record<string, number> = {}
    for (const r of perType) for (const c of cols) perColumn[c] = (perColumn[c] ?? 0) + Number(r[c] ?? 0)
    const payloadTotal = Object.values(perColumn).reduce((a, b) => a + b, 0)
    const bytes = checkpointedBytes.file + checkpointedBytes.wal
    const report = {
      projectsDir, sources: sources.length, events, written, duplicates, rejected, dupDiffers, rows,
      sessions: sessions.size, sessionDays: sessionDays.size,
      bytesOpen: openBytes, bytesClosed: closedBytes, bytesCheckpointed: checkpointedBytes, compactBytes, pageSize, freelist,
      kbPerSessionDay: Math.round((bytes / 1024 / sessionDays.size) * 10) / 10,
      bytesPerEvent: Math.round(bytes / written),
      logicalJsonBytesPerEvent: Math.round(logicalJsonBytes / written),
      payloadTotal, perColumn, perType, btrees,
      readBack, mismatched, mismatchSamples, ingestMs,
      loadavg: loadavg(),
    }
    console.log(JSON.stringify(report, null, 2))
    console.log(`journal: ${mb(bytes)} MB (${mb(openBytes.file)} MB + ${mb(openBytes.wal)} MB WAL while open), `
      + `${written} rows, ${sessions.size} sessions, ${sessionDays.size} session-days → `
      + `${report.kbPerSessionDay} KB/session/day, ${report.bytesPerEvent} B/event (budget ${BUDGET_KB_PER_SESSION_DAY} KB)`)
    if (process.env.AGENTISTICS_SIZE_OUT) writeFileSync(process.env.AGENTISTICS_SIZE_OUT, JSON.stringify(report, null, 2))

    expect(rejected).toBe(0)
    expect(readBack).toBe(written)
    expect(mismatched).toBe(0)
    expect(report.kbPerSessionDay).toBeLessThanOrEqual(BUDGET_KB_PER_SESSION_DAY)
  }, 30 * 60_000)
})
