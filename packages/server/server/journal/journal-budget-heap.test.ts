/**
 * journal-budget-heap.test.ts — MEASURES the memory-budget half of the P1 spec §9:
 *
 *     memory during a shadow build: no unbounded accumulation — events are batched and flushed,
 *     never collected into one array; proved by a synthetic 1M-event stream under a bounded heap.
 *
 * It measures; it does not tune. **A missed budget is REPORTED, never tuned away** — this file does
 * not change `journal.ts`, `journal-plan.ts` or the ceilings below to make a failing run pass.
 *
 * ── The gate ─────────────────────────────────────────────────────────────────────────────────────
 * This is a BENCHMARK, not a unit test: it builds and appends 1,000,000 events, which is slow. The
 * whole describe is skipped unless `AGENTISTICS_BUDGETS=1`, so the pre-commit `bun test` never pays
 * for it and never fails on a machine busy with something else. Run it with:
 *
 *     AGENTISTICS_BUDGETS=1 bun test packages/server/server/journal/journal-budget-heap.test.ts
 *
 * ── MEASURED: `process.memoryUsage().heapUsed` does not move on this runtime — so it is not what
 *    the ceiling is checked against ─────────────────────────────────────────────────────────────
 * The obvious design reads `heapUsed`/`rss` off `process.memoryUsage()`. A control probe run while
 * writing this file — build 20,000 objects shaped exactly like the events below, keep the array
 * reachable, `Bun.gc(true)` before and after — found `heapUsed` reporting the IDENTICAL value both
 * times (175406 bytes, on Bun 1.3.14) while in the SAME run `heapTotal` grew ~559 KB → 10.5 MB, `rss`
 * grew ~38 MB → 60 MB, and `bun:jsc`'s own `heapStats().heapSize` grew ~196 KB → 9.8 MB — the number
 * that actually tracks what was allocated. Trusting `heapUsed` here would make the HEAP ceiling
 * check vacuous (it would pass a producer that never freed anything, exactly what test 1 below
 * exists to catch), which is worse than the check not existing. So:
 *   - The HEAP ceiling is checked against `bun:jsc.heapStats().heapSize`, which this file REQUIRES —
 *     if `bun:jsc` cannot be loaded, both tests refuse loudly rather than silently falling back to a
 *     metric already shown to be inert on this runtime. (`readJscHeapSize` throws.)
 *   - The RSS ceiling is still checked against `process.memoryUsage().rss` exactly as specified —
 *     `rss` DID move correctly in the same probe.
 *   - `heapUsed` is still sampled and printed in the summary line for the record (a future Bun that
 *     fixes this is then visible in the output), but nothing here asserts on it.
 *
 * ── What "no unbounded accumulation" means, and how it is checked ──────────────────────────────────
 * The APPEND path (`journal.ts#append`) is handed one batch of 100 events at a time by its caller,
 * writes them inside one SQLite transaction, and returns. Nothing in it should hold on to a batch —
 * or to any growing structure — once `append` resolves. So the test:
 *   1. Streams 1,000,000 synthetic events through a real on-disk journal in batches of 100 (10,000
 *      batches), via a GENERATOR that builds one batch, hands it to `append`, and drops it — the
 *      test itself never holds more than one batch or the running counters.
 *   2. Samples `heapUsed`/`rss` (`process.memoryUsage()`) AND `heapSize` (`bun:jsc.heapStats()`)
 *      every 100 batches, WITHOUT ever forcing a GC. An un-collected heap includes ordinary garbage
 *      the collector has not gotten to yet, which makes every ceiling below CONSERVATIVE (it charges
 *      the run for garbage a real process would also carry), never optimistic.
 *   3. Takes a BASELINE after the journal is open and 100 batches have gone through (warm-up:
 *      SQLite's own prepared-statement objects, WAL page cache, and this process's JIT warm-up all
 *      settle in that window) and asserts every later sample's GROWTH over that baseline, not an
 *      absolute figure — an absolute number would also be measuring how much memory Bun itself
 *      starts with, which this test has no opinion about.
 *   4. Asserts there is no upward TREND across the run (the mean of the last 10% of samples vs. the
 *      first 10%, after the baseline, on the same `heapSize` signal the ceiling uses) — a ceiling
 *      alone would miss a slow leak that never crosses it inside one run.
 *   5. PROVES the ceiling is not vacuous: a separate, independent measurement (test 1 below) sizes
 *      what 1,000,000 events retained in ONE array would actually cost on `heapSize`, and asserts
 *      that figure is well OVER the ceiling — so a hypothetical producer that collected the stream
 *      instead of streaming it would fail this budget, not silently pass it.
 *
 * ── Ceilings, and why these numbers ──────────────────────────────────────────────────────────────
 * `HEAP_CEILING_MIB = 64`, `RSS_CEILING_MIB = 128`, chosen BEFORE running this file and never raised
 * to make a run pass:
 *   - A batch of 100 events + their SQLite row bindings is a few hundred KB at most; over 10,000
 *     batches with nothing retained, heap growth should be flat modulo GC/JIT noise. 64 MiB is a
 *     generous multiple of that noise band while still being well under what retaining even a small
 *     fraction of the stream costs (see test 1's own numbers in the printed line: ~20,000 events
 *     alone measured in the hundreds of KB, and 1,000,000 of them scales past the ceiling).
 *   - RSS gets double the heap's budget because it also carries the OS-level cost this test does
 *     NOT try to bound separately: the growing `journal.db` / `journal.db-wal` files' page-cache
 *     residency and bun:sqlite's own native (non-JS-heap) buffers, both of which scale with the
 *     database's size (100k rows → 1M rows here) rather than with anything the append path retains.
 *
 * ── Scope — what this file covers, and what it deliberately does not ───────────────────────────────
 * This covers the JOURNAL's `append` path ONLY (`journal.ts` + `journal-plan.ts`), against a real
 * on-disk `bun:sqlite` file. It does NOT cover:
 *   - The shadow WRITER (A2.3), which does not exist yet at the time this file was written — whether
 *     IT batches and flushes rather than collecting a build's events is A2.3's own budget to prove.
 *   - Any other batch size, concurrent reader/writer, or a real (non-synthetic) transcript replay.
 *   - Single process, one machine, one run, one Bun version — this is not a statistical claim across
 *     hardware or runtimes, and the `heapUsed` finding above is itself scoped to Bun 1.3.14.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { openJournal } from './journal'
import { planAppend } from './journal-plan'
import type { PathProbe } from './schema'
import type { Journal } from './types'

const MIB = 1024 * 1024

const BATCH_SIZE = 100
const TOTAL_EVENTS = 1_000_000
const TOTAL_BATCHES = TOTAL_EVENTS / BATCH_SIZE // 10,000

/** Baseline is taken once the journal is open AND this many batches have gone through (warm-up). */
const WARMUP_BATCHES = 100
/** Every Nth batch after warm-up gets a memory sample. */
const SAMPLE_EVERY_BATCHES = 100

