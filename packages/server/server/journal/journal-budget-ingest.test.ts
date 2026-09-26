/**
 * journal-budget-ingest.test.ts — MEASURES the ingest half of the P1 spec §9:
 *
 *     shadow ingestion added to a full `buildApiResponse` ≤ 10 % of the current build time on this
 *     machine's store.
 *
 * A BENCHMARK, not a unit test: it runs several full builds over the REAL `~/.claude` store (read
 * only) and takes minutes. The whole describe is skipped unless `AGENTISTICS_BUDGETS=1`:
 *
 *     AGENTISTICS_BUDGETS=1 bun test packages/server/server/journal/journal-budget-ingest.test.ts
 *
 * ── The method (A2.3 / A2.5's, made rerunnable) ─────────────────────────────────────────────────
 * - **A fresh process per build** (`journal-budget-ingest.child.ts`): `config.ts` reads the flag and
 *   both directories at import, and a second build in one process would inherit the first one's
 *   parse caches and replay walks — which is exactly the cost being measured.
 * - **An isolated `AGENTISTICS_DIR`** under the OS temp dir, shared by every run of one invocation
 *   (the consolidate store it writes is the build's own business, and sharing it keeps flag-off and
 *   flag-on builds comparable). Never `~/.agentistics`.
 * - **An isolated `AGENTISTICS_JOURNAL_DIR`**: `on-first` gets a new, EMPTY one — the first ingest,
 *   the case that missed — and `on-steady` reuses the last one, the case every later build pays.
 * - The flag `AGENTISTICS_JOURNAL` off or on. The real store is never written: `CLAUDE_DIR` is not
 *   overridden and nothing in the build or the shadow writes under it.
 * - The first run of the default plan is a flag-off build into the EMPTY data dir (`warm`): it pays
 *   the persistent parse cache (`cache.db`), the git-stats cache and the consolidate store from
 *   nothing, plus the OS page cache's first read of the store. Every later build finds those caches
 *   filled and is an order of magnitude cheaper (measured after a reboot on 2026-09-26: ~37–45 s
 *   cold against ~1.7–2.6 s warm). BOTH are "a full `buildApiResponse`", so both denominators are
 *   printed: `vs cold` against that first build, `vs warm` against the median later flag-off build.
 *   The assertion uses the WARM median — the build a machine that turns the flag on actually runs,
 *   since its cache is already filled — which is the stricter reading.
 *
 * `INGEST_BENCH_PLAN` overrides the sequence (comma-separated `off` / `on-first` / `on-steady`; a
 * leading `warm` is the excluded warm-up). The load average is printed beside every run: this
 * machine usually runs other sessions, and a number taken at load 8 is not the number taken at 2.
 *
 * ── What is compared ─────────────────────────────────────────────────────────────────────────────
 * The budget is read as `first-ingest shadow ms / median flag-off build ms`. The shadow is NOT
 * awaited by the build, so the flag-on build's own figure is printed too but is not the denominator:
 * it is the same build plus whatever the shadow's start-up cost it. The shadow's figure is its own
 * `ms` from the status file (`ShadowRun`), i.e. what `agentop journal status` reports on a live
 * machine, not a number this file invents.
 *
 * A missed budget is REPORTED and fails the test; nothing here is tuned to make it pass.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShadowRun } from './shadow'

const CHILD = join(import.meta.dir, 'journal-budget-ingest.child.ts')
const BUDGET = 0.10
const DEFAULT_PLAN = 'warm,off,on-first,on-steady,off,on-first'

type Step = 'warm' | 'off' | 'on-first' | 'on-steady'

interface ChildOut {
  flag: boolean
  buildMs: number
  sessions: number
  shadow: ShadowRun | 'timeout' | null
  shadowTailMs: number
}

interface RunRow extends ChildOut {
  step: Step
  load: string
}

function runChild(env: Record<string, string | undefined>): ChildOut {
  const proc = Bun.spawnSync(['bun', CHILD], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = proc.stdout.toString()
  const line = out.split('\n').find(l => l.startsWith('INGEST_BENCH '))
  if (!line) throw new Error(`child produced no result (exit ${proc.exitCode}): ${proc.stderr.toString().slice(-2000)}`)
  return JSON.parse(line.slice('INGEST_BENCH '.length)) as ChildOut
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? NaN : s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

const pct = (a: number, b: number): string => `${((100 * a) / b).toFixed(1)} %`

describe.skipIf(process.env.AGENTISTICS_BUDGETS !== '1')('shadow ingest budget (P1 §9)', () => {
  test('first ingest ≤ 10 % of a flag-off build', () => {
    const plan = (process.env.INGEST_BENCH_PLAN ?? DEFAULT_PLAN).split(',').map(s => s.trim()) as Step[]
    const root = mkdtempSync(join(tmpdir(), 'agentistics-ingest-budget-'))
    const dataDir = join(root, 'data')
    let journalDir: string | null = null
    let journals = 0
    const rows: RunRow[] = []
    try {
      for (const step of plan) {
        if (!['warm', 'off', 'on-first', 'on-steady'].includes(step)) throw new Error(`unknown step ${step}`)
        if (step === 'on-first' || (step === 'on-steady' && journalDir === null)) journalDir = join(root, `journal-${++journals}`)
        const load = loadavg().map(n => n.toFixed(2)).join(' ')
        const on = step === 'on-first' || step === 'on-steady'
        const out = runChild({
          AGENTISTICS_DIR: dataDir,
          AGENTISTICS_JOURNAL_DIR: journalDir ?? join(root, 'journal-unused'),
          AGENTISTICS_JOURNAL: on ? '1' : '0',
        })
        const row: RunRow = { step, load, ...out }
        rows.push(row)
        console.log('INGEST_BUDGET_RUN ' + JSON.stringify(row))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    const offMs = rows.filter(r => r.step === 'off').map(r => r.buildMs)
    const firsts = rows.filter(r => r.step === 'on-first' && r.shadow && r.shadow !== 'timeout')
    const baseline = median(offMs)
    console.log('\n| run | load 1/5/15 | build ms | shadow ms | scan / replay / append ms | sources | skipped | events | written | dup | rejected | dropped | shadow / median off |')
    console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const r of rows) {
      const s = r.shadow && r.shadow !== 'timeout' ? r.shadow : null
      console.log(`| ${r.step} | ${r.load} | ${r.buildMs} | ${s ? s.ms : r.shadow === 'timeout' ? 'TIMEOUT' : '—'} | ${s?.phases ? `${s.phases.scanMs} / ${s.phases.replayMs} / ${s.phases.appendMs}` : '—'} | ${s?.sources ?? '—'} | ${s?.skipped ?? '—'} | ${s?.events ?? '—'} | ${s?.written ?? '—'} | ${s?.duplicates ?? '—'} | ${s?.rejected ?? '—'} | ${s?.dropped ?? '—'} | ${s ? pct(s.ms, baseline) : '—'} |`)
    }
    const worstFirst = Math.max(...firsts.map(r => (r.shadow as ShadowRun).ms))
    const cold = rows.find(r => r.step === 'warm')?.buildMs
    console.log('INGEST_BUDGET ' + JSON.stringify({
      coldBuildMs: cold ?? null,
      worstFirstShareVsCold: cold ? worstFirst / cold : null,
      medianOffBuildMs: Math.round(baseline),
      firstIngestMs: firsts.map(r => (r.shadow as ShadowRun).ms),
      worstFirstShare: worstFirst / baseline,
      budget: BUDGET,
      pass: worstFirst / baseline <= BUDGET,
      bun: Bun.version,
    }))

    expect(offMs.length).toBeGreaterThan(0)
    expect(firsts.length).toBeGreaterThan(0)
    for (const r of firsts) expect((r.shadow as ShadowRun).rejected).toBe(0)
    expect(worstFirst / baseline).toBeLessThanOrEqual(BUDGET)
  }, 60 * 60_000)
})
