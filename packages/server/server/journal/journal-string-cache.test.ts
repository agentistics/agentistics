/**
 * journal-string-cache.test.ts — proves the bound `StringCache` (A1.8) changes nothing the journal
 * reads or writes: a TINY budget that evicts constantly must read back byte-identical events to an
 * UNBOUNDED one, over the same batch of events carrying many distinct interned strings. Also proves
 * the journal actually routes its interning through an injected cache instance (rather than some
 * other, still-unbounded structure) and that a rolled-back batch never reaches the cache.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { openJournal } from './journal'
import type { PathProbe } from './schema'
import { StringCache } from './string-cache'
import type { Journal } from './types'

let root = ''
let seq = 0
const fresh = () => join(root, `j-${++seq}`, 'journal.db')

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'agentistics-journal-string-cache-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function localProbe(): PathProbe {
  return {
    platform: 'linux',
    realpath: p => p,
    readMountinfo: () => '58 42 8:32 / / rw,relatime - ext4 /dev/sdc rw',
    readDarwinMounts: () => null,
  }
}

/** Every field that gets interned is made DISTINCT per event, so a tiny cache is forced to evict
 *  constantly on both the write and the read side — the exact condition A1.8 exists to bound. */
function ev(i: number): AgentisticsEvent {
  const t = new Date(Date.UTC(2026, 8, 25, 10, 0, 0) + i * 1000).toISOString()
  return {
    eventId: `evt-${i}`,
    schema: 1,
    type: i % 2 === 0 ? 'session.started' : 'tool.requested',
    occurredAt: t,
    recordedAt: t,
    sessionId: `distinct-session-${i}`,
    runId: `distinct-run-${i}`,
    agentId: `distinct-agent-${i}`,
    source: { kind: 'harness', id: 'claude', version: `2.${i}.0` },
    provenance: {
      mode: 'replayed',
      confidence: 'exact',
      adapterVersion: `claude@1.${i}`,
      sourceRef: `distinct-transcript-file-${i}.jsonl:${i}`,
    },
    data:
      i % 2 === 0
        ? { origin: 'harness', title: `distinct title ${i}` }
        : { toolExecutionId: `tool-${i}`, name: 'Read', canonicalName: 'Read', kind: 'file' },
  } as unknown as AgentisticsEvent
}

const N = 300

async function buildAndRead(cache: StringCache): Promise<AgentisticsEvent[]> {
  const j: Journal = await openJournal({ path: fresh(), probe: localProbe(), stringCache: cache })
  expect(j.status().state).toBe('open')
  const batch = Array.from({ length: N }, (_, i) => ev(i))
  // Small sub-batches, so the write side interns and commits repeatedly rather than once — the shape
  // a real shadow build uses (`FLUSH_EVENTS`), and the shape that actually exercises eviction between
  // commits under a tiny budget.
  for (let i = 0; i < batch.length; i += 25) {
    const r = await j.append(batch.slice(i, i + 25))
    expect(r.rejected).toEqual([])
    expect(r.duplicates).toBe(0)
  }
  const out: AgentisticsEvent[] = []
  let cursor = 0
  for (;;) {
    const page = await j.readFrom(cursor, 100)
    if (page.events.length === 0) break
    out.push(...page.events)
    cursor = page.cursor
  }
  j.close()
  return out
}

describe('a tiny (constantly-evicting) budget reads back identically to an unbounded one', () => {
  test('byte-identical events, same order, same count', async () => {
    const unbounded = await buildAndRead(new StringCache(Number.POSITIVE_INFINITY))
    const tiny = await buildAndRead(new StringCache(512)) // far below what N=300 distinct strings would need

    expect(tiny.length).toBe(N)
    expect(unbounded.length).toBe(N)
    expect(JSON.stringify(tiny)).toBe(JSON.stringify(unbounded))
  })

  test('a budget of 0 (cache fully disabled) also reads back identically', async () => {
    const unbounded = await buildAndRead(new StringCache(Number.POSITIVE_INFINITY))
    const disabled = await buildAndRead(new StringCache(0))
    expect(JSON.stringify(disabled)).toBe(JSON.stringify(unbounded))
  })
})

describe('the journal actually routes interning through the injected cache', () => {
  test('the cache instance records entries after append and after readFrom', async () => {
    const cache = new StringCache(1024 * 1024)
    expect(cache.stats().entries).toBe(0)
    const j = await openJournal({ path: fresh(), probe: localProbe(), stringCache: cache })
    await j.append([ev(1), ev(2)])
    const afterAppend = cache.stats().entries
    expect(afterAppend).toBeGreaterThan(0)

    // A SEPARATE cache on a SEPARATE handle to the same file proves `lookup` populates ITS OWN
    // cache from `event_strings` on a cold read, independent of what the writer cached.
    const readerCache = new StringCache(1024 * 1024)
    const reader = await openJournal({ path: j.status().path, probe: localProbe(), stringCache: readerCache })
    expect(readerCache.stats().entries).toBe(0)
    const page = await reader.readFrom(0, 10)
    expect(page.events.length).toBe(2)
    expect(readerCache.stats().entries).toBeGreaterThan(0)
    j.close()
    reader.close()
  })

  test('a batch that fails mid-transaction (and rolls back) never reaches the cache', async () => {
    const cache = new StringCache(1024 * 1024)
    const path = fresh()
    const j = await openJournal({ path, probe: localProbe(), stringCache: cache })
    // `planAppend` accepts this batch fully (nothing here fails the PLAN's own checks), so the
    // transaction opens and interns brand-new strings (writing real rows into `event_strings`, then
    // rolled back with everything else) before the INSERT into `events` throws — the table is gone
    // from under the open journal, exactly as `journal.test.ts`'s own "failures are counted" test
    // pulls it out, but here the point is what happens to the strings interned along the way.
    const other = new Database(path)
    other.exec('DROP TABLE events')
    other.close()

    const before = cache.stats()
    const res = await j.append([ev(1)])
    expect(res.written).toBe(0)
    expect(j.status().counters.failedAppends).toBe(1)
    expect(j.status().counters.dropped).toBe(1)
    // The strings `ev(1)` would have interned (its distinct session/run/agent ids, its type, its
    // source_ref, …) never joined the cache — `remember` is only ever called on the SUCCESS branch.
    expect(cache.stats()).toEqual(before)
    j.close()
  })
})
