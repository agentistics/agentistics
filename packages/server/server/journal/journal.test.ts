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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { CHECKPOINT_DELAY_MS, isBusyError, openJournal, withRecoveryRetry } from './journal'
import { rowToEvent, toRow, type JournalRow } from './journal-plan'
import { EVENTS_DDL, configureConnection, type PathProbe } from './schema'
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

describe('the deferred WAL checkpoint', () => {
  /** A scheduler the test drives by hand: nothing fires until `fire()` is called. */
  function manualScheduler() {
    const pending: { run: () => void; delayMs: number; cancelled: boolean }[] = []
    let cancels = 0
    return {
      pending,
      get cancels() { return cancels },
      schedule(run: () => void, delayMs: number) {
        const entry = { run, delayMs, cancelled: false }
        pending.push(entry)
        return () => { entry.cancelled = true; cancels++ }
      },
      /** Fire the oldest live entry, as a timer would. */
      fire() {
        const e = pending.find(x => !x.cancelled)
        if (!e) throw new Error('nothing scheduled')
        e.cancelled = true
        e.run()
      },
      live: () => pending.filter(x => !x.cancelled).length,
    }
  }

  const mainSize = (path: string) => statSync(path).size

  test('a write arms ONE checkpoint; it runs outside append and copies the WAL into the main file', async () => {
    const path = fresh('ckpt')
    const sched = manualScheduler()
    const j = await openJournal({ path, probe: localProbe(), scheduleCheckpoint: sched.schedule.bind(sched) })
    expect(sched.live()).toBe(0)

    expect((await j.append(ids('c', 0, 200).map((id, i) => ev(id, i)))).written).toBe(200)
    expect(sched.live()).toBe(1)
    expect(sched.pending[0]!.delayMs).toBe(CHECKPOINT_DELAY_MS)
    // A throttle, not a debounce: more writes before it fires do not arm (or push back) another.
    expect((await j.append(ids('c', 200, 400).map((id, i) => ev(id, i)))).written).toBe(200)
    expect(sched.live()).toBe(1)

    // Nothing checkpointed yet: the rows live only in the WAL (the ceiling is far above 400 rows).
    const before = mainSize(path)
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0)
    sched.fire()
    expect(mainSize(path)).toBeGreaterThan(before)

    // The next write arms again.
    expect((await j.append([ev('c-after', 1)])).written).toBe(1)
    expect(sched.live()).toBe(1)
    expect((await j.stats()).rows).toBe(401)
    j.close()
  })

  test('an all-duplicate or all-rejected batch arms nothing: it put no frame in the WAL', async () => {
    const sched = manualScheduler()
    const j = await openJournal({ path: fresh('ckpt'), probe: localProbe(), scheduleCheckpoint: sched.schedule.bind(sched) })
    const batch = ids('d', 0, 10).map((id, i) => ev(id, i))
    await j.append(batch)
    sched.fire()
    expect((await j.append(batch)).duplicates).toBe(10)
    expect((await j.append([ev('', 1)])).rejected.length).toBe(1)
    expect(sched.live()).toBe(0)
    j.close()
  })

  test('close() cancels the pending checkpoint and checkpoints itself; the cancelled run is inert', async () => {
    const path = fresh('ckpt')
    const sched = manualScheduler()
    const j = await openJournal({ path, probe: localProbe(), scheduleCheckpoint: sched.schedule.bind(sched) })
    await j.append(ids('e', 0, 50).map((id, i) => ev(id, i)))
    expect(sched.live()).toBe(1)
    const before = mainSize(path)
    j.close()
    expect(sched.cancels).toBe(1)
    expect(sched.live()).toBe(0)
    // Even a timer that fired anyway (a cancel that lost a race) finds the journal closed.
    expect(() => sched.pending[0]!.run()).not.toThrow()
    // What the cancelled checkpoint would have copied was copied by close() itself.
    expect(mainSize(path)).toBeGreaterThan(before)
    const check = new Database(path, { readonly: true })
    expect((check.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(50)
    check.close()
  })

  test('close() with ANOTHER connection still open still leaves every committed frame in the main file', async () => {
    const path = fresh('ckpt')
    const sched = manualScheduler()
    const j = await openJournal({ path, probe: localProbe(), scheduleCheckpoint: sched.schedule.bind(sched) })
    const other = new Database(path) // keeps the WAL alive past j.close()
    await j.append(ids('f', 0, 50).map((id, i) => ev(id, i)))
    const before = mainSize(path)
    j.close()
    expect(mainSize(path)).toBeGreaterThan(before)
    other.close()
  })

  test('a scheduler that throws costs the checkpoint, never the append', async () => {
    const j = await openJournal({
      path: fresh('ckpt'), probe: localProbe(),
      scheduleCheckpoint: () => { throw new Error('no timers here') },
    })
    expect(await j.append([ev('g1', 1), ev('g2', 2)])).toEqual({ written: 2, duplicates: 0, rejected: [] })
    expect(j.status().counters.failedAppends).toBe(0)
    j.close()
  })

  test('the default scheduler checkpoints on its own, without keeping the process alive', async () => {
    const path = fresh('ckpt')
    const j = await openJournal({ path, probe: localProbe() })
    await j.append(ids('h', 0, 100).map((id, i) => ev(id, i)))
    const before = mainSize(path)
    await new Promise(r => setTimeout(r, CHECKPOINT_DELAY_MS + 150))
    expect(mainSize(path)).toBeGreaterThan(before)
    j.close()
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
      // The v2 row form (journal-plan.ts encodeRow): interned strings, epoch-ms instants.
      const words = ['session.started', 'harness', 'claude', 'replayed', 'exact', 'claude@1']
      for (const w of words) db.query('INSERT OR IGNORE INTO event_strings (s) VALUES (?)').run(w)
      const id = w => db.query('SELECT id FROM event_strings WHERE s = ?').get(w).id
      const at = Date.UTC(2026, 8, 25, 10, 0, 0)
      const ins = db.prepare("INSERT INTO events (event_id, schema, type, occurred_at, recorded_at, source_kind, source_id, mode, confidence, adapter_version, data) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, '{}')")
      const put = eid => ins.run(eid, id('session.started'), at, at, id('harness'), id('claude'), id('replayed'), id('exact'), id('claude@1'))
      if (${JSON.stringify(mode)} === 'commit') {
        db.transaction(() => { for (let i = 0; i < ${n}; i++) put(${JSON.stringify(prefix)} + i) })()
      } else {
        db.exec('BEGIN IMMEDIATE')
        for (let i = 0; i < ${n}; i++) put(${JSON.stringify(prefix)} + i)
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

describe('schema v1 -> v2 migration (A1.7)', () => {
  const V1_COLS = [
    'event_id', 'schema', 'type', 'occurred_at', 'recorded_at', 'session_id', 'run_id', 'agent_id', 'task_id',
    'source_kind', 'source_id', 'source_version', 'mode', 'confidence', 'adapter_version', 'source_ref', 'data',
  ] as const

  /** A file exactly as a v1 build left it: v1 DDL, user_version 1, rows written by v1's `toRow`. */
  function v1File(rows: JournalRow[], deleteFrom?: number): string {
    const path = fresh('v1')
    mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path, { create: true })
    configureConnection(db)
    for (const sql of EVENTS_DDL) db.exec(sql)
    db.exec('PRAGMA user_version = 1')
    const ins = db.prepare(`INSERT INTO events (${V1_COLS.join(', ')}) VALUES (${V1_COLS.map(() => '?').join(', ')})`)
    for (const r of rows) ins.run(...V1_COLS.map(c => r[c]))
    if (deleteFrom !== undefined) db.query('DELETE FROM events WHERE rowid >= ?').run(deleteFrom)
    db.close()
    return path
  }

  const hexId = (i: number) => i.toString(16).padStart(32, '0')
  const sample = (): AgentisticsEvent[] => [
    ev(hexId(1), 1, { runId: 'run_a', agentId: 'agt_a', provenance: { mode: 'replayed', confidence: 'exact', adapterVersion: '1.1.0', sourceRef: 'claude:conv:12' } }),
    ev('not-hex', 2, { data: { provider: 'anthropic', usage: { input: 1, output: 2 } } as unknown as AgentisticsEvent['data'] }),
    ev(hexId(3), 3, { taskId: 'task-9', data: 'a bare string' as unknown as AgentisticsEvent['data'] }),
    ev(hexId(4), 4),
    ev(hexId(5), 5),
  ]

  test('every row keeps its rowid and reads back identical; the cursor floor survives a deleted tail', async () => {
    const events = sample()
    // Rows 4 and 5 are deleted before the upgrade: v1's AUTOINCREMENT mark stays at 5.
    const path = v1File(events.map(toRow), 4)
    const j = await openJournal({ path, probe: localProbe() })
    expect(j.status().state).toBe('open')
    const page = await j.readFrom(0, MAX_PAGE)
    expect(page.events).toEqual(events.slice(0, 3).map(e => rowToEvent(toRow(e))))
    expect(page.cursor).toBe(3)
    expect((await j.readFrom(1, MAX_PAGE)).events.map(e => e.eventId)).toEqual([events[1]!.eventId, events[2]!.eventId])
    // A deleted id is appended again under a rowid ABOVE the old high-water mark, never 4 again.
    expect((await j.append([events[3]!])).written).toBe(1)
    expect((await j.readFrom(3, MAX_PAGE)).cursor).toBe(6)
    // Idempotency survived the conversion: a migrated id is still a duplicate.
    expect((await j.append([events[0]!]))).toEqual({ written: 0, duplicates: 1, rejected: [] })
    j.close()
    const db = new Database(path, { readonly: true })
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    expect((db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    db.close()
  })

  test('a v1 row the encoding cannot reproduce fails the migration WHOLE and leaves v1 untouched', async () => {
    const bad = { ...toRow(ev(hexId(7), 7)), occurred_at: '2026-09-25T10:00:00Z' } // not toISOString()'s form
    const path = v1File([toRow(ev(hexId(6), 6)), bad])
    const j = await openJournal({ path, probe: localProbe() })
    expect(j.status()).toMatchObject({ state: 'disabled', reason: 'migrate-failed' })
    j.close()
    const db = new Database(path, { readonly: true })
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    expect((db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(2)
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'event_strings'").get()).toBeNull()
    db.close()
  })
})

describe('readTypes — B6.6', () => {
  test('only the named types, in journal order, paged by cursor', async () => {
    const j = await open()
    const mem = (id: string, i: number) => ev(id, i, { type: 'memory.noted', data: { chainId: 'c', factId: id } as never })
    await j.append([ev('x0', 0), mem('m1', 1), ev('x2', 2), mem('m3', 3), ev('x4', 4), { ...mem('f5', 5), type: 'memory.forgotten' }])
    const first = await j.readTypes!(['memory.noted', 'memory.forgotten'], 0, 2)
    expect(first.events.map(e => e.eventId)).toEqual(['m1', 'm3'])
    const next = await j.readTypes!(['memory.noted', 'memory.forgotten'], first.cursor, 10)
    expect(next.events.map(e => [e.eventId, e.type])).toEqual([['f5', 'memory.forgotten']])
    expect((await j.readTypes!([], 0, 10)).events).toEqual([])
    expect((await j.readTypes!(['never.written'], 0, 10)).events).toEqual([])
    j.close()
  })
})
