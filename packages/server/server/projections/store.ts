/**
 * projections/store.ts — where the materialised projections live (P3 §1 item 1, master spec §19.4):
 * each projection's fold STATE per key (so a catch-up pass resumes instead of re-reading history), its
 * finished OUTPUT rows (what `ProjectionReader` serves), and its `{version, cursor, adapterVersions}`.
 *
 * ## The storage decision: its OWN SQLite file beside the journal (`projections.db`), not tables in
 * ## `journal.db`
 *
 * Projections are DERIVED and the journal is not: deleting `projections.db` costs one rebuild and loses
 * nothing (P3 §7), so it is excluded from backups as `regenerable` in one row, while `journal.db` is
 * carried as the only surviving copy of its events — tables inside the journal would ride along in
 * every backup and could not be dropped without touching the file that must never lose a byte. And a
 * projection write is a BIG write (a page's worth of states and rows) that would otherwise contend for
 * the journal's single WAL write lock with the ingest path, whose append budget (§43, < 2 ms p95) was
 * measured on a file nothing else writes; a separate file means a rebuild can drop and recreate its
 * tables freely, run long transactions and checkpoint on its own clock without ever making an append
 * wait. The cost is one more file handle and no cross-file atomicity — which a projection does not
 * need, because its cursor and its rows commit in ONE transaction of THIS file, and the journal is only
 * ever read.
 *
 * ## The open discipline is the journal's, reused rather than copied
 *
 * `busy_timeout` BEFORE `journal_mode = WAL`, WAL read back (`configureConnection`); a network path
 * refused before anything is created (`classifyJournalPath`, `defaultPathProbe`); the first write after
 * recovering a killed WAL gets the bounded retry (`withRecoveryRetry`); `bun:sqlite` imported
 * dynamically so a non-Bun runtime reports `no-sqlite`. `openProjectionStore` NEVER throws: a store
 * that cannot open is `disabled` with a reason, and nothing downstream of it runs.
 *
 * ## Layout
 *
 * `projection_meta(id, version, cursor, adapter_versions, rebuilding, reason, updated_at)` · `store_info
 * (k, v)` · per projection `st_<id>(key, data)` (the encoded fold state, deflated) and `out_<id>(rid,
 * key, day, data)` (its finished rows, canonical JSON text). Per-projection TABLES rather than a projection column, so a rebuild is a
 * `DROP TABLE` + `CREATE`, not a DELETE over millions of rows. The file's layout version is
 * `user_version`; a file written by a NEWER build is refused untouched, an OLDER layout is dropped and
 * rebuilt — it is derived, so that is always safe.
 *
 * The path is `<data dir>/projections.db`, moved by `AGENTISTICS_JOURNAL_DIR` exactly like the journal
 * (it sits beside it, on the same filesystem the journal was allowed to open on). Both are literal
 * `join`s so `backup-coverage.lint.test.ts` sees the name.
 */
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { Database } from 'bun:sqlite'
import { featureOn } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR } from '../config'
import { withRecoveryRetry } from '../journal/journal'
import { JournalOpenError, classifyJournalPath, configureConnection, defaultPathProbe, type PathProbe } from '../journal/schema'
import type { JournalDisabledReason, PathKind } from '../journal/types'
import type { StoredMeta, StoredProjection } from './catalog'

export const PROJECTIONS_PATH = process.env.AGENTISTICS_JOURNAL_DIR
  ? join(process.env.AGENTISTICS_JOURNAL_DIR, 'projections.db')
  : join(AGENTISTICS_DATA_DIR, 'projections.db')

/**
 * `AGENTISTICS_PROJECTIONS` — **absent reads as OFF** (P3's flag rule, and `JOURNAL_ENABLED`'s): a
 * machine must not start writing a database because it was upgraded. Read per call, never cached, so
 * flipping it back is immediate (P3 §7).
 */
/** `AGENTISTICS_PROJECTIONS`: ON by default since the journal-backfill item; only an explicit negative turns it off. */
export function projectionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return featureOn('projections', env)
}

/** The store's own layout, in `PRAGMA user_version`. Bumping it drops and rebuilds everything. */
export const STORE_LAYOUT_VERSION = 1

/**
 * Fold states are stored DEFLATED. They are the bulk of the file (each carries its key's `seen` set of
 * event ids, and several projections embed a whole `SessionMetaState`), they are never queried — only
 * loaded by key — and they are JSON, which compresses several-fold. Level 1: the cost is paid on every
 * page of a rebuild, so speed wins over the last few percent. Output rows stay TEXT: they are what a
 * reader filters and parses, and a person with the sqlite3 shell can read them.
 */
