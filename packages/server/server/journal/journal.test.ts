/**
 * journal.test.ts — the connection half of the journal, against REAL bun:sqlite files on disk.
 *
 * Nothing is mocked but the filesystem CLASSIFICATION (a fake `PathProbe`, so a test can claim a
 * directory is 9p without mounting one) and, in two places, the SQLite loader and the sleep.
 * Crash recovery is exercised by child processes that SIGKILL themselves — the only honest way to
 * leave a WAL behind that no connection checkpointed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { isBusyError, openJournal, withRecoveryRetry } from './journal'
import type { PathProbe } from './schema'
import { MAX_PAGE, type Journal } from './types'

let root = ''
let seq = 0
const fresh = (name = 'j') => join(root, `${name}-${++seq}`, 'journal.db')

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-journal-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

/** A probe that says every path is on a local ext4 root. */
function localProbe(mountinfo = '58 42 8:32 / / rw,relatime - ext4 /dev/sdc rw'): PathProbe {
  return {
    platform: 'linux',
    realpath: p => p,
    readMountinfo: () => mountinfo,
    readDarwinMounts: () => null,
  }
}

function ev(id: string, i = 0, over: Partial<AgentisticsEvent> = {}): AgentisticsEvent {
  const t = new Date(Date.UTC(2026, 8, 25, 10, 0, 0, i % 1000) + i * 1000).toISOString()
  return {
    eventId: id,
    schema: 1,
    type: 'session.started',
    occurredAt: t,
    recordedAt: t,
    sessionId: `s-${i % 7}`,
    source: { kind: 'harness', id: 'claude', version: '2.1.0' },
    provenance: { mode: 'replayed', confidence: 'exact', adapterVersion: 'claude@1', sourceRef: `f:${i}` },
    data: { origin: 'harness', title: `t${i}` } as unknown as AgentisticsEvent['data'],
    ...over,
  }
}

const ids = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, k) => `${prefix}${from + k}`)

async function open(path = fresh()): Promise<Journal> {
  return openJournal({ path, probe: localProbe() })
}

describe('append', () => {
  test('writes, then counts the same batch as duplicates, and a within-batch repeat once', async () => {
    const j = await open()
    const batch = ids('a', 0, 50).map((id, i) => ev(id, i))
    expect(await j.append(batch)).toEqual({ written: 50, duplicates: 0, rejected: [] })
    expect(await j.append(batch)).toEqual({ written: 0, duplicates: 50, rejected: [] })
    const twice = await j.append([ev('b1', 1), ev('b1', 2)])
    expect(twice).toEqual({ written: 1, duplicates: 1, rejected: [] })
    expect((await j.stats()).rows).toBe(51)
    expect(j.status().counters).toEqual({ written: 51, duplicates: 51, rejected: 0, dropped: 0, failedAppends: 0, failedReads: 0 })
    j.close()
  })

  test('a mixed batch names each rejection by index and writes the rest', async () => {
    const j = await open()
    const batch = [
      ev('ok1', 1),
      ev('', 2),
      ev('ok2', 3),
      ev('bad-ts', 4, { occurredAt: '2026-09-25T10:00:00' }),
      ev('bad-type', 5, { type: 'nope' as AgentisticsEvent['type'] }),
      ev('ok3', 6),
    ]
    const res = await j.append(batch)
    expect(res.written).toBe(3)
    expect(res.duplicates).toBe(0)
    expect(res.rejected).toEqual([
      { index: 1, reason: 'missing-event-id' },
      { index: 3, eventId: 'bad-ts', reason: 'bad-timestamp' },
      { index: 4, eventId: 'bad-type', reason: 'unknown-type' },
    ])
    expect(j.status().counters).toMatchObject({ written: 3, rejected: 3, dropped: 0 })
    // An all-rejected batch opens no transaction and writes nothing.
    expect(await j.append([ev('', 0)])).toEqual({ written: 0, duplicates: 0, rejected: [{ index: 0, reason: 'missing-event-id' }] })
    expect(await j.append([])).toEqual({ written: 0, duplicates: 0, rejected: [] })
    expect((await j.stats()).rows).toBe(3)
    j.close()
  })

  test('after close, append drops and never throws', async () => {
    const j = await open()
    j.close()
    j.close() // idempotent
    expect(await j.append([ev('x', 1)])).toEqual({ written: 0, duplicates: 0, rejected: [] })
    expect(j.status()).toMatchObject({ state: 'closed', counters: { dropped: 1 } })
  })
})