/** Chosen before running this file; see the header for the justification. Never raised to pass. */
const HEAP_CEILING_MIB = 64
const RSS_CEILING_MIB = 128
/** The trend check's allowance: half the heap ceiling, so a slow leak fails well before it could
 *  itself cross the absolute ceiling inside one run. */
const TREND_CEILING_MIB = HEAP_CEILING_MIB / 2

/** How many events go into the retained-array control measurement (test 1). */
const CONTROL_SAMPLE_EVENTS = 20_000

const round2 = (x: number): number => Math.round(x * 100) / 100
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/** Every path classified as local ext4 — the journal must OPEN for the measurement to mean anything. */
function localProbe(): PathProbe {
  return {
    platform: 'linux',
    realpath: p => p,
    readMountinfo: () => '58 42 8:32 / / rw,relatime - ext4 /dev/sdc rw',
    readDarwinMounts: () => null,
  }
}

// ── The reliable heap signal on this runtime ────────────────────────────────────────────────────
//
// See the header's MEASURED note: `process.memoryUsage().heapUsed` does not move on Bun 1.3.14 when
// JS objects are allocated and retained, so it cannot back a heap-growth ceiling. `bun:jsc`'s own
// `heapStats().heapSize` does. Loaded once, lazily, and cached; a runtime where it cannot be loaded
// gets a loud refusal rather than a silent fallback to the metric already shown to be inert.

let jscHeapSizeFn: (() => number) | null = null
let jscLoadAttempted = false