const STATE_DEFLATE_LEVEL = 1

export type ProjectionStoreDisabledReason = JournalDisabledReason | 'flag-off'

/** One output row, as stored. */
export interface StoredOutput {
  rid: number
  key: string
  day: string
  data: string
}

/** The synchronous handle a catch-up page works through — valid only inside `store.transaction`. */
export interface StoreTx {
  meta(id: string): StoredMeta | undefined
  setCursor(id: string, cursor: number): void
  /** Encoded states for these keys; a key with no row is absent from the map. */
  loadStates(id: string, keys: readonly string[]): Map<string, string>
  saveState(id: string, key: string, data: string): void
  replaceOutputs(id: string, key: string, rows: readonly { day: string; data: string }[]): void
}

export interface ProjectionStore {
  readonly state: 'open' | 'disabled' | 'closed'
  readonly reason?: ProjectionStoreDisabledReason
  readonly path: string
  readonly pathKind: PathKind
  /** Every projection's stored meta, by id. Empty on a disabled store. */
  metas(): Map<string, StoredMeta>
  /** Drop and recreate one projection's tables and set its meta to a fresh rebuild at rowid 0. */
  resetProjection(id: string, version: number, adapterVersions: Record<string, string>, reason: string): Promise<void>
  /** One `BEGIN IMMEDIATE` transaction; rolled back whole if `fn` throws (and the error rethrown). */
  transaction<T>(fn: (tx: StoreTx) => T): Promise<T>
  /** The pass reached the journal's head: clear `rebuilding` on these projections, remember the head. */
  markCaughtUp(ids: readonly string[], head: number): Promise<void>
  info(k: string): string | null
  setInfo(k: string, v: string): Promise<void>
  /** Output rows of one projection with `day` in [from, to], rid-ordered, after `afterRid`, at most `limit`. */
  outputs(id: string, range: { from?: string; to?: string }, afterRid: number, limit: number): StoredOutput[]
  /** Every output row of one key. */
  outputsOf(id: string, key: string): StoredOutput[]
  close(): void
}

