/**
 * journal-budget-append.test.ts — MEASURES the journal-append budget of the P1 spec §9:
 *
 *     journal append ≤ 2 ms p95 per batch of 100 events (WAL, one transaction per batch)
 *
 * It measures; it does not tune. A missed budget FAILS this test and is reported — it is never
 * made to pass by changing a pragma, a batch size or the event mix here.
 *
 * ── The gate ─────────────────────────────────────────────────────────────────────────────────────
 * This is a BENCHMARK, not a unit test. The whole describe is skipped unless
 * `AGENTISTICS_BUDGETS=1`, so the pre-commit `bun test` (which runs on a machine that is busy with
 * everything else a developer is doing) never fails on a timing it cannot control. Run it with:
 *
 *     AGENTISTICS_BUDGETS=1 bun test packages/server/server/journal/journal-budget-append.test.ts
 *
 * ── What is measured, exactly ────────────────────────────────────────────────────────────────────
 * - A REAL bun:sqlite file on disk, opened through `openJournal` (so the pragmas, WAL and the
 *   transaction-per-batch are the journal's own), in a mkdtemp dir under `os.tmpdir()`.
 * - `Bun.nanoseconds()` immediately around `await j.append(batch)` and nothing else. `planAppend`
 *   runs inside `append`, so validation and row mapping ARE part of the measured cost. Building the
 *   events is the producer's cost and happens entirely BEFORE timing starts.
 * - 1000 batches of 100 unique events = 100k rows, so the table and its indexes GROW through the
 *   run; a p95 over an empty table would measure something adjacent.
 * - The FIRST batch after open COUNTS toward the asserted p95 — every process pays it once. It is
 *   also reported separately, with a p95 that excludes it.
 * - Every measured batch must report written === 100, duplicates === 0, rejected === [] — `append`
 *   never throws and a disabled journal is a fast no-op, so a run that did not check `written`
 *   would measure nothing and pass.
 * - No `Bun.gc()`, no pragma changes, WAL autocheckpoint left as the journal leaves it: checkpoint
 *   cost lands in the tail, and it belongs there.
 *
 * ── What is held constant / NOT covered ──────────────────────────────────────────────────────────
 * - Warm OS page cache: single process, file just created.
 * - No concurrent reader or writer.
 * - No crash-recovery path (the file is fresh, so `recoveryPending` is false).
 * - `synchronous = NORMAL`, as the journal sets it.
 * - One machine (measured on WSL2 ext4); the filesystem type of the temp dir and of the real
 *   JOURNAL_PATH's dir are both printed so the disk class held constant is stated, not assumed.
 * - Batch size exactly 100.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentisticsEvent } from '@agentistics/core'
import { JOURNAL_PATH } from '../config'
import { openJournal } from './journal'
import { planAppend } from './journal-plan'
import type { PathProbe } from './schema'
import type { Journal } from './types'

const BATCHES = 1000
const EVENTS_PER_BATCH = 100
const BUDGET_MS = 2

/** Every path classified as local ext4 — the journal must OPEN for the measurement to mean anything. */
function localProbe(mountinfo = '58 42 8:32 / / rw,relatime - ext4 /dev/sdc rw'): PathProbe {
  return {
    platform: 'linux',
    realpath: p => p,
    readMountinfo: () => mountinfo,
    readDarwinMounts: () => null,
  }
}

