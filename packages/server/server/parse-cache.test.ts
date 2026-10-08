import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { openParseCache, NOOP_PARSE_CACHE, clearParseCacheMemo, type ParseCache } from './parse-cache'
import { cacheSlot, type FileStamp } from './parse-cache-key'

const dirs: string[] = []
async function tempDb(name = 'cache.db'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-parse-cache-'))
  dirs.push(dir)
  return join(dir, name)
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

const stamp = (over: Partial<FileStamp> = {}): FileStamp => ({
  path: '/transcripts/abc.jsonl',
  mtimeMs: 1_700_000_000_000,
  size: 100,
  ...over,
})

describe('openParseCache', () => {
  test('a miss returns null and is counted', async () => {
    const c = await openParseCache(await tempDb())
    expect(c.get('session', stamp())).toBeNull()
    expect(c.stats()).toEqual({ hits: 0, misses: 1, writes: 0 })
    c.close()
  })

  test('what was written is read back, structurally intact', async () => {
    const c = await openParseCache(await tempDb())
    const value = { session_id: 'abc', tokens: 42, tools: { Read: 3 }, langs: ['ts'] }
    c.set('session', stamp(), value)
    expect(c.get<typeof value>('session', stamp())).toEqual(value)
    expect(c.stats()).toEqual({ hits: 1, misses: 0, writes: 1 })
    c.close()
  })

  test('a changed file version misses', async () => {
    const c = await openParseCache(await tempDb())
    c.set('session', stamp(), { v: 1 })
    expect(c.get('session', stamp({ size: 101 }))).toBeNull()
    expect(c.get('session', stamp({ mtimeMs: 1_700_000_000_001 }))).toBeNull()
    c.close()
  })

  test('a new version REPLACES the old row rather than joining it', async () => {
    // A live transcript is appended to constantly. One row per slot is what stops
    // the database growing without bound over a machine's lifetime.
    const c = await openParseCache(await tempDb())
    c.set('session', stamp({ size: 100 }), { v: 1 })
    c.set('session', stamp({ size: 200 }), { v: 2 })
    c.set('session', stamp({ size: 300 }), { v: 3 })
    expect(c.rowCount()).toBe(1)
    expect(c.get<{ v: number }>('session', stamp({ size: 300 }))).toEqual({ v: 3 })
    expect(c.get<{ v: number }>('session', stamp({ size: 100 }))).toBeNull()
    c.close()
  })

  test('kind and variant do not share a row', async () => {
    const c = await openParseCache(await tempDb())
    c.set('session', stamp(), { which: 'session' })
    c.set('enrich', stamp(), { which: 'enrich' })
    c.set('enrich', stamp(), { which: 'enrich-opus' }, 'claude-opus-4-6')
    expect(c.get<{ which: string }>('session', stamp())).toEqual({ which: 'session' })
    expect(c.get<{ which: string }>('enrich', stamp())).toEqual({ which: 'enrich' })
    expect(c.get<{ which: string }>('enrich', stamp(), 'claude-opus-4-6')).toEqual({ which: 'enrich-opus' })
    expect(c.rowCount()).toBe(3)
    c.close()
  })

  test('rows survive a close and reopen', async () => {
    const file = await tempDb()
    const a = await openParseCache(file)
    a.set('session', stamp(), { v: 1 })
    a.flush()
    a.close()
    const b = await openParseCache(file)
    expect(b.get<{ v: number }>('session', stamp())).toEqual({ v: 1 })
    b.close()
  })

  test('a database that cannot be opened degrades to a no-op, never a throw', async () => {
    // An unwritable path is an ordinary outcome: a read-only container, a full disk,
    // a home directory the process does not own. The build must still complete.
    // A path whose PARENT is a regular file fails with ENOTDIR on every platform —
    // deterministic, unlike relying on /proc permissions.
    const dir = await mkdtemp(join(tmpdir(), 'agentistics-parse-cache-'))
    dirs.push(dir)
    const blocker = join(dir, 'not-a-dir')
    await writeFile(blocker, 'x')

    const c = await openParseCache(join(blocker, 'cache.db'))
    expect(c.get('session', stamp())).toBeNull()
    expect(() => c.set('session', stamp(), { v: 1 })).not.toThrow()
    expect(c.get('session', stamp())).toBeNull()
    expect(c.rowCount()).toBe(0)
    expect(() => c.close()).not.toThrow()
  })

  test('a pre-existing table with the wrong columns degrades to a no-op, never a throw', async () => {
    // `CREATE TABLE IF NOT EXISTS` only matches on the table NAME, never the columns —
    // a `parse_cache` table left over with a different shape (schema drift, an older
    // on-disk schema, a partially corrupt file) sails through db.exec(SCHEMA) and only
    // fails once a prepared statement referencing a missing column is compiled.
    //
    // The `used` column has to be PRESENT (so `CREATE INDEX IF NOT EXISTS
    // parse_cache_used ON parse_cache(used)` inside the already-guarded db.exec(SCHEMA)
    // succeeds as a no-op), with `key`/`value` MISSING — that is what pushes the
    // failure past exec(SCHEMA) and into the five unguarded `db.query(...)` calls that
    // follow it, reproducing the reviewer's exact error: "table parse_cache has no
    // column named used" style failure at prepare time, not at exec(SCHEMA) time.
    const file = await tempDb()
    const { Database } = await import('bun:sqlite')
    const raw = new Database(file, { create: true })
    raw.exec('CREATE TABLE parse_cache (slot TEXT PRIMARY KEY, used INTEGER NOT NULL)')
    raw.close()

    const c = await openParseCache(file)
    expect(c.get('session', stamp())).toBeNull()
    expect(() => c.set('session', stamp(), { v: 1 })).not.toThrow()
    expect(() => c.close()).not.toThrow()
  })

  test('gc drops rows untouched since the cutoff and keeps the rest', async () => {
    // The clock is INJECTED: with Date.now() both writes land in the same millisecond
    // on a fast machine, so any cutoff either keeps both rows or drops both, and the
    // test passes or fails by timing rather than by behaviour.
    let clock = 1_000_000
    const c = await openParseCache(await tempDb(), () => clock)

    c.set('session', stamp({ path: '/gone.jsonl' }), { v: 1 })
    c.flush()

    // A later build reads /live.jsonl and never sees /gone.jsonl again.
    clock += 10_000
    c.set('session', stamp({ path: '/live.jsonl' }), { v: 2 })
    c.get<{ v: number }>('session', stamp({ path: '/live.jsonl' }))
    c.flush()

    expect(c.gc(clock - 5_000)).toBe(1)
    expect(c.get<{ v: number }>('session', stamp({ path: '/live.jsonl' }))).toEqual({ v: 2 })
    expect(c.get<{ v: number }>('session', stamp({ path: '/gone.jsonl' }))).toBeNull()
    c.close()
  })

  test('flush keeps a row that is always hit and never rewritten', async () => {
    // Without the batched touch, a transcript that never changes ages out on `used`
    // and is reparsed — the exact file the cache exists to stop reparsing. The touch is
    // at most daily (PERF.1: rewriting every row on every build cost ~50 ms a build), so
    // the clock moves in days here; production gc's cutoff is 30 of them.
    const DAY = 24 * 60 * 60 * 1000
    let clock = 1_000_000
    const c = await openParseCache(await tempDb(), () => clock)
    c.set('session', stamp(), { v: 1 })
    c.flush()

    clock += 2 * DAY
    expect(c.get<{ v: number }>('session', stamp())).toEqual({ v: 1 })
    c.flush()

    expect(c.gc(clock - DAY)).toBe(0)
    expect(c.get<{ v: number }>('session', stamp())).toEqual({ v: 1 })
    c.close()
  })

  test('a Windows path survives the round trip through SQLite', async () => {
    // The slot is the PRIMARY KEY, so whatever the driver does to the string on the
    // way in is what identity means. Backslashes, a drive letter and a space are the
    // three things a naive encoding mangles, and this repo ships an agentop.exe.
    const c = await openParseCache(await tempDb())
    const win = stamp({ path: 'C:\\Users\\Ana Paula\\.claude\\projects\\p\\s.jsonl' })
    c.set('session', win, { v: 'win' })
    expect(c.get<{ v: string }>('session', win)).toEqual({ v: 'win' })
    expect(c.get<{ v: string }>('session', stamp({ path: 'C:\\Users\\Ana' }))).toBeNull()
    expect(c.rowCount()).toBe(1)
    c.close()
  })

  test('a corrupt value is a miss, not a crash', async () => {
    // The blob is JSON written by an older build. A shape change or a truncated
    // write must degrade to "recompute it", exactly like an absent row.
    //
    // The bad blob is planted through a SEPARATE connection rather than through a
    // test-only method on ParseCache: production code must not carry an affordance
    // only tests use, and this row is exactly what a half-finished write would leave.
    const file = await tempDb()
    const c = await openParseCache(file)
    c.set('session', stamp(), { v: 1 })
    c.flush()

    const { Database } = await import('bun:sqlite')
    const raw = new Database(file)
    raw.query('UPDATE parse_cache SET value = ? WHERE slot = ?')
      .run('{not json', cacheSlot('session', stamp().path))
    raw.close()

    // A fresh process: the in-memory copy (which is still right — it was derived from the
    // file, not from this blob) is not what this test is about.
    clearParseCacheMemo()
    expect(c.get<{ v: number }>('session', stamp())).toBeNull()
    c.close()
  })
  test('a row read again within a day is answered from memory and not rewritten', async () => {
    // PERF.1: a warm build was 1200 SELECTs + JSON.parses + 1200 UPDATEs of `used`.
    const file = await tempDb()
    let clock = 1_000_000
    const c = await openParseCache(file, () => clock)
    c.set('session', stamp(), { v: 1 })
    clock += 60_000
    const got = c.get<{ v: number }>('session', stamp())!
    expect(got).toEqual({ v: 1 })
    got.v = 99 // a caller stamping a field must not reach the next reader
    c.flush()
    expect(c.get<{ v: number }>('session', stamp())).toEqual({ v: 1 })
    const { Database } = await import('bun:sqlite')
    const raw = new Database(file)
    expect((raw.query('SELECT used FROM parse_cache').get() as { used: number }).used).toBe(1_000_000)
    raw.close()
    c.close()
  })
})

describe('NOOP_PARSE_CACHE', () => {
  test('never stores and never throws', () => {
    const c: ParseCache = NOOP_PARSE_CACHE
    c.set('session', stamp(), { v: 1 })
    expect(c.get('session', stamp())).toBeNull()
    expect(() => { c.flush(); c.close() }).not.toThrow()
  })

})