async function readJscHeapSize(): Promise<() => number> {
  if (!jscLoadAttempted) {
    jscLoadAttempted = true
    try {
      const jsc: unknown = await import('bun:jsc')
      const stats = (jsc as { heapStats?: () => { heapSize: number } }).heapStats
      if (typeof stats === 'function') jscHeapSizeFn = () => stats().heapSize
    } catch {
      jscHeapSizeFn = null
    }
  }
  if (!jscHeapSizeFn) {
    throw new Error(
      'bun:jsc heapStats() could not be loaded on this runtime, and process.memoryUsage().heapUsed ' +
        'was MEASURED not to move on Bun 1.3.14 when JS objects are allocated and retained (heapTotal, ' +
        'external and rss all did). There is no reliable JS-heap-growth signal available, so this ' +
        'budget refuses rather than silently asserting against a metric already shown to be inert.',
    )
  }
  return jscHeapSizeFn
}

// ── The synthetic stream ────────────────────────────────────────────────────────────────────────
//
// One deterministic function of the GLOBAL index `g`, so the stream can be generated batch by
// batch without ever building the whole thing. Realistic mix per 100-slot cycle (matches
// `BATCH_SIZE`, so every batch carries the same proportions): 70% `model.completed` with a full
// four-counter `usage`, 10% `tool.requested`, 10% `tool.completed`, 10% `session.started`.

const BASE_MS = Date.UTC(2026, 8, 25, 8, 0, 0)
const SESSION_SIZE = 2000

function eventAt(g: number): AgentisticsEvent {
  const sessionIdx = Math.floor(g / SESSION_SIZE)
  const sessionId = `heap-bench-session-${sessionIdx}`
  const at = new Date(BASE_MS + g * 250).toISOString()
  const common = {
    eventId: `heap-bench-${g}`,
    schema: 1,
    occurredAt: at,
    recordedAt: at,
    sessionId,
    source: { kind: 'harness' as const, id: 'claude', version: '2.1.0' },
    provenance: { mode: 'replayed' as const, confidence: 'exact' as const, adapterVersion: 'heap-bench@1' },
  }
  const mk = (type: string, data: unknown): AgentisticsEvent =>
    ({ ...common, type, data } as unknown as AgentisticsEvent)

  const slot = g % BATCH_SIZE
  if (slot < 70) {
    return mk('model.completed', {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: {
        input: 200 + (g % 5000),
        output: 50 + ((g * 7) % 2000),
        cacheRead: 40_000 + ((g * 131) % 150_000),
        cacheWrite: 200 + ((g * 37) % 4000),
      },
      status: 'completed',
    })
  }
  if (slot < 80) {
    return mk('tool.requested', {
      toolExecutionId: `heap-bench-tool-${g}`,
      name: 'Read',
      canonicalName: 'Read',
      kind: 'file',
    })
  }
  if (slot < 90) {
    return mk('tool.completed', {
      toolExecutionId: `heap-bench-tool-${g}`,
      durationMs: 20 + (g % 500),
    })
  }
  return mk('session.started', { origin: 'native' })
}

/**
 * Batch `b` (0-based) of a `totalEvents`-long stream, `batchSize` events each — built fresh, never
 * cached. A generator so the caller (the test loop below) can consume one batch, hand it to
 * `append`, and let it go, without ever holding the whole stream or even a growing suffix of it.
 */
function* streamBatches(totalEvents: number, batchSize: number): Generator<AgentisticsEvent[]> {
  let g = 0
  while (g < totalEvents) {
    const n = Math.min(batchSize, totalEvents - g)
    const batch: AgentisticsEvent[] = new Array(n)
    for (let k = 0; k < n; k++) batch[k] = eventAt(g + k)
    g += n
    yield batch
    // Nothing above or below this line keeps a reference to `batch` past this point.
  }
}

// ── The retained-size control (proves the ceiling is not vacuous) ──────────────────────────────────

interface RetainedMeasurement {
  bytesPerEvent: number
  beforeMiB: number
  afterMiB: number
}

let cachedRetained: RetainedMeasurement | null = null

/**
 * Builds `n` events into ONE array and sizes what that costs on `heapSize` — the thing `append`'s
 * batching is specifically designed to never do with the full 1,000,000. Cached so the control test
 * and the main test's printed summary agree on one number without depending on run order.
 *
 * A `Bun.gc(true)` immediately before EACH of the two readings is legitimate HERE — unlike the main
 * run's samples, this is sizing one retained object, not measuring a process that must behave the
 * way it would unassisted.
 */
