import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import { PARSE_CACHE_FILE } from './config'
import { cacheKey, cacheSlot, type FileStamp, type ParseCacheKind } from './parse-cache-key'

export interface ParseCacheStats {
  hits: number
  misses: number
  writes: number
}

export interface ParseCache {
  /** The cached derivation of THIS version of the file, or null to recompute. */
  get<T>(kind: ParseCacheKind, stamp: FileStamp, variant?: string): T | null
  /** Store a derivation, replacing any earlier version of the same slot. */
  set(kind: ParseCacheKind, stamp: FileStamp, value: unknown, variant?: string): void
  /** Mark every slot READ this build as live, in one statement. Call once per build,
   *  before gc — without it, a row that is always hit and never rewritten ages out. */
  flush(): void
  /** Drop rows untouched since `cutoffMs`. Returns how many were dropped. */
  gc(cutoffMs: number): number
  stats(): ParseCacheStats
  /** Row count — used by gc() to report what it dropped, and by diagnostics. */
  rowCount(): number
  close(): void
}

/** The cache that is not there. Returned whenever the database cannot be opened, and
 *  used by callers that deliberately bypass it. Every method is a safe nothing. */
export const NOOP_PARSE_CACHE: ParseCache = {
  get: () => null,
  set: () => {},
  flush: () => {},
  gc: () => 0,
  stats: () => ({ hits: 0, misses: 0, writes: 0 }),
  rowCount: () => 0,
  close: () => {},
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parse_cache (
  slot  TEXT PRIMARY KEY,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  used  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS parse_cache_used ON parse_cache(used);
`

/**
 * Open the parse cache, creating it if needed.
 *
 * EVERY failure path returns NOOP_PARSE_CACHE rather than throwing: an unwritable
 * home directory, a read-only container, a corrupt database and a non-Bun runtime are
 * all ordinary outcomes here, and none of them may stop a build. The cost of the
 * fallback is exactly the time this cache was meant to save — never a wrong number,
 * because every value in it is recomputable from the file it names.
 */
/**
 * PERF.1 step 1 — what every build paid for a cache that was all hits. A warm rebuild over 1200
 * transcripts did 1200 SELECTs and JSON.parsed 1200 blobs (~60 ms), then rewrote `used` on all 1200
 * rows in a transaction (~50 ms) — to learn nothing, because nothing had changed.
 *
 * - A row read or written is REMEMBERED in this process, under the same (slot, key) the table uses,
 *   so a later build answers from memory. A hit hands out a shallow COPY: callers assign top-level
 *   fields onto what they get (project path, git remote, labels) and nothing assigns into a nested
 *   one. The memo is per database file and bounded (`MEMO_CAP`, least-recently-used first).
 * - `used` is only an age for `gc()` (30 days), so a row is touched when its stamp is older than
 *   `TOUCH_AFTER_MS`, not on every read. A row hit daily still never ages out.
 */
const MEMO_CAP = 50_000
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000
const MEMOS = new Map<string, Map<string, { key: string; value: unknown; used: number }>>()

function shallowCopy<T>(v: T): T {
  if (Array.isArray(v)) return v.slice() as T
  if (v !== null && typeof v === 'object') return { ...(v as object) } as T
  return v
}

/** For tests: forget what every parse cache remembers in memory. */
export function clearParseCacheMemo(): void { for (const m of MEMOS.values()) m.clear() }

export async function openParseCache(
  file: string = PARSE_CACHE_FILE,
  /** Injected so gc/flush behaviour is testable without sleeping. Production passes none. */
  now: () => number = Date.now,
): Promise<ParseCache> {
  let db: any
  let selectStmt: any
  let upsertStmt: any
  let touchStmt: any
  let countStmt: any
  let gcStmt: any
  try {
    await mkdir(dirname(file), { recursive: true })
    // Dynamic import so a non-Bun runtime degrades instead of crashing at import time
    // (same guard as adapters/antigravity.ts).
    const { Database } = await import('bun:sqlite')
    db = new Database(file, { create: true })
    // WAL: the server and the otel-watcher are separate processes over one file, and
    // a reader must not block behind a writer holding the whole database.
    db.exec('PRAGMA journal_mode = WAL')
    // NORMAL is the right durability for derived state — a row lost to a power cut is
    // one file reparsed, and FULL would fsync on every transcript we cache.
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(SCHEMA)

    // Prepared here, inside the same guard: `db.query()` COMPILES the statement
    // immediately, so a schema that doesn't match what we expect (a pre-existing
    // `parse_cache` table with different columns — `CREATE TABLE IF NOT EXISTS` only
    // matches on the table NAME, never the columns) throws right here, not later
    // unguarded. Falling into the catch below is exactly the degrade this cache promises.
    selectStmt = db.query('SELECT key, value, used FROM parse_cache WHERE slot = ?')
    upsertStmt = db.query(
      'INSERT INTO parse_cache (slot, key, value, used) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(slot) DO UPDATE SET key = excluded.key, value = excluded.value, used = excluded.used'
    )
    touchStmt = db.query('UPDATE parse_cache SET used = ? WHERE slot = ?')
    countStmt = db.query('SELECT COUNT(*) AS n FROM parse_cache')
    gcStmt = db.query('DELETE FROM parse_cache WHERE used < ?')
  } catch {
    try { db?.close() } catch { /* already gone */ }
    return NOOP_PARSE_CACHE
  }

  const stats: ParseCacheStats = { hits: 0, misses: 0, writes: 0 }
  // Slots READ this build. Touched in one transaction by flush() so a row that is
  // always hit and never rewritten does not age out under gc().
  const readSlots = new Set<string>()
  let memo = MEMOS.get(file)
  if (!memo) { memo = new Map(); MEMOS.set(file, memo) }
  const remember = (slot: string, entry: { key: string; value: unknown; used: number }) => {
    memo!.delete(slot)
    memo!.set(slot, entry)
    while (memo!.size > MEMO_CAP) memo!.delete(memo!.keys().next().value as string)
  }
  const touchIfOld = (slot: string, entry: { used: number }) => {
    const at = now()
    if (at - entry.used >= TOUCH_AFTER_MS) { readSlots.add(slot); entry.used = at }
  }

  const store: ParseCache = {
    get<T>(kind: ParseCacheKind, stamp: FileStamp, variant = ''): T | null {
      const slot = cacheSlot(kind, stamp.path, variant)
      const key = cacheKey(stamp)
      const mem = memo!.get(slot)
      if (mem && mem.key === key) {
        memo!.delete(slot); memo!.set(slot, mem)
        touchIfOld(slot, mem)
        stats.hits++
        return shallowCopy(mem.value) as T
      }
      try {
        const row = selectStmt.get(slot) as { key: string; value: string; used: number } | null
        if (!row || row.key !== key) { stats.misses++; return null }
        // A blob written by an older build may no longer parse or may no longer hold
        // the shape the caller expects. Both are a miss — recompute, never crash.
        const parsed = JSON.parse(row.value) as T
        const entry = { key, value: parsed as unknown, used: Number(row.used) || 0 }
        touchIfOld(slot, entry)
        remember(slot, entry)
        stats.hits++
        return shallowCopy(parsed)
      } catch {
        stats.misses++
        return null
      }
    },

    set(kind: ParseCacheKind, stamp: FileStamp, value: unknown, variant = ''): void {
      try {
        const slot = cacheSlot(kind, stamp.path, variant)
        const text = JSON.stringify(value)
        const at = now()
        upsertStmt.run(slot, cacheKey(stamp), text, at)
        // Remembered as the table will give it back (a JSON round trip), never the caller's object.
        remember(slot, { key: cacheKey(stamp), value: JSON.parse(text), used: at })
        stats.writes++
      } catch { /* a cache that cannot store is still a correct cache */ }
    },

    flush(): void {
      if (readSlots.size === 0) return
      try {
        const at = now()
        const slots = [...readSlots]
        readSlots.clear()
        db.transaction(() => { for (const s of slots) touchStmt.run(at, s) })()
      } catch { /* the touch is an optimisation; losing it costs one reparse */ }
    },

    gc(cutoffMs: number): number {
      // Counted by difference rather than read off `run().changes`: the shape of that
      // return has moved between bun:sqlite versions, and a gc that silently reports 0
      // is indistinguishable from one that is not running at all.
      try {
        const before = store.rowCount()
        gcStmt.run(cutoffMs)
        // What the table forgot, the memo forgets: a dropped row must miss here too.
        for (const [slot, e] of memo!) if (e.used < cutoffMs) memo!.delete(slot)
        return before - store.rowCount()
      } catch { return 0 }
    },

    stats: () => ({ ...stats }),

    rowCount(): number {
      try { return Number((countStmt.get() as { n: number } | null)?.n ?? 0) } catch { return 0 }
    },

    close(): void {
      try { store.flush(); db.close() } catch { /* already gone */ }
    },
  }

  return store
}