describe('readFrom', () => {
  test('pages 2500 events in insertion order, clamps and refuses bad cursors', async () => {
    const path = fresh()
    const j = await openJournal({ path, probe: localProbe() })
    const all = ids('p', 0, 2500).map((id, i) => ev(id, i))
    for (let k = 0; k < all.length; k += 250) await j.append(all.slice(k, k + 250))

    const seen: string[] = []
    let cursor = 0
    const sizes: number[] = []
    for (let n = 0; n < 3; n++) {
      const page = await j.readFrom(cursor, 1000)
      expect(page.cursor).toBeGreaterThan(cursor)
      cursor = page.cursor
      sizes.push(page.events.length)
      seen.push(...page.events.map(e => e.eventId))
    }
    expect(sizes).toEqual([1000, 1000, 500])
    expect(seen).toEqual(all.map(e => e.eventId))
    const tail = await j.readFrom(cursor, 1000)
    expect(tail).toEqual({ events: [], cursor })

    expect((await j.readFrom(0, 5000)).events.length).toBe(MAX_PAGE)
    expect((await j.readFrom(0, 0))).toEqual({ events: [], cursor: 0 })
    expect((await j.readFrom(0, Number.NaN))).toEqual({ events: [], cursor: 0 })
    expect((await j.readFrom(0, 2.9)).events.length).toBe(2)
    await expect(j.readFrom(-1, 10)).rejects.toThrow(RangeError)
    await expect(j.readFrom(1.5, 10)).rejects.toThrow(RangeError)

    // Round trip: what comes back is what went in (fixtures use normalised Z-ms timestamps).
    const first = (await j.readFrom(0, 1)).events[0]
    expect(first).toEqual(all[0]!)

    const s = await j.stats()
    expect(s.rows).toBe(2500)
    expect(s.firstAt).toBe(all[0]!.occurredAt)
    expect(s.lastAt).toBe(all[2499]!.occurredAt)
    expect(s.bytes).toBeGreaterThan(0)
    j.close()
  })

  test('an empty journal has no firstAt/lastAt', async () => {
    const j = await open()
    const s = await j.stats()
    expect(s.rows).toBe(0)
    expect('firstAt' in s).toBe(false)
    expect('lastAt' in s).toBe(false)
    j.close()
  })
})