async function measureRetainedBytesPerEvent(n: number): Promise<RetainedMeasurement> {
  if (cachedRetained) return cachedRetained
  const heapSize = await readJscHeapSize()
  Bun.gc(true)
  const before = heapSize()
  const arr: AgentisticsEvent[] = new Array(n)
  let sink = 0
  for (let i = 0; i < n; i++) {
    const e = eventAt(i)
    arr[i] = e
    sink += e.eventId.length // read something real out of every event; defeats dead-store removal.
  }
  Bun.gc(true)
  const after = heapSize()
  // Keep `arr` (and `sink`) reachable through both readings — this only asserts they were not
  // optimised away, never uses their actual values for anything else.
  if (arr.length !== n || sink < n) throw new Error('unreachable: retained array was not built as sized')
  cachedRetained = { bytesPerEvent: (after - before) / n, beforeMiB: before / MIB, afterMiB: after / MIB }
  return cachedRetained
}

// ── Memory sampling (the main run — NEVER forces a GC) ──────────────────────────────────────────

interface Sample {
  batch: number
  heapUsedMiB: number
  rssMiB: number
  jscHeapMiB: number
}

function sampleMemory(batch: number, jscHeapSize: () => number): Sample {
  const mem = process.memoryUsage()
  return { batch, heapUsedMiB: mem.heapUsed / MIB, rssMiB: mem.rss / MIB, jscHeapMiB: jscHeapSize() / MIB }
}

// ── The tests ───────────────────────────────────────────────────────────────────────────────────

