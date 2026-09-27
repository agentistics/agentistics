/**
 * journal/journal.ts — the connection, the transaction per batch and the status (P1 §4.2, master
 * spec §19.2). The pure half (which events are acceptable, row <-> event) is `journal-plan.ts`; the
 * DDL, the pragma order and the network-filesystem refusal are `schema.ts`. This module owns only
 * what needs a live connection, and every rule in it is here for a reason:
 *
 * - **`openJournal` NEVER throws.** A journal that cannot be opened degrades to a NO-OP object with
 *   the same interface — the `parse-cache.ts` pattern — and says WHY in `status().reason`. The cost of
 *   a broken journal is the feature, never a failed build (P1 §4.2, §5). `bun:sqlite` is imported
 *   dynamically (and injectably) so a non-Bun runtime reports `no-sqlite` instead of crashing at
 *   import time.
 * - **A network path is refused BEFORE anything is created.** SQLite documents WAL as unsafe on a
 *   network filesystem; creating the directory or the file there first would leave debris behind a
 *   refusal. `unknown` OPENS — a refusal on a guess would disable the journal on every machine whose
 *   mount table we could not read.
 * - **A disabled journal still runs the plan.** A rejection is a bug in the PRODUCER, and the producer
 *   is just as wrong when the journal is off; the accepted events are counted as `dropped`, which is
 *   the counter that makes a no-op visible.
 * - **ONE transaction per batch, taken with BEGIN IMMEDIATE.** Deferred BEGIN takes a read lock and
 *   upgrades on the first INSERT; two connections doing that at once can dead-end in SQLITE_BUSY that
 *   `busy_timeout` cannot resolve. Taking the write lock up front turns contention into WAITING, which
 *   is what the measurement found (latency, never error). A failed batch rolls back whole — nothing
 *   partial is ever in the table.
 * - **Idempotency is STRUCTURAL**: `UNIQUE(event_id)` + `INSERT OR IGNORE`, and `changes` per row
 *   tells written from duplicate — which is also how a duplicate WITHIN one batch is counted. Never a
 *   pre-SELECT: a read-then-write is a race between two connections.
 * - **The first write after a WAL recovery gets a bounded retry** (research 15, amendment 2: even with
 *   `busy_timeout` set, the statement right after reopening a WAL whose writer was SIGKILLed sometimes
 *   threw one transient SQLITE_BUSY). Only while recovery is pending, only for a BUSY error, a handful
 *   of attempts ~50 ms apart; afterwards `busy_timeout` alone. BUSY is identified by CODE, never by
 *   matching a message — a message is not an interface.
 * - **`append` never throws.** A write that still fails is counted (`failedAppends`, `dropped`) and
 *   reported as nothing written. The only method that throws is `readFrom`, and only on a cursor that
 *   is not a non-negative safe integer: that is a caller bug, not a runtime condition, and silently
 *   answering it would hand a poller a page from the wrong place.
 * - **Reads are pages, never "everything"** — clamped to `MAX_PAGE` whatever the caller asks for.
 * - **The WAL checkpoint runs AFTER an append, never inside one** (research A1.7). A checkpoint copies
 *   the WAL into the main file and then fsyncs both, and on this machine the fsyncs are the cost: a
 *   PASSIVE checkpoint of ~1000 frames took a median 14 ms with `synchronous = NORMAL` against
 *   1.2 ms with the syncs switched off. SQLite's default autocheckpoint (1000 pages) ran it INSIDE
 *   the COMMIT of whichever batch crossed the threshold — 12–20 % of the benchmark's batches, every
 *   one of them far over the 2 ms budget. So a successful write arms ONE deferred `wal_checkpoint(PASSIVE)`
 *   (`CHECKPOINT_DELAY_MS` later, on a timer that never keeps the process alive) and the append
 *   returns. PASSIVE never waits on a reader or a writer and never throws out of here; a busy or
 *   failed one is retried by the next arm. SQLite's autocheckpoint stays on as a CEILING
 *   (`WAL_AUTOCHECKPOINT_PAGES`, schema.ts), so a producer that never yields to the event loop — a
 *   tight loop of appends, in which no timer can fire — still has a bounded WAL, paying the
 *   checkpoint in an append only once per ceiling's worth of frames. `close()` cancels the timer and
 *   checkpoints before closing. One cost is NOT moved, on purpose: the first commit after a
 *   checkpoint restarts the WAL and, under `synchronous = NORMAL`, fsyncs its new header (~1.3 ms
 *   measured) — that sync is what keeps the WAL consistent across a power loss.
 */