export interface OpenStoreOptions {
  path?: string
  probe?: PathProbe
  loadSqlite?: () => Promise<typeof import('bun:sqlite')>
  sleep?: (ms: number) => Promise<void>
  /** The projections whose tables must exist. Default: every id the caller later touches is created lazily. */
  projections?: readonly StoredProjection[]
  now?: () => string
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function fileSize(p: string): number {
  try { return statSync(p).size } catch { return 0 }
}

function disabledStore(path: string, pathKind: PathKind, reason: ProjectionStoreDisabledReason): ProjectionStore {
  const refuse = async () => { throw new Error(`projection store is disabled (${reason})`) }
  return {
    state: 'disabled', reason, path, pathKind,
    metas: () => new Map(),
    resetProjection: refuse,
    transaction: refuse,
    markCaughtUp: refuse,
    info: () => null,
    setInfo: refuse,
    outputs: () => [],
    outputsOf: () => [],
    close() { /* nothing is open */ },
  }
}

/** A disabled store that has touched NOTHING — what every entry point returns while the flag is off. */
export function flagOffStore(path = PROJECTIONS_PATH): ProjectionStore {
  return disabledStore(path, 'unknown', 'flag-off')
}

const BASE_DDL = [
  `CREATE TABLE IF NOT EXISTS projection_meta (
  id               TEXT PRIMARY KEY,
  version          INTEGER NOT NULL,
  cursor           INTEGER NOT NULL,
  adapter_versions TEXT NOT NULL,
  rebuilding       INTEGER NOT NULL,
  reason           TEXT,
  updated_at       TEXT NOT NULL
)`,
  'CREATE TABLE IF NOT EXISTS store_info (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
]

function assertId(id: string): string {
  if (!/^[a-z_]+$/.test(id)) throw new Error(`not a projection table id: ${id}`)
  return id
}

function projectionDdl(id: string): string[] {
  assertId(id)
  return [
    `CREATE TABLE IF NOT EXISTS st_${id} (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS out_${id} (rid INTEGER PRIMARY KEY, key TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS out_${id}_key ON out_${id}(key)`,
    `CREATE INDEX IF NOT EXISTS out_${id}_day ON out_${id}(day, rid)`,
  ]
}

/**
 * Bring the file to `STORE_LAYOUT_VERSION` inside BEGIN IMMEDIATE (two processes opening a fresh file
 * serialise). A newer layout is refused untouched; an older one is DROPPED — every table here is derived.
 */
function migrateStore(db: Database): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.query('PRAGMA user_version').get() as { user_version?: number } | null
    const current = typeof row?.user_version === 'number' ? row.user_version : 0
    if (current > STORE_LAYOUT_VERSION) {
      throw new JournalOpenError('db-schema-too-new', `projection store layout ${current} is newer than this build's ${STORE_LAYOUT_VERSION}`)
    }
    if (current !== STORE_LAYOUT_VERSION) {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
      for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t.name.replace(/"/g, '""')}"`)
      for (const sql of BASE_DDL) db.exec(sql)
      db.exec(`PRAGMA user_version = ${STORE_LAYOUT_VERSION}`)
    }
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* already ended */ }
    if (err instanceof JournalOpenError) throw err
    throw new JournalOpenError('migrate-failed', 'could not create or migrate the projection store', { cause: err })
  }
}

interface MetaRow { id: string; version: number; cursor: number; adapter_versions: string; rebuilding: number; reason: string | null }

function toMeta(r: MetaRow): StoredMeta {
  let adapterVersions: Record<string, string> = {}
  try {
    const v = JSON.parse(r.adapter_versions) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) adapterVersions = v as Record<string, string>
  } catch { /* an unreadable map compares unequal to any real one, which forces a rebuild: safe */ }
  return { id: r.id, version: Number(r.version), cursor: Number(r.cursor), adapterVersions, rebuilding: r.rebuilding === 1, reason: r.reason }
}

export async function openProjectionStore(opts: OpenStoreOptions = {}): Promise<ProjectionStore> {
  const path = opts.path ?? PROJECTIONS_PATH
  const sleep = opts.sleep ?? realSleep
  const now = opts.now ?? (() => new Date().toISOString())
  let pathKind: PathKind = 'unknown'
  try {
    const dir = dirname(path)
    const cls = classifyJournalPath(dir, opts.probe ?? defaultPathProbe())
    pathKind = cls.kind
    // Refused BEFORE the directory or any file exists: a refusal leaves nothing behind.
    if (cls.kind === 'network') return disabledStore(path, pathKind, 'network-filesystem')
    try { mkdirSync(dir, { recursive: true }) } catch { return disabledStore(path, pathKind, 'open-failed') }

    let recoveryPending = fileSize(`${path}-wal`) > 0
    let sqlite: typeof import('bun:sqlite')
    try {
      sqlite = await (opts.loadSqlite ?? (() => import('bun:sqlite')))()
      if (!sqlite || typeof sqlite.Database !== 'function') throw new Error('bun:sqlite has no Database')
    } catch {
      return disabledStore(path, pathKind, 'no-sqlite')
    }

    let db: Database
    try {
      db = new sqlite.Database(path, { create: true })
    } catch {
      return disabledStore(path, pathKind, 'open-failed')
    }
    try {
      configureConnection(db)
      migrateStore(db)
    } catch (e) {
      try { db.close() } catch { /* gone */ }
      return disabledStore(path, pathKind, e instanceof JournalOpenError ? e.reason : 'open-failed')
    }

    const ensured = new Set<string>()
    const ensure = (id: string): void => {
      if (ensured.has(id)) return
      for (const sql of projectionDdl(id)) db.exec(sql)
      ensured.add(id)
    }
    for (const p of opts.projections ?? []) ensure(p.id)

    const metaAll = db.query('SELECT id, version, cursor, adapter_versions, rebuilding, reason FROM projection_meta')
    const metaOne = db.query('SELECT id, version, cursor, adapter_versions, rebuilding, reason FROM projection_meta WHERE id = ?')
    const setCursorStmt = db.query('UPDATE projection_meta SET cursor = ?, updated_at = ? WHERE id = ?')
    const infoGet = db.query('SELECT v FROM store_info WHERE k = ?')
    const infoSet = db.query('INSERT INTO store_info (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    const stmts = new Map<string, {
      load: ReturnType<Database['query']>; save: ReturnType<Database['query']>
      delOut: ReturnType<Database['query']>; insOut: ReturnType<Database['query']>
      outRange: ReturnType<Database['query']>; outKey: ReturnType<Database['query']>
    }>()
    const stmtsOf = (id: string) => {
      let s = stmts.get(id)
      if (s) return s
      ensure(id)
      s = {
        load: db.query(`SELECT data FROM st_${id} WHERE key = ?`),
        save: db.query(`INSERT INTO st_${id} (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data`),
        delOut: db.query(`DELETE FROM out_${id} WHERE key = ?`),
        insOut: db.query(`INSERT INTO out_${id} (key, day, data) VALUES (?, ?, ?)`),
        outRange: db.query(`SELECT rid, key, day, data FROM out_${id} WHERE rid > ? AND day >= ? AND day <= ? ORDER BY rid LIMIT ?`),
        outKey: db.query(`SELECT rid, key, day, data FROM out_${id} WHERE key = ? ORDER BY rid`),
      }
      stmts.set(id, s)
      return s
    }

    let state: 'open' | 'closed' = 'open'
    const tx: StoreTx = {
      meta(id) {
        const r = metaOne.get(id) as MetaRow | null
        return r ? toMeta(r) : undefined
      },
      setCursor(id, cursor) { setCursorStmt.run(cursor, now(), id) },
      loadStates(id, keys) {
        const s = stmtsOf(assertId(id))
        const out = new Map<string, string>()
        for (const k of keys) {
          const r = s.load.get(k) as { data: Uint8Array } | null
          if (r) out.set(k, inflateRawSync(r.data).toString('utf8'))
        }
        return out
      },
      saveState(id, key, data) { stmtsOf(assertId(id)).save.run(key, deflateRawSync(Buffer.from(data, 'utf8'), { level: STATE_DEFLATE_LEVEL })) },
      replaceOutputs(id, key, rows) {
        const s = stmtsOf(assertId(id))
        s.delOut.run(key)
        for (const r of rows) s.insOut.run(key, r.day, r.data)
      },
    }

    const runTx = async <T>(fn: () => T): Promise<T> => {
      if (state === 'closed') throw new Error('projection store is closed')
      const wrapped = db.transaction(fn) as unknown as { immediate: () => T }
      const out = await withRecoveryRetry(() => wrapped.immediate(), recoveryPending, sleep)
      recoveryPending = false
      return out
    }

    const store: ProjectionStore = {
      get state() { return state },
      path,
      pathKind,
      metas() {
        const out = new Map<string, StoredMeta>()
        if (state === 'closed') return out
        for (const r of metaAll.all() as MetaRow[]) out.set(r.id, toMeta(r))
        return out
      },
      async resetProjection(id, version, adapterVersions, reason) {
        assertId(id)
        await runTx(() => {
          // A statement prepared on a dropped table is stale: forget it, recreate the tables.
          stmts.delete(id)
          ensured.delete(id)
          db.exec(`DROP TABLE IF EXISTS st_${id}`)
          db.exec(`DROP TABLE IF EXISTS out_${id}`)
          ensure(id)
          db.query(`INSERT INTO projection_meta (id, version, cursor, adapter_versions, rebuilding, reason, updated_at)
            VALUES (?, ?, 0, ?, 1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET version = excluded.version, cursor = 0, adapter_versions = excluded.adapter_versions,
              rebuilding = 1, reason = excluded.reason, updated_at = excluded.updated_at`)
            .run(id, version, JSON.stringify(adapterVersions), reason, now())
        })
      },
      transaction(fn) {
        return runTx(() => fn(tx))
      },
      async markCaughtUp(ids, head) {
        await runTx(() => {
          const q = db.query('UPDATE projection_meta SET rebuilding = 0, updated_at = ? WHERE id = ? AND rebuilding = 1')
          for (const id of ids) q.run(now(), id)
          infoSet.run('journal_head', String(head))
        })
      },
      info(k) {
        if (state === 'closed') return null
        const r = infoGet.get(k) as { v: string } | null
        return r ? r.v : null
      },
      async setInfo(k, v) {
        await runTx(() => { infoSet.run(k, v) })
      },
      outputs(id, range, afterRid, limit) {
        if (state === 'closed') return []
        const n = Math.max(0, Math.min(Math.floor(limit), 10_000))
        if (n === 0) return []
        return stmtsOf(assertId(id)).outRange.all(afterRid, range.from ?? '', range.to ?? '￿', n) as StoredOutput[]
      },
      outputsOf(id, key) {
        if (state === 'closed') return []
        return stmtsOf(assertId(id)).outKey.all(key) as StoredOutput[]
      },
      close() {
        if (state === 'closed') return
        state = 'closed'
        try { db.query('PRAGMA wal_checkpoint(PASSIVE)').get() } catch { /* the frames stay in the WAL */ }
        try { db.close() } catch { /* gone */ }
      },
    }
    return store
  } catch {
    return disabledStore(path, pathKind, 'open-failed')
  }
}

/** Whether a store file exists at `path` — for a status line that must not create one to ask. */
export function projectionStoreExists(path = PROJECTIONS_PATH): boolean {
  return existsSync(path)
}