/** The filesystem type of `dir` (or its nearest existing ancestor), as the kernel names it. */
function fsTypeOf(dir: string): string {
  if (process.platform !== 'linux') return 'unknown'
  let d = dir
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d)
  try {
    const r = Bun.spawnSync(['stat', '-f', '-c', '%T', d])
    const out = r.stdout.toString().trim()
    return r.exitCode === 0 && out ? out : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Nearest-rank percentile: sort ascending, take index ceil(p*n)-1. */
function nearestRank(sortedAsc: readonly number[], p: number): number {
  const idx = Math.max(0, Math.ceil(p * sortedAsc.length) - 1)
  return sortedAsc[idx]!
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

// ── A realistic Claude-session event stream ──────────────────────────────────────────────────────

const BASE_MS = Date.UTC(2026, 8, 25, 8, 0, 0)
const MODELS = ['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const
const TOOLS = [
  { name: 'Bash', canonicalName: 'Bash', kind: 'shell' },
  { name: 'Read', canonicalName: 'Read', kind: 'file' },
  { name: 'Edit', canonicalName: 'Edit', kind: 'file' },
  { name: 'Grep', canonicalName: 'Grep', kind: 'search' },
  { name: 'mcp__db__query', canonicalName: 'mcp__db__query', kind: 'mcp' },
] as const

/** A deterministic, source-derived-looking id (the shape `deriveEventId` produces), unique per g. */
const eventIdOf = (g: number) => createHash('sha256').update(`bench:${g}`).digest('hex').slice(0, 32)

/**
 * Event g of the global stream. ~60 % `model.completed` with a full usage object, the rest tool
 * lifecycle plus the occasional session / run / context event. 50 sessions of 2000 events each,
 * `occurredAt` strictly monotonic (one per 250 ms).
 */
function eventAt(g: number): AgentisticsEvent {
  const sessionIdx = Math.floor(g / 2000)
  const sessionId = `bench-session-${sessionIdx}`
  const runId = `bench-run-${sessionIdx}`
  const agentId = `bench-agent-${sessionIdx}`
  const at = new Date(BASE_MS + g * 250).toISOString()
  const toolExecutionId = `bench-tool-${Math.floor(g / 20)}-${g % 5}`
  const tool = TOOLS[g % TOOLS.length]!
  const model = MODELS[sessionIdx % MODELS.length]!
  const slot = g % 20
  const common = {
    eventId: eventIdOf(g),
    schema: 1,
    occurredAt: at,
    recordedAt: at,
    sessionId,
    runId,
    agentId,
    source: { kind: 'harness' as const, id: 'claude', version: '2.1.263' },
    provenance: {
      mode: 'replayed' as const,
      confidence: 'exact' as const,
      adapterVersion: 'claude@1',
      sourceRef: `/home/u/.claude/projects/-home-u-repo/${sessionId}.jsonl:${g * 1873}`,
    },
  }
  const mk = (type: string, data: unknown): AgentisticsEvent =>
    ({ ...common, type, data } as unknown as AgentisticsEvent)

  if (slot < 12) {
    const input = 3 + (g % 17)
    const cacheRead = 40_000 + (g * 131) % 150_000
    const cacheWrite = 200 + (g * 37) % 4000
    return mk('model.completed', {
      providerRequestId: `msg_01${eventIdOf(g + 1_000_000).slice(0, 22)}`,
      provider: 'anthropic',
      model,
      usage: { input, output: 50 + (g * 7) % 2000, cacheRead, cacheWrite },
      contextTokens: input + cacheRead + cacheWrite,
      contextWindow: 200_000,
      costUSD: round3(0.001 + ((g * 13) % 1000) / 10_000),
      costSource: 'harness',
      latencyMs: 800 + (g * 29) % 12_000,
      status: 'completed',
    })
  }
  if (slot < 16) {
    return mk('tool.requested', {
      toolExecutionId,
      name: tool.name,
      canonicalName: tool.canonicalName,
      kind: tool.kind,
      ...(tool.kind === 'mcp' ? { mcpServer: 'db' } : {}),
      summary: tool.kind === 'shell' ? 'bun test packages/server' : `packages/server/server/f${g % 97}.ts`,
    })
  }
  if (slot < 19) {
    return mk('tool.completed', {
      toolExecutionId,
      ...(tool.name === 'Edit'
        ? { filesTouched: [`packages/server/server/f${g % 97}.ts`], linesAdded: g % 40, linesRemoved: g % 11 }
        : {}),
      durationMs: 20 + (g * 3) % 5000,
    })
  }
  // slot 19: rotate through the rarer lifecycle events.
  switch (Math.floor(g / 20) % 5) {
    case 0: return mk('session.started', { origin: 'adapter', title: `bench ${sessionIdx}`, projectPath: '/home/u/repo', repoKey: 'github.com/org/repo' })
    case 1: return mk('run.started', { harness: 'claude', harnessVersion: '2.1.263', conversationId: sessionId, conversationLink: 'observed', cwd: '/home/u/repo' })
    case 2: return mk('tool.failed', { toolExecutionId, status: 'failed', errorClass: 'exit-nonzero', exitCode: 1 })
    case 3: return mk('context.window.observed', { contextTokens: 120_000 + g % 50_000, contextWindow: 200_000, model })
    default: return mk('agent.started', { kind: 'subagent', agentType: 'general-purpose', description: 'bench', model })
  }
}

// ── The benchmark ────────────────────────────────────────────────────────────────────────────────

describe.skipIf(process.env.AGENTISTICS_BUDGETS !== '1')('journal append budget (P1 §9)', () => {
  let root = ''
  let j: Journal | null = null

  afterAll(() => {
    try { j?.close() } catch { /* already closed */ }
    if (root) rmSync(root, { recursive: true, force: true })
  })

  test(`p95 of ${BATCHES} batches × ${EVENTS_PER_BATCH} events ≤ ${BUDGET_MS} ms`, async () => {
    // Every batch is built BEFORE timing starts — constructing events is the producer's cost.
    const batches: AgentisticsEvent[][] = []
    for (let b = 0; b < BATCHES; b++) {
      const batch: AgentisticsEvent[] = []
      for (let k = 0; k < EVENTS_PER_BATCH; k++) batch.push(eventAt(b * EVENTS_PER_BATCH + k))
      batches.push(batch)
    }
    // Every event must pass the plan, or the batch would be measured on a shorter write.
    for (const batch of batches) {
      const plan = planAppend(batch)
      expect(plan.rejected).toEqual([])
      expect(plan.rows.length).toBe(EVENTS_PER_BATCH)
    }
    // Uniqueness: a duplicate would take the cheaper IGNORE path.
    expect(new Set(batches.flat().map(e => e.eventId)).size).toBe(BATCHES * EVENTS_PER_BATCH)

    root = mkdtempSync(join(tmpdir(), 'agentistics-journal-budget-'))
    const path = join(root, 'journal.db')
    j = await openJournal({ path, probe: localProbe() })
    expect(j.status().state).toBe('open')

    const timings: number[] = []
    for (const batch of batches) {
      const t0 = Bun.nanoseconds()
      const res = await j.append(batch)
      const t1 = Bun.nanoseconds()
      timings.push((t1 - t0) / 1e6)
      // A batch that wrote fewer than 100 invalidates the run.
      expect(res.written).toBe(EVENTS_PER_BATCH)
      expect(res.duplicates).toBe(0)
      expect(res.rejected.length).toBe(0)
    }

    const firstMs = timings[0]!
    const all = [...timings].sort((a, b) => a - b)
    const exclFirst = timings.slice(1).sort((a, b) => a - b)
    const p95Ms = nearestRank(all, 0.95)
    const stats = await j.stats()
    const pass = p95Ms <= BUDGET_MS

    console.log('JOURNAL_APPEND_BUDGET ' + JSON.stringify({
      batches: BATCHES,
      eventsPerBatch: EVENTS_PER_BATCH,
      firstMs: round3(firstMs),
      p50Ms: round3(nearestRank(all, 0.5)),
      p95Ms: round3(p95Ms),
      p95ExclFirstMs: round3(nearestRank(exclFirst, 0.95)),
      p99Ms: round3(nearestRank(all, 0.99)),
      maxMs: round3(all[all.length - 1]!),
      budgetMs: BUDGET_MS,
      pass,
      fsType: fsTypeOf(root),
      journalPathFsType: fsTypeOf(dirname(JOURNAL_PATH)),
      rowsAtEnd: stats.rows,
      bun: Bun.version,
      heldConstant: 'warm page cache; single process; no concurrent reader/writer; no crash recovery; synchronous=NORMAL; batch=100; one machine',
    }))

    expect(stats.rows).toBe(BATCHES * EVENTS_PER_BATCH)
    expect(p95Ms).toBeLessThanOrEqual(BUDGET_MS)
  }, 120_000)
})