import { dirname } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import type { AgentisticsEvent } from '@agentistics/core'
import { JOURNAL_PATH } from '../config'
import { decodeInstant, decodeRow, encodeRow, planAppend, rowToEvent, type JournalRow, type StoredRow } from './journal-plan'
import {
  JournalOpenError,
  STORED_COLUMNS,
  classifyJournalPath,
  defaultPathProbe,
  openDatabase,
  type PathProbe,
} from './schema'
import { DEFAULT_STRING_CACHE_BYTES, StringCache } from './string-cache'
import {
  MAX_PAGE,
  type AppendResult,
  type Journal,
  type JournalCounters,
  type JournalDisabledReason,
  type JournalStats,
  type JournalStatus,
  type PathKind,
  type ReadPage,
  type Rejection,
} from './types'

export interface OpenJournalOptions {
  /** Default `JOURNAL_PATH`. */
  path?: string
  /** Default `defaultPathProbe()`. Injected so a test can claim any filesystem. */
  probe?: PathProbe
  /** Default `() => import('bun:sqlite')`. Injectable so a test can simulate `no-sqlite`. */
  loadSqlite?: () => Promise<typeof import('bun:sqlite')>
  /** Default a real timer. Injected so the recovery retry is testable without waiting. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Default an `unref`'d `setTimeout`. Runs the deferred WAL checkpoint `delayMs` later and returns a
   * function that cancels it. Injected so a test can decide when (or whether) the timer fires.
   */
  scheduleCheckpoint?: (run: () => void, delayMs: number) => () => void
  /**
   * Default `new StringCache(DEFAULT_STRING_CACHE_BYTES)`. Injected so a test or a measurement
   * script can supply its own budget (including an unbounded one, for a before/after comparison)
   * and read `.stats()` off the very instance this journal uses.
   */
  stringCache?: StringCache
}

/**
 * How long after the first write of a quiet period the deferred PASSIVE checkpoint runs. The timer is
 * armed once and not re-armed by later appends (a THROTTLE, not a debounce), so a producer appending
 * every few milliseconds still gets a checkpoint every `CHECKPOINT_DELAY_MS`, between its appends —
 * a debounce would never fire under a steady stream and leave everything to the in-append ceiling.
 */
export const CHECKPOINT_DELAY_MS = 250

const realScheduleCheckpoint = (run: () => void, delayMs: number): (() => void) => {
  const t = setTimeout(run, delayMs)
  // A pending checkpoint must never keep a one-shot CLI process alive; close() checkpoints anyway.
  ;(t as { unref?: () => void }).unref?.()
  return () => clearTimeout(t)
}

/**
 * The INSERT binds `STORED_COLUMNS` (schema.ts): the v2 encoding of a `JournalRow` (journal-plan.ts
 * `encodeRow`), with every repeated string interned into `event_strings` inside the SAME transaction
 * as the rows that name it. The rowid is the cursor and is never bound.
 */
const INSERT_SQL =
  `INSERT OR IGNORE INTO events (${STORED_COLUMNS.join(', ')}) VALUES (${STORED_COLUMNS.map(() => '?').join(', ')})`
const PAGE_SQL =
  `SELECT rowid AS cursor_rowid, ${STORED_COLUMNS.join(', ')} FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?`

const RECOVERY_ATTEMPTS = 5
const RECOVERY_DELAY_MS = 50
const SQLITE_BUSY = 5

/**
 * Whether an error is SQLite's BUSY — by CODE (`SQLITE_BUSY`, `SQLITE_BUSY_RECOVERY`,
 * `SQLITE_BUSY_SNAPSHOT`, …) or by the primary result code in `errno` (extended codes carry the
 * primary one in the low byte). Never by message: `Error('database is locked')` with no code is NOT
 * recognised, on purpose.
 */