describe.skipIf(process.env.AGENTISTICS_BUDGETS !== '1')('journal append — memory budget (P1 §9)', () => {
  let root = ''
  let j: Journal | null = null

  afterAll(() => {
    try { j?.close() } catch { /* already closed */ }
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test(
    `the ceiling is not vacuous: ${CONTROL_SAMPLE_EVENTS} retained events already cost more per-event ` +
      `than the ${HEAP_CEILING_MIB} MiB ceiling could hide at 1,000,000`,
    async () => {
      const { bytesPerEvent, beforeMiB, afterMiB } = await measureRetainedBytesPerEvent(CONTROL_SAMPLE_EVENTS)
      const accumulationWouldBeMiB = (bytesPerEvent * TOTAL_EVENTS) / MIB
      // A negative or zero reading means the GC pair (or the heap-size signal itself) did not do its
      // job — the measurement would be meaningless, or worse, would let a bogus "cost" of zero pass
      // the assertion below by accident instead of failing loudly.
      expect(bytesPerEvent).toBeGreaterThan(0)
      expect(round2(afterMiB - beforeMiB)).toBeGreaterThan(0)
      // The actual claim: a producer that collected the whole 1M-event stream into one array, instead
      // of batching and flushing it, would blow the heap ceiling this file holds the append path to.
      expect(accumulationWouldBeMiB).toBeGreaterThan(HEAP_CEILING_MIB)
    },
    30_000,
  )

  test(
    `append path stays within a bounded heap over a synthetic ${TOTAL_EVENTS}-event stream ` +
      `(${TOTAL_BATCHES} batches of ${BATCH_SIZE})`,
    async () => {
      root = mkdtempSync(join(tmpdir(), 'agentistics-journal-heap-'))
      const path = join(root, 'journal.db')
      j = await openJournal({ path, probe: localProbe() })
      expect(j.status().state).toBe('open')

      const jscHeapSize = await readJscHeapSize()
      const samples: Sample[] = []
      let baseline: Sample | null = null
      let written = 0
      let batchIndex = 0
      const startedAt = Date.now()

      for (const batch of streamBatches(TOTAL_EVENTS, BATCH_SIZE)) {
        if (batchIndex === 0) {
          // Every one of the 100 events in the first batch must pass the plan — if the mix itself
          // were rejected, the rest of the run would be measuring `dropped`, not `append`.
          const plan = planAppend(batch)
          expect(plan.rejected).toEqual([])
          expect(plan.rows.length).toBe(BATCH_SIZE)
        }

        const res = await j.append(batch)
        expect(res.rejected.length).toBe(0)
        expect(res.duplicates).toBe(0)
        written += res.written
        batchIndex++
        // `batch` (and `res`) go out of scope here; nothing retains them past this iteration.

        if (batchIndex === WARMUP_BATCHES) {
          baseline = sampleMemory(batchIndex, jscHeapSize)
          samples.push(baseline)
        } else if (batchIndex > WARMUP_BATCHES && batchIndex % SAMPLE_EVERY_BATCHES === 0) {
          samples.push(sampleMemory(batchIndex, jscHeapSize))
        }
        // No `Bun.gc()` call anywhere in this loop, before or after a sample: an un-collected heap
        // includes ordinary garbage, which makes every figure below conservative, never optimistic.
      }

      const durationS = (Date.now() - startedAt) / 1000
      expect(baseline).not.toBeNull()
      const base = baseline!

      const status = j.status()
      const stats = await j.stats()

      // The asserted ceiling is on `jscHeapMiB` (see the header's MEASURED note) — `heapUsedMiB` is
      // still recorded and printed below, for the record, but nothing here trusts it.
      const heapGrowths = samples.map(s => s.jscHeapMiB - base.jscHeapMiB)
      const rssGrowths = samples.map(s => s.rssMiB - base.rssMiB)
      const maxHeapGrowthMiB = Math.max(...heapGrowths)
      const maxRssGrowthMiB = Math.max(...rssGrowths)
      const maxHeapUsedGrowthMiB = Math.max(...samples.map(s => s.heapUsedMiB - base.heapUsedMiB))

      // Trend: mean of the last 10% of POST-baseline samples vs. the mean of the first 10%. Catches a
      // slow leak that never itself crosses the absolute ceiling inside one run.
      const postBaseline = samples.slice(1)
      const tenPct = Math.max(1, Math.ceil(postBaseline.length * 0.1))
      const trendMiB = postBaseline.length === 0
        ? 0
        : mean(postBaseline.slice(-tenPct).map(s => s.jscHeapMiB)) -
          mean(postBaseline.slice(0, tenPct).map(s => s.jscHeapMiB))

      const { bytesPerEvent } = await measureRetainedBytesPerEvent(CONTROL_SAMPLE_EVENTS)
      const accumulationWouldBeMiB = (bytesPerEvent * TOTAL_EVENTS) / MIB

      const pass =
        maxHeapGrowthMiB <= HEAP_CEILING_MIB &&
        maxRssGrowthMiB <= RSS_CEILING_MIB &&
        trendMiB <= TREND_CEILING_MIB

      console.log('JOURNAL_HEAP_BUDGET ' + JSON.stringify({
        events: written,
        batchSize: BATCH_SIZE,
        baselineHeapMiB: round2(base.jscHeapMiB),
        maxHeapGrowthMiB: round2(maxHeapGrowthMiB),
        maxRssGrowthMiB: round2(maxRssGrowthMiB),
        heapCeilingMiB: HEAP_CEILING_MIB,
        rssCeilingMiB: RSS_CEILING_MIB,
        trendMiB: round2(trendMiB),
        trendCeilingMiB: TREND_CEILING_MIB,
        bytesPerRetainedEvent: round2(bytesPerEvent),
        accumulationWouldBeMiB: round2(accumulationWouldBeMiB),
        durationS: round2(durationS),
        dbBytes: stats.bytes,
        samplesTaken: samples.length,
        warmupBatches: WARMUP_BATCHES,
        sampleEveryBatches: SAMPLE_EVERY_BATCHES,
        pass,
        bun: Bun.version,
        heapSignal: 'bun:jsc heapStats().heapSize — process.memoryUsage().heapUsed was measured not ' +
          'to move on this runtime and is reported but not asserted on',
        heapUsedGrowthMiB_notAsserted: round2(maxHeapUsedGrowthMiB),
        scope: 'journal append path only (journal.ts + journal-plan.ts); the A2.3 shadow writer is ' +
          'not covered; batch=100, single process, no concurrent reader, synthetic (not replayed) events',
      }))

      // The write itself, in full, before the memory claims — a bounded heap that dropped events
      // would be measuring the wrong thing.
      expect(written).toBe(TOTAL_EVENTS)
      expect(status.counters.written).toBe(TOTAL_EVENTS)
      expect(status.counters.dropped).toBe(0)
      expect(status.counters.failedAppends).toBe(0)
      expect(stats.rows).toBe(TOTAL_EVENTS)

      // The memory claims.
      expect(maxHeapGrowthMiB).toBeLessThanOrEqual(HEAP_CEILING_MIB)
      expect(maxRssGrowthMiB).toBeLessThanOrEqual(RSS_CEILING_MIB)
      expect(trendMiB).toBeLessThanOrEqual(TREND_CEILING_MIB)
    },
    600_000,
  )
})