describe('degrading to a no-op', () => {
  test('a network filesystem is refused before anything is created', async () => {
    const netRoot = join(root, `net-${++seq}`)
    const path = join(netRoot, 'sub', 'journal.db')
    const probe = localProbe([
      '58 42 8:32 / / rw,relatime - ext4 /dev/sdc rw',
      `76 58 0:48 / ${netRoot} rw,noatime - 9p C:\\134 rw`,
    ].join('\n'))
    const j = await openJournal({ path, probe })
    const st = j.status()
    expect(st).toMatchObject({ state: 'disabled', reason: 'network-filesystem', pathKind: 'network', fsType: '9p' })
    expect(existsSync(netRoot)).toBe(false)
    expect(existsSync(path)).toBe(false)
    // A disabled journal still reports producer bugs, and counts what it could not keep.
    const res = await j.append([ev('n1', 1), ev('', 2)])
    expect(res).toEqual({ written: 0, duplicates: 0, rejected: [{ index: 1, reason: 'missing-event-id' }] })
    expect(j.status().counters).toMatchObject({ dropped: 1, rejected: 1, written: 0 })
    expect(await j.readFrom(7, 10)).toEqual({ events: [], cursor: 7 })
    expect(await j.stats()).toEqual({ rows: 0, bytes: 0 })
  })

  test('an unreadable mount table is unknown, and unknown OPENS', async () => {
    const probe: PathProbe = { ...localProbe(), readMountinfo: () => null }
    const j = await openJournal({ path: fresh(), probe })
    expect(j.status()).toMatchObject({ state: 'open', pathKind: 'unknown' })
    expect((await j.append([ev('u1', 1)])).written).toBe(1)
    j.close()
  })

  test('no bun:sqlite → disabled no-sqlite, never throws', async () => {
    const j = await openJournal({
      path: fresh(), probe: localProbe(),
      loadSqlite: () => Promise.reject(new Error('Cannot find module bun:sqlite')),
    })
    expect(j.status()).toMatchObject({ state: 'disabled', reason: 'no-sqlite', pathKind: 'local' })
    const res = await j.append([ev('x1', 1), ev('x2', 2, { schema: 99 })])
    expect(res.rejected).toEqual([{ index: 1, eventId: 'x2', reason: 'schema-too-new' }])
    expect(j.status().counters.dropped).toBe(1)
  })

  test('a file from a newer agentop is refused and left byte-identical', async () => {
    const path = fresh()
    const dir = join(path, '..')
    require('node:fs').mkdirSync(dir, { recursive: true })
    const raw = new Database(path, { create: true })
    raw.exec('PRAGMA journal_mode = WAL') // already WAL, so opening cannot legitimately rewrite the header
    raw.exec('CREATE TABLE future (x)')
    raw.exec('PRAGMA user_version = 99')
    raw.close()
    const before = readFileSync(path)
    const j = await openJournal({ path, probe: localProbe() })
    expect(j.status()).toMatchObject({ state: 'disabled', reason: 'db-schema-too-new' })
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  test('a directory that cannot be created → open-failed', async () => {
    const file = join(root, `plainfile-${++seq}`)
    writeFileSync(file, 'x')
    const j = await openJournal({ path: join(file, 'sub', 'journal.db'), probe: localProbe() })
    expect(j.status()).toMatchObject({ state: 'disabled', reason: 'open-failed' })
  })

  test('status() is a copy', async () => {
    const j = await open()
    const s = j.status()
    s.counters.written = 999
    s.state = 'disabled'
    expect(j.status()).toMatchObject({ state: 'open', counters: { written: 0 } })
    j.close()
  })
})

describe('contention', () => {
  test('a write lock held by another PROCESS makes append wait, not fail', async () => {
    const path = fresh()
    const j = await openJournal({ path, probe: localProbe() })
    const child = Bun.spawn([process.execPath, '-e', `
      const { Database } = require('bun:sqlite')
      const db = new Database(${JSON.stringify(path)})
      db.exec('PRAGMA busy_timeout = 10000'); db.exec('PRAGMA journal_mode = WAL')
      db.exec('BEGIN IMMEDIATE')
      console.log('locked')
      Bun.sleepSync(400)
      db.exec('COMMIT'); db.close()
    `], { stdout: 'pipe', stderr: 'inherit' })
    const reader = child.stdout.getReader()
    let out = ''
    while (!out.includes('locked')) {
      const { value, done } = await reader.read()
      if (done) break
      out += new TextDecoder().decode(value)
    }
    expect(out).toContain('locked')
    const t0 = performance.now()
    const res = await j.append([ev('c1', 1), ev('c2', 2)])
    const waited = performance.now() - t0
    expect(res).toEqual({ written: 2, duplicates: 0, rejected: [] })
    expect(waited).toBeGreaterThan(100)
    expect(j.status().counters.failedAppends).toBe(0)
    await child.exited
    j.close()
  })

  test('two connections interleaving overlapping batches converge on distinct ids', async () => {
    const path = fresh()
    const a = await openJournal({ path, probe: localProbe() })
    const b = await openJournal({ path, probe: localProbe() })
    const aIds = ids('k', 0, 600)
    const bIds = ids('k', 400, 1000)
    const ops: Promise<{ written: number; duplicates: number }>[] = []
    for (let k = 0; k < 600; k += 100) {
      ops.push(a.append(aIds.slice(k, k + 100).map((id, i) => ev(id, k + i))))
      ops.push(b.append(bIds.slice(k, k + 100).map((id, i) => ev(id, k + i))))
    }
    const results = await Promise.all(ops)
    const written = results.reduce((n, r) => n + r.written, 0)
    const duplicates = results.reduce((n, r) => n + r.duplicates, 0)
    expect(written).toBe(1000)
    expect(duplicates).toBe(200)
    expect((await a.stats()).rows).toBe(1000)
    a.close()
    b.close()
  })
})

describe('isBusyError — by code, never by message', () => {
  test.each([
    [{ code: 'SQLITE_BUSY' }, true],
    [{ code: 'SQLITE_BUSY_RECOVERY' }, true],
    [{ code: 'SQLITE_BUSY_SNAPSHOT' }, true],
    [{ errno: 261 }, true],
    [{ errno: 5 }, true],
    [{ code: 'SQLITE_CONSTRAINT_UNIQUE', errno: 2067 }, false],
    [new Error('database is locked'), false],
    [null, false],
    ['SQLITE_BUSY', false],
  ])('%p → %p', (e, expected) => {
    expect(isBusyError(e)).toBe(expected)
  })
})

describe('withRecoveryRetry', () => {
  const busy = () => Object.assign(new Error('x'), { code: 'SQLITE_BUSY' })

  test('pending: retries busy errors ~50ms apart and succeeds', async () => {
    let calls = 0
    const sleeps: number[] = []
    const out = await withRecoveryRetry(() => {
      if (++calls < 3) throw busy()
      return 'ok'
    }, true, async ms => { sleeps.push(ms) })
    expect(out).toBe('ok')
    expect(calls).toBe(3)
    expect(sleeps).toEqual([50, 50])
  })

  test('not pending: the first busy error throws', async () => {
    let calls = 0
    await expect(withRecoveryRetry(() => { calls++; throw busy() }, false, async () => {})).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
    expect(calls).toBe(1)
  })

  test('a non-busy error is never retried', async () => {
    let calls = 0
    const sleeps: number[] = []
    await expect(withRecoveryRetry(() => {
      calls++
      throw Object.assign(new Error('u'), { code: 'SQLITE_CONSTRAINT_UNIQUE', errno: 2067 })
    }, true, async ms => { sleeps.push(ms) })).rejects.toMatchObject({ errno: 2067 })
    expect(calls).toBe(1)
    expect(sleeps).toEqual([])
  })

  test('five busy errors in a row: gives up after five attempts', async () => {
    let calls = 0
    const sleeps: number[] = []
    await expect(withRecoveryRetry(() => { calls++; throw busy() }, true, async ms => { sleeps.push(ms) })).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
    expect(calls).toBe(5)
    expect(sleeps.length).toBe(4)
  })
})

describe('crash recovery', () => {
  /** A child that opens with the journal's pragmas, never checkpoints, and SIGKILLs itself. */
  function childScript(path: string, mode: 'commit' | 'uncommitted', prefix: string, n: number): string {
    return `
      const { Database } = require('bun:sqlite')
      const db = new Database(${JSON.stringify(path)})
      db.exec('PRAGMA busy_timeout = 10000'); db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL'); db.exec('PRAGMA wal_autocheckpoint = 0')
      const ins = db.prepare("INSERT INTO events (event_id, schema, type, occurred_at, recorded_at, source_kind, source_id, mode, confidence, adapter_version, data) VALUES (?, 1, 'session.started', '2026-09-25T10:00:00.000Z', '2026-09-25T10:00:00.000Z', 'harness', 'claude', 'replayed', 'exact', 'claude@1', '{}')")
      if (${JSON.stringify(mode)} === 'commit') {
        db.transaction(() => { for (let i = 0; i < ${n}; i++) ins.run(${JSON.stringify(prefix)} + i) })()
      } else {
        db.exec('BEGIN IMMEDIATE')
        for (let i = 0; i < ${n}; i++) ins.run(${JSON.stringify(prefix)} + i)
      }
      process.kill(process.pid, 'SIGKILL')
    `
  }

  async function runChild(script: string): Promise<number | null> {
    const p = Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'inherit' })
    await p.exited
    return p.signalCode === 'SIGKILL' ? 9 : p.exitCode
  }

  test('a SIGKILLed writer leaves a WAL; reopening recovers it clean and the next append succeeds', async () => {
    const path = fresh('crash')
    const j0 = await openJournal({ path, probe: localProbe() })
    expect((await j0.append([ev('pre1', 1), ev('pre2', 2)])).written).toBe(2)
    j0.close()

    expect(await runChild(childScript(path, 'commit', 'committed-', 300))).toBe(9)
    expect(await runChild(childScript(path, 'uncommitted', 'lost-', 20000))).toBe(9)
    expect(existsSync(`${path}-wal`)).toBe(true)
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0)

    const j = await openJournal({ path, probe: localProbe() })
    expect(j.status().state).toBe('open')
    const res = await j.append([ev('post1', 1), ev('committed-0', 2)])
    expect(res).toEqual({ written: 1, duplicates: 1, rejected: [] })
    expect(j.status().counters.failedAppends).toBe(0)

    const got: string[] = []
    let cursor = 0
    for (;;) {
      const page = await j.readFrom(cursor, MAX_PAGE)
      if (page.events.length === 0) break
      got.push(...page.events.map(e => e.eventId))
      cursor = page.cursor
    }
    expect(got.length).toBe(2 + 300 + 1)
    expect(got.filter(id => id.startsWith('committed-')).length).toBe(300)
    expect(got.some(id => id.startsWith('lost-'))).toBe(false)
    j.close()

    const check = new Database(path, { readonly: true })
    expect((check.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    check.close()
  }, 30_000)
})

describe('failures are counted, never silent', () => {
  test('a read or stats that fails inside SQLite answers empty AND counts failedReads', async () => {
    const path = fresh()
    const j = await open(path)
    await j.append([ev('r1', 1), ev('r2', 2)])
    // Pull the table out from under the open journal: its prepared statements now fail.
    const other = new Database(path)
    other.exec('DROP TABLE events')
    other.close()
    expect(await j.readFrom(0, 10)).toEqual({ events: [], cursor: 0 })
    expect((await j.stats()).rows).toBe(0)
    expect(j.status().counters.failedReads).toBe(2)
    j.close()
  })

  test('a planner defect drops the whole batch and COUNTS it as dropped', async () => {
    const j = await open()
    const bad = ev('p1', 1)
    Object.defineProperty(bad, 'eventId', { get() { throw new Error('boom') } })
    const res = await j.append([ev('p0', 0), bad])
    expect(res).toEqual({ written: 0, duplicates: 0, rejected: [] })
    expect(j.status().counters.dropped).toBe(2)
    j.close()
  })
})

describe('known limit: the FIRST row written for an event id wins', () => {
  // INSERT OR IGNORE keeps the first row, while usage-dedupe.ts keeps the LAST record per
  // message.id. Byte-identical repeats (every measured sample) make that difference invisible; a
  // producer that wrote a partial record first would be kept partial. Pinned here so a change to
  // the rule is a decision, not an accident. A divergent duplicate is counted as an ordinary
  // duplicate — it is NOT counted apart.
  test('a duplicate carrying different data is counted as a duplicate and the stored row is kept', async () => {
    const j = await open()
    await j.append([ev('m1', 1, { data: { origin: 'harness', title: 'first' } as unknown as AgentisticsEvent['data'] })])
    const second = await j.append([ev('m1', 1, { data: { origin: 'harness', title: 'second' } as unknown as AgentisticsEvent['data'] })])
    expect(second).toEqual({ written: 0, duplicates: 1, rejected: [] })
    const page = await j.readFrom(0, 10)
    expect((page.events[0]!.data as unknown as { title: string }).title).toBe('first')
    j.close()
  })
})
