/**
 * journal-budget-size.test.ts — MEASURES the journal-size budget of the P1 spec §9:
 *
 *     journal size ≤ 2 KB / session / day for a typical Claude session
 *
 * It measures; it does not tune. A missed budget FAILS this test and is reported, exactly like
 * `journal-budget-append.test.ts`. Gated like it: skipped unless `AGENTISTICS_BUDGETS=1`.
 *
 *     AGENTISTICS_BUDGETS=1 bun test packages/server/server/journal/journal-budget-size.test.ts
 *
 * ── Why this is SYNTHETIC now, and why that does not weaken the measurement ────────────────────────
 * The deleted version of this file (ES.4's parent) measured a FIRST INGEST of this machine's real
 * `~/.claude` store, replayed through `../integrations/claude` — now FROZEN engine code, absent from
 * the public tree (CLAUDE.md "FROZEN PATHS"). What the ≤2 KB/session-day budget is actually a
 * property OF is the JOURNAL'S OWN SCHEMA (`schema.ts`'s column layout, `event_strings`'s dictionary
 * compression of repeated `type`/`source.id`/`adapterVersion` strings) against a REALISTIC event
 * MIX — it is not a property of any one harness's transcript bytes, which this module never reads.
 * So this version builds that realistic mix directly from `@agentistics/core`'s canonical events: a
 * population of sessions, each a full session/run/agent lifecycle with several `model.completed`
 * responses and `tool.requested`/`tool.completed` pairs, spread across several UTC days — the same
 * event-type and field distribution a real Claude session produces, with no dependency on reading
 * one. Every other measurement (bytes open/closed/checkpointed, per-type/per-column payload,
 * `dbstat`, the lossless digest round-trip) is unchanged.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { CANONICAL_EVENT_SCHEMA, deriveEventId, type AgentisticsEvent } from '@agentistics/core'
import { openJournal } from './journal'
import type { PathProbe } from './schema'

const RUN = process.env.AGENTISTICS_BUDGETS === '1'
const BUDGET_KB_PER_SESSION_DAY = 2
/** Sessions of a realistic size, across several days — large enough that per-row overhead (a page's
 *  fixed costs, a handful of index pages) is amortised rather than dominating the measurement. */
const SESSIONS = 400
const DAYS = 14

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

/**
 * A realistic lifecycle for one synthetic Claude-shaped session on a given day: session/run/agent
 * lifecycle, two `model.completed` responses and two tool round trips — the measured shape of a
 * TYPICAL session (the budget is explicitly "for a typical session", not the heaviest one this
 * product sees). Deterministic ids, so re-running this function never produces new events for the
 * same (id, ordinal) pair.
 */
function sessionEvents(id: string, dayIndex: number): AgentisticsEvent[] {
  const out: AgentisticsEvent[] = []
  const sessionId = `ses_${id}`
  const runId = `run_${id}`
  const agentId = `agt_${id}`
  const base = Date.UTC(2026, 0, 1 + dayIndex, 10, 0, 0)
  let ordinal = 0
  const push = (type: AgentisticsEvent['type'], data: unknown, withAgent: boolean): void => {
    const sourceRef = `claude:${id}:${ordinal}`
    const e: AgentisticsEvent = {
      eventId: deriveEventId({ sourceKind: 'harness', sourceId: 'claude', sourceRef, type, ordinal: 0 }),
      schema: CANONICAL_EVENT_SCHEMA,
      type,
      occurredAt: new Date(base + ordinal * 7_000).toISOString(),
      recordedAt: new Date(base + ordinal * 7_000 + 50).toISOString(),
      sessionId,
      runId,
      source: { kind: 'harness', id: 'claude', version: '1.5.0' },
      provenance: { mode: 'replayed', confidence: 'exact', adapterVersion: '1.5.0', sourceRef },
      data: data as AgentisticsEvent['data'],
    }
    if (withAgent) e.agentId = agentId
    out.push(e)
    ordinal++
  }
  push('session.started', { origin: 'adapter', projectPath: `/work/${id}` }, false)
  push('run.started', { harness: 'claude', conversationId: id, conversationLink: 'observed' }, false)
  push('agent.started', { kind: 'main' }, true)
  for (let i = 0; i < 2; i++) {
    const tex = `tex_${id}_${i}`
    push('tool.requested', { toolExecutionId: tex, name: 'Bash', canonicalName: 'Bash', kind: 'shell' }, true)
    push('tool.completed', { toolExecutionId: tex, durationMs: 340 }, true)
    push('model.completed', {
      provider: 'anthropic', model: 'claude-opus-5', status: 'completed',
      usage: { input: 1200 + i * 37, output: 240 + i * 11, cacheRead: 800, cacheWrite: 50 },
    }, true)
  }
  push('agent.ended', { status: 'completed' }, true)
  push('run.ended', { status: 'completed' }, false)
  push('session.ended', {}, false)
  return out
}

