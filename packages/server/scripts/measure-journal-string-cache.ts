#!/usr/bin/env bun
/**
 * measure-journal-string-cache.ts — A1.8's before/after measurement for the journal's interned-
 * string cache (packages/server/server/journal/string-cache.ts).
 *
 * Runs the SAME two workloads against an UNBOUNDED cache (`StringCache(Infinity)` — reproduces the
 * old, unbounded `Map`-based behaviour exactly) and then against a BOUNDED one
 * (`DEFAULT_STRING_CACHE_BYTES`, or an override), on the real store, and prints a JSON report with
 * peak RSS / JSC heap / cache footprint / wall time for each:
 *
 *   (a) a FULL SHADOW-SHAPED BUILD that appends — every transcript the Claude replay discovers,
 *       replayed from a null cursor and appended in `FLUSH_EVENTS` slices, into an EMPTY journal;
 *   (b) a FULL `readFrom` CURSOR WALK over everything just written.
 *
 * `/api/runtime/metrics` is not yet on `dev` at the time this script was written (checked
 * 2026-09-27) — there is no third path to measure here, and the handback says so rather than
 * inventing one.
 *
 * ── Each workload runs in its OWN process ────────────────────────────────────────────────────────
 * Running "unbounded" then "bounded" sequentially in ONE process was tried first and discarded: the
 * SECOND run's peak RSS came out ~250 MiB lower than the first's while both ended with the identical
 * cache footprint (3419 entries, 0.57 MiB) — a warm-up/GC artifact of process order, not of the
 * cache bound being measured. So the top-level invocation spawns each workload as its OWN `bun`
 * child process (this same file, re-invoked with `AGENTISTICS_STRING_CACHE_CHILD_MODE` set) and
 * combines their independently-reported results — no shared JS heap, no shared warm-up, for either
 * to lean on the other.
 *
 * Usage (never touches `~/.agentistics` — refuses without an explicit scratch dir):
 *
 *   AGENTISTICS_DIR=<scratch> \
 *     [AGENTISTICS_STRING_CACHE_PROJECTS=<a COPY of ~/.claude/projects>] \
 *     [AGENTISTICS_STRING_CACHE_BUDGET_BYTES=<override the bounded run's budget>] \
 *     [AGENTISTICS_STRING_CACHE_OUT=<report.json>] \
 *     bun packages/server/scripts/measure-journal-string-cache.ts
 *
 * Point `AGENTISTICS_STRING_CACHE_PROJECTS` at a COPY, never the live `~/.claude/projects` — the
 * live store grows while this runs, which would make the before/after runs compare different bytes.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR, PROJECTS_DIR } from '../server/config'
import { createClaudeReplay } from '../server/integrations/claude'
import { openJournal } from '../server/journal/journal'
import { FLUSH_EVENTS } from '../server/journal/shadow'
import { DEFAULT_STRING_CACHE_BYTES, StringCache } from '../server/journal/string-cache'
import type { PathProbe } from '../server/journal/schema'
import type { Journal } from '../server/journal/types'

// Nothing this script imports may reach the real data dir — same refusal `journal-budget-size.test.ts` makes.
if (!process.env.AGENTISTICS_DIR) {
  console.error('AGENTISTICS_DIR must be set to a scratch directory — this script refuses to touch ~/.agentistics.')
  process.exit(1)
}
if (AGENTISTICS_DATA_DIR === DEFAULT_AGENTISTICS_DATA_DIR) {
  console.error(`AGENTISTICS_DIR resolved to the default data dir (${DEFAULT_AGENTISTICS_DATA_DIR}) — refusing.`)
  process.exit(1)
}

const MIB = 1024 * 1024
const RESULT_MARKER = 'STRING_CACHE_RESULT '
const localProbe: PathProbe = {
  platform: 'linux',
  realpath: p => p,
  readMountinfo: () => '58 42 8:32 / / rw,relatime - ext4 /dev/sdc rw',
  readDarwinMounts: () => null,
}

const size = (p: string): number => { try { return statSync(p).size } catch { return 0 } }
const mb2 = (b: number): number => Math.round((b / MIB) * 100) / 100

let jscHeapSizeFn: (() => number) | null = null
let jscLoadAttempted = false
async function jscHeapSize(): Promise<() => number> {
  if (!jscLoadAttempted) {
    jscLoadAttempted = true
    try {
      const jsc: unknown = await import('bun:jsc')
      const stats = (jsc as { heapStats?: () => { heapSize: number } }).heapStats
      if (typeof stats === 'function') jscHeapSizeFn = () => stats().heapSize
    } catch { jscHeapSizeFn = null }
  }
  if (!jscHeapSizeFn) {
    throw new Error(
      'bun:jsc heapStats() could not be loaded — process.memoryUsage().heapUsed was measured (see ' +
        'journal-budget-heap.test.ts) not to move on this runtime when JS objects are retained, so ' +
        'there is no reliable JS-heap-growth signal to report without it.',
    )
  }
  return jscHeapSizeFn
}

interface Peak { rssMiB: number; heapMiB: number }

/** Samples RSS + JSC heap; returns a running-peak tracker updated by calling `sample()`. */
function peakTracker(heapSize: () => number): { sample: () => void; peak: Peak } {
  const peak: Peak = { rssMiB: 0, heapMiB: 0 }
  return {
    sample() {
      const rss = process.memoryUsage().rss / MIB
      const heap = heapSize() / MIB
      if (rss > peak.rssMiB) peak.rssMiB = rss
      if (heap > peak.heapMiB) peak.heapMiB = heap
    },
    peak,
  }
}