export function isBusyError(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false
  const { code, errno } = e as { code?: unknown; errno?: unknown }
  if (typeof code === 'string' && (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_'))) return true
  if (typeof errno === 'number' && Number.isInteger(errno) && (errno & 0xff) === SQLITE_BUSY) return true
  return false
}

/**
 * Run `fn`; while `pending` (a WAL recovery has not yet been followed by a successful write), retry it
 * on a BUSY error up to `attempts` times in total, sleeping `RECOVERY_DELAY_MS` between tries. Not
 * pending, or any non-BUSY error, throws on the first failure.
 */
export async function withRecoveryRetry<T>(
  fn: () => T,
  pending: boolean,
  sleep: (ms: number) => Promise<void>,
  attempts = RECOVERY_ATTEMPTS,
): Promise<T> {
  if (!pending) return fn()
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn()
    } catch (e) {
      last = e
      if (!isBusyError(e) || attempt === attempts) throw e
      await sleep(RECOVERY_DELAY_MS)
    }
  }
  throw last
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function emptyCounters(): JournalCounters {
  return { written: 0, duplicates: 0, rejected: 0, dropped: 0, failedAppends: 0, failedReads: 0 }
}

function fileSize(p: string): number {
  try { return statSync(p).size } catch { return 0 }
}

function assertCursor(cursor: number): void {
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RangeError(`journal cursor must be a non-negative safe integer, got ${String(cursor)}`)
  }
}

function clampLimit(limit: number): number {
  const n = Math.floor(limit)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, MAX_PAGE)
}

interface Where {
  path: string
  pathKind: PathKind
  fsType?: string
}

/**
 * A journal that accepts nothing. It still PLANS every batch — rejections are reported and counted —
 * and adds the accepted events to `dropped`. Never throws (except `readFrom` on a bad cursor, the one
 * caller bug the interface refuses everywhere).
 */
function disabledJournal(where: Where, reason: JournalDisabledReason): Journal {
  const counters = emptyCounters()
  return {
    async append(events) {
      const plan = safePlan(events, counters)
      counters.rejected += plan.rejected.length
      counters.dropped += plan.rows.length
      return { written: 0, duplicates: 0, rejected: plan.rejected }
    },
    async readFrom(cursor) {
      assertCursor(cursor)
      return { events: [], cursor }
    },
    async stats() {
      return { rows: 0, bytes: 0 }
    },
    status() {
      return { state: 'disabled', reason, ...copyWhere(where), counters: { ...counters } }
    },
    close() { /* nothing is open */ },
  }
}

function copyWhere(where: Where): Where {
  const out: Where = { path: where.path, pathKind: where.pathKind }
  if (where.fsType !== undefined) out.fsType = where.fsType
  return out
}

/**
 * `planAppend` is pure and total by contract; this guard exists only so that a defect in it can never
 * make `append` throw into a build. A plan that throws accepts nothing and names nothing — so every
 * event of that batch is counted as DROPPED, or a planner bug would lose events without a trace.
 */
function safePlan(
  events: readonly AgentisticsEvent[],
  counters: JournalCounters,
): ReturnType<typeof planAppend> {
  try {
    return planAppend(events)
  } catch {
    counters.dropped += events.length
    return { rows: [], rejected: [] }
  }
}

type InsertStmt = { run(...args: (string | number | Uint8Array | null)[]): { changes: number } }

/**
 * One encoded row through the prepared INSERT, its values passed positionally in `STORED_COLUMNS`
 * order. Written out rather than `insert.run(...STORED_COLUMNS.map(c => row[c] ?? null))`: that built
 * a closure and a 19-slot array per row, ~0.1 ms of every 100-event batch (research A1.7). Every
 * optional column of a `StoredRow` is already `null` when absent (`encodeRow`), so no `undefined` can
 * be bound here. `journal.test.ts` round-trips every column, so a drift between this order and
 * `STORED_COLUMNS` fails there.
 */
function insertRow(insert: InsertStmt, r: StoredRow): number {
  return insert.run(
    r.event_id, r.schema, r.type, r.occurred_at, r.recorded_at,
    r.session_id, r.run_id, r.agent_id, r.task_id,
    r.source_kind, r.source_id, r.source_version,
    r.mode, r.confidence, r.adapter_version, r.source_ref, r.source_ref_line,
    r.data_shape, r.data,
  ).changes
}