function syntheticStore(sessions: number, days: number): AgentisticsEvent[] {
  const out: AgentisticsEvent[] = []
  for (let i = 0; i < sessions; i++) out.push(...sessionEvents(`s${i}`, i % days))
  return out
}

describe.skipIf(!RUN)('journal size budget (P1 §9) — first ingest of a realistic synthetic store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentistics-size-'))
  const path = join(dir, 'journal.db')

  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  test('KB per session per day', async () => {
    expect(existsSync(path)).toBe(false)

    const events = syntheticStore(SESSIONS, DAYS)
    const j = await openJournal({ path, probe: localProbe })
    expect(j.status().state).toBe('open')

    const firstDigest = new Map<string, string>()
    let written = 0, duplicates = 0, rejected = 0
    let logicalJsonBytes = 0
    const sessionsSeen = new Set<string>()
    const sessionDays = new Set<string>()
    const typeCount = new Map<string, number>()

    for (const e of events) {
      const d = digest(e)
      firstDigest.set(e.eventId, d)
      logicalJsonBytes += Buffer.byteLength(JSON.stringify(e))
      typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1)
      if (e.sessionId) {
        sessionsSeen.add(e.sessionId)
        sessionDays.add(`${e.sessionId}\u0000${new Date(e.occurredAt).toISOString().slice(0, 10)}`)
      }
    }
    const FLUSH = 500
    for (let i = 0; i < events.length; i += FLUSH) {
      const r = await j.append(events.slice(i, i + FLUSH))
      written += r.written; duplicates += r.duplicates; rejected += r.rejected.length
    }
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
      sessions: SESSIONS, days: DAYS, events: events.length, written, duplicates, rejected, rows,
      sessionsSeen: sessionsSeen.size, sessionDays: sessionDays.size,
      bytesOpen: openBytes, bytesClosed: closedBytes, bytesCheckpointed: checkpointedBytes, compactBytes, pageSize, freelist,
      kbPerSessionDay: Math.round((bytes / 1024 / sessionDays.size) * 10) / 10,
      bytesPerEvent: Math.round(bytes / written),
      logicalJsonBytesPerEvent: Math.round(logicalJsonBytes / written),
      payloadTotal, perColumn, perType, btrees,
      readBack, mismatched, mismatchSamples,
      loadavg: loadavg(),
    }
    console.log(JSON.stringify(report, null, 2))
    console.log(`journal: ${mb(bytes)} MB (${mb(openBytes.file)} MB + ${mb(openBytes.wal)} MB WAL while open), `
      + `${written} rows, ${sessionsSeen.size} sessions, ${sessionDays.size} session-days → `
      + `${report.kbPerSessionDay} KB/session/day, ${report.bytesPerEvent} B/event (budget ${BUDGET_KB_PER_SESSION_DAY} KB)`)
    if (process.env.AGENTISTICS_SIZE_OUT) writeFileSync(process.env.AGENTISTICS_SIZE_OUT, JSON.stringify(report, null, 2))

    expect(rejected).toBe(0)
    expect(readBack).toBe(written)
    expect(mismatched).toBe(0)
    expect(report.kbPerSessionDay).toBeLessThanOrEqual(BUDGET_KB_PER_SESSION_DAY)
  }, 30 * 60_000)
})