type Mode = 'unbounded' | 'bounded'

interface RunResult {
  mode: Mode
  budgetBytes: number
  appendPeak: Peak
  appendWallMs: number
  eventsWritten: number
  readPeak: Peak
  readWallMs: number
  eventsRead: number
  cacheStatsAfterAppend: { entries: number; bytes: number }
  cacheStatsAfterRead: { entries: number; bytes: number }
  journalBytesOnDisk: number
}

async function runOnce(mode: Mode, budgetBytes: number, projectsDir: string, scratchRoot: string, nowMs: number): Promise<RunResult> {
  const path = join(scratchRoot, 'journal.db')
  const heapSize = await jscHeapSize()

  const cache = new StringCache(budgetBytes)
  const j: Journal = await openJournal({ path, probe: localProbe, stringCache: cache })
  if (j.status().state !== 'open') throw new Error(`journal did not open for ${mode} run: ${JSON.stringify(j.status())}`)

  // ── (a) full shadow-shaped build ──────────────────────────────────────────────────────────────
  const appendTracker = peakTracker(heapSize)
  // A FIXED clock (passed down from the parent, shared by both children): `createClaudeReplay`
  // decides a transcript's `final`-ness relative to `now()` vs its mtime (`DEFAULT_SETTLED_MS`), so
  // two processes started a little apart over the identical bytes could otherwise discover different
  // events as sessions cross that threshold between them.
  const replay = createClaudeReplay({ projectsDir, now: () => nowMs })
  const sources = await replay.discover()
  let written = 0
  let sampleCounter = 0
  const appendStart = Date.now()
  for (const src of sources) {
    const batch = await replay.replay(src, null)
    for (let i = 0; i < batch.events.length; i += FLUSH_EVENTS) {
      const r = await j.append(batch.events.slice(i, i + FLUSH_EVENTS))
      written += r.written
      if (++sampleCounter % 20 === 0) appendTracker.sample()
    }
  }
  appendTracker.sample()
  const appendWallMs = Date.now() - appendStart
  const cacheStatsAfterAppend = cache.stats()

  // ── (b) full readFrom cursor walk ─────────────────────────────────────────────────────────────
  const readTracker = peakTracker(heapSize)
  const readStart = Date.now()
  let cursor = 0
  let read = 0
  let readSamples = 0
  for (;;) {
    const page = await j.readFrom(cursor, 1000)
    if (page.events.length === 0) break
    read += page.events.length
    cursor = page.cursor
    if (++readSamples % 20 === 0) readTracker.sample()
  }
  readTracker.sample()
  const readWallMs = Date.now() - readStart
  const cacheStatsAfterRead = cache.stats()

  const journalBytesOnDisk = size(path) + size(`${path}-wal`)
  j.close()

  return {
    mode,
    budgetBytes,
    appendPeak: appendTracker.peak,
    appendWallMs,
    eventsWritten: written,
    readPeak: readTracker.peak,
    readWallMs,
    eventsRead: read,
    cacheStatsAfterAppend: { entries: cacheStatsAfterAppend.entries, bytes: cacheStatsAfterAppend.bytes },
    cacheStatsAfterRead: { entries: cacheStatsAfterRead.entries, bytes: cacheStatsAfterRead.bytes },
    journalBytesOnDisk,
  }
}