export async function openJournal(opts: OpenJournalOptions = {}): Promise<Journal> {
  const path = opts.path ?? JOURNAL_PATH
  const sleep = opts.sleep ?? realSleep
  const scheduleCheckpoint = opts.scheduleCheckpoint ?? realScheduleCheckpoint
  const where: Where = { path, pathKind: 'unknown' }

  try {
    const probe = opts.probe ?? defaultPathProbe()
    const dir = dirname(path)
    const cls = classifyJournalPath(dir, probe)
    where.pathKind = cls.kind
    if (cls.fsType !== undefined) where.fsType = cls.fsType
    // Refused BEFORE the directory or any file exists: a refusal leaves nothing behind.
    if (cls.kind === 'network') return disabledJournal(where, 'network-filesystem')

    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return disabledJournal(where, 'open-failed')
    }

    // A non-empty -wal BEFORE we open means the previous writer never checkpointed (it was killed):
    // opening will run recovery, and the first write after it gets the bounded retry.
    let recoveryPending = fileSize(`${path}-wal`) > 0

    let sqlite: typeof import('bun:sqlite')
    try {
      sqlite = await (opts.loadSqlite ?? (() => import('bun:sqlite')))()
      if (!sqlite || typeof sqlite.Database !== 'function') throw new Error('bun:sqlite has no Database')
    } catch {
      return disabledJournal(where, 'no-sqlite')
    }

    let db: Database
    try {
      db = openDatabase(sqlite.Database, path)
    } catch (e) {
      return disabledJournal(where, e instanceof JournalOpenError ? e.reason : 'open-failed')
    }

    // The interned-string dictionary, as far as this process has seen it COMMITTED — a BOUNDED,
    // bidirectional cache (string-cache.ts), never unbounded: a full replay or a wide catch-up walk
    // would otherwise pin every distinct string the process has ever met for its whole lifetime (the
    // defect A1.8 replaces this with). A miss here is never wrong, only slower — `intern` / `lookup`
    // both fall through to `event_strings` on one. An id is never reused and a string never rewritten
    // (schema.ts), so a committed pair is valid for the life of the process whatever other processes
    // write, and a cached pair never needs to be told "this changed" — only evicted for space. Ids
    // first met inside a transaction are held apart (`fresh`) and join the cache only once that
    // transaction commits: a rolled-back batch takes its new strings with it, and a cached id for a
    // row that no longer exists would name nothing.
    const cache = opts.stringCache ?? new StringCache(DEFAULT_STRING_CACHE_BYTES)
    const remember = (fresh: Map<string, number>) => {
      for (const [s, id] of fresh) cache.put(s, id)
    }

    let insertTx: { immediate: (rows: JournalRow[]) => { written: number; duplicates: number; fresh: Map<string, number> } }
    let pageStmt: ReturnType<Database['query']>
    let statsStmt: ReturnType<Database['query']>
    let stringStmt: ReturnType<Database['query']>
    try {
      const insert = db.prepare(INSERT_SQL) as unknown as InsertStmt
      const findString = db.prepare('SELECT id FROM event_strings WHERE s = ?')
      const addString = db.prepare('INSERT INTO event_strings (s) VALUES (?)')
      insertTx = db.transaction((rows: JournalRow[]) => {
        const fresh = new Map<string, number>()
        // Inside BEGIN IMMEDIATE this connection holds the write lock, so the SELECT sees every
        // string any other process has committed and nobody can add one between it and the INSERT.
        const intern = (s: string): number => {
          const known = cache.getId(s) ?? fresh.get(s)
          if (known !== undefined) return known
          const hit = findString.get(s) as { id: number } | null
          const id = hit ? hit.id : Number(addString.run(s).lastInsertRowid)
          fresh.set(s, id)
          return id
        }
        let written = 0
        let duplicates = 0
        for (const row of rows) {
          if (insertRow(insert, encodeRow(row, intern)) === 1) written++
          else duplicates++
        }
        return { written, duplicates, fresh }
      }) as unknown as typeof insertTx
      pageStmt = db.query(PAGE_SQL)
      statsStmt = db.query(
        'SELECT COUNT(*) AS n, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at FROM events',
      )
      stringStmt = db.query('SELECT s FROM event_strings WHERE id = ?')
    } catch {
      // A table that does not have the columns we bind (schema.ts said it migrated, the statement
      // disagrees): the same outcome as a failed migration.
      try { db.close() } catch { /* already gone */ }
      return disabledJournal(where, 'migrate-failed')
    }

    /** An interned id → its string. An id no row of `event_strings` carries is a corrupt row: throw. */
    const lookup = (id: number): string => {
      const known = cache.getString(id)
      if (known !== undefined) return known
      const hit = stringStmt.get(id) as { s: string } | null
      if (!hit) throw new Error(`journal row names an unknown string id ${id}`)
      cache.put(hit.s, id)
      return hit.s
    }

    const counters = emptyCounters()
    let state: 'open' | 'closed' = 'open'

    // ── The deferred checkpoint (see the header) ──
    let checkpointStmt: ReturnType<Database['query']> | null = null
    let cancelCheckpoint: (() => void) | null = null
    /** PASSIVE: copies what it can without waiting on anyone. Never throws out of here. */
    const checkpointNow = (): void => {
      try {
        checkpointStmt ??= db.query('PRAGMA wal_checkpoint(PASSIVE)')
        checkpointStmt.get()
      } catch {
        // BUSY or I/O: nothing is lost — the frames stay in the WAL, the next arm (or the ceiling)
        // copies them.
      }
    }
    const armCheckpoint = (): void => {
      if (cancelCheckpoint !== null || state === 'closed') return
      try {
        cancelCheckpoint = scheduleCheckpoint(() => {
          cancelCheckpoint = null
          if (state === 'open') checkpointNow()
        }, CHECKPOINT_DELAY_MS)
      } catch {
        // A scheduler that throws leaves the ceiling in charge; the append already succeeded.
        cancelCheckpoint = null
      }
    }

    const journal: Journal = {
      async append(events): Promise<AppendResult> {
        const plan = safePlan(events, counters)
        const rejected: Rejection[] = plan.rejected
        counters.rejected += rejected.length
        if (plan.rows.length === 0) return { written: 0, duplicates: 0, rejected }
        if (state === 'closed') {
          counters.dropped += plan.rows.length
          return { written: 0, duplicates: 0, rejected }
        }
        const rows = plan.rows.map(r => r.row)
        try {
          const res = await withRecoveryRetry(() => insertTx.immediate(rows), recoveryPending, sleep)
          recoveryPending = false
          remember(res.fresh)
          counters.written += res.written
          counters.duplicates += res.duplicates
          // Only a write puts frames in the WAL; an all-duplicate batch commits nothing to copy.
          if (res.written > 0) armCheckpoint()
          return { written: res.written, duplicates: res.duplicates, rejected }
        } catch {
          // The transaction rolled back whole: nothing of this batch is in the table.
          recoveryPending = false
          counters.failedAppends++
          counters.dropped += rows.length
          return { written: 0, duplicates: 0, rejected }
        }
      },

      async readFrom(cursor, limit): Promise<ReadPage> {
        assertCursor(cursor)
        const n = clampLimit(limit)
        if (n === 0 || state === 'closed') return { events: [], cursor }
        try {
          const raw = pageStmt.all(cursor, n) as (StoredRow & { cursor_rowid: number })[]
          if (raw.length === 0) return { events: [], cursor }
          const events = raw.map(r => {
            const { cursor_rowid: _rowid, ...row } = r
            return rowToEvent(decodeRow(row as StoredRow, lookup))
          })
          return { events, cursor: Number(raw[raw.length - 1]!.cursor_rowid) }
        } catch {
          // A read that fails (an I/O error) is an empty page with the cursor unchanged — a poller
          // retries from the same place rather than skipping ahead — and is COUNTED, because the
          // page alone reads exactly like "nothing new".
          counters.failedReads++
          return { events: [], cursor }
        }
      },

      async stats(): Promise<JournalStats> {
        if (state === 'closed') return { rows: 0, bytes: 0 }
        type StatsRow = { n: number; first_at: number | null; last_at: number | null }
        let r: StatsRow | null
        try {
          r = statsStmt.get() as StatsRow | null
        } catch {
          counters.failedReads++
          r = null // reported as zero rows (and counted); bytes are still read off the disk
        }
        const out: JournalStats = {
          rows: Number(r?.n ?? 0),
          bytes: fileSize(path) + fileSize(`${path}-wal`),
        }
        if (typeof r?.first_at === 'number') out.firstAt = decodeInstant(r.first_at)
        if (typeof r?.last_at === 'number') out.lastAt = decodeInstant(r.last_at)
        return out
      },

      status(): JournalStatus {
        return { state, ...copyWhere(where), counters: { ...counters } }
      },

      close(): void {
        if (state === 'closed') return
        // A pending deferred checkpoint must not run against a closed handle: cancel it, then
        // checkpoint here, so what it would have copied is copied now. (The last connection to close
        // also checkpoints and removes the WAL; this covers the case where another is still open.)
        if (cancelCheckpoint !== null) {
          try { cancelCheckpoint() } catch { /* a timer that cannot be cleared finds state closed */ }
          cancelCheckpoint = null
        }
        checkpointNow()
        state = 'closed'
        try { db.close() } catch { /* already gone */ }
      },
    }
    return journal
  } catch {
    // Anything not foreseen above (a probe that throws, …) still yields a journal, never a throw.
    return disabledJournal(where, 'open-failed')
  }
}