/** The CHILD half: run exactly one workload and print its result as the marked last line of stdout. */
async function runChild(mode: Mode): Promise<void> {
  const projectsDir = process.env.AGENTISTICS_STRING_CACHE_PROJECTS ?? PROJECTS_DIR
  const nowMs = Number(process.env.AGENTISTICS_STRING_CACHE_NOW_MS)
  if (!Number.isFinite(nowMs)) throw new Error('child invoked without AGENTISTICS_STRING_CACHE_NOW_MS')
  const budgetBytes = mode === 'unbounded'
    ? Number.POSITIVE_INFINITY
    : process.env.AGENTISTICS_STRING_CACHE_BUDGET_BYTES
      ? Number(process.env.AGENTISTICS_STRING_CACHE_BUDGET_BYTES)
      : DEFAULT_STRING_CACHE_BYTES
  const scratchRoot = mkdtempSync(join(tmpdir(), `agentistics-string-cache-${mode}-`))
  try {
    const result = await runOnce(mode, budgetBytes, projectsDir, scratchRoot, nowMs)
    console.log(RESULT_MARKER + JSON.stringify(result))
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true })
  }
}

/** The PARENT half: spawn a fresh child process per workload and combine their independent results. */
async function spawnChild(mode: Mode, scriptPath: string, projectsDir: string, nowMs: number): Promise<RunResult> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AGENTISTICS_STRING_CACHE_CHILD_MODE: mode,
    AGENTISTICS_STRING_CACHE_PROJECTS: projectsDir,
    AGENTISTICS_STRING_CACHE_NOW_MS: String(nowMs),
  }
  const proc = Bun.spawn([process.execPath, scriptPath], { env, stdout: 'pipe', stderr: 'inherit' })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`${mode} child exited with code ${code}`)
  const line = out.split('\n').find(l => l.startsWith(RESULT_MARKER))
  if (!line) throw new Error(`${mode} child produced no result line. Full output:\n${out}`)
  return JSON.parse(line.slice(RESULT_MARKER.length)) as RunResult
}

async function runParent(): Promise<void> {
  const projectsDir = process.env.AGENTISTICS_STRING_CACHE_PROJECTS ?? PROJECTS_DIR
  const boundedBudgetPreview = process.env.AGENTISTICS_STRING_CACHE_BUDGET_BYTES
    ? Number(process.env.AGENTISTICS_STRING_CACHE_BUDGET_BYTES)
    : DEFAULT_STRING_CACHE_BYTES
  const nowMs = Date.now()
  const scriptPath = import.meta.path
  console.log(`measuring against ${projectsDir}, bounded budget=${boundedBudgetPreview} bytes, two independent child processes`)

  const before = await spawnChild('unbounded', scriptPath, projectsDir, nowMs)
  const after = await spawnChild('bounded', scriptPath, projectsDir, nowMs)

  if (before.eventsWritten !== after.eventsWritten || before.eventsRead !== after.eventsRead) {
    throw new Error(
      `event counts differ between runs — not a fair comparison: before wrote ${before.eventsWritten}` +
        ` / read ${before.eventsRead}, after wrote ${after.eventsWritten} / read ${after.eventsRead}`,
    )
  }

  const side = (r: RunResult) => ({
    appendPeakRssMiB: mb2(r.appendPeak.rssMiB * MIB),
    appendPeakHeapMiB: mb2(r.appendPeak.heapMiB * MIB),
    appendWallMs: r.appendWallMs,
    readPeakRssMiB: mb2(r.readPeak.rssMiB * MIB),
    readPeakHeapMiB: mb2(r.readPeak.heapMiB * MIB),
    readWallMs: r.readWallMs,
    cacheEntriesAfterAppend: r.cacheStatsAfterAppend.entries,
    cacheBytesAfterAppendMiB: mb2(r.cacheStatsAfterAppend.bytes),
    cacheEntriesAfterRead: r.cacheStatsAfterRead.entries,
    cacheBytesAfterReadMiB: mb2(r.cacheStatsAfterRead.bytes),
    journalBytesOnDiskMiB: mb2(r.journalBytesOnDisk),
  })

  const report = {
    projectsDir,
    eventsWritten: before.eventsWritten,
    eventsRead: before.eventsRead,
    before: side(before),
    after: { budgetBytes: after.budgetBytes, budgetMiB: mb2(after.budgetBytes), ...side(after) },
    bun: Bun.version,
  }
  console.log(JSON.stringify(report, null, 2))
  if (process.env.AGENTISTICS_STRING_CACHE_OUT) {
    await Bun.write(process.env.AGENTISTICS_STRING_CACHE_OUT, JSON.stringify(report, null, 2))
  }
}

const childMode = process.env.AGENTISTICS_STRING_CACHE_CHILD_MODE as Mode | undefined
if (childMode === 'unbounded' || childMode === 'bounded') {
  await runChild(childMode)
} else {
  await runParent()
}
