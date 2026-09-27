/**
 * scripts/parity-matrix.test.ts — runs the REAL script (`bun packages/server/scripts/
 * parity-matrix.ts`) as a CHILD PROCESS, exactly the way a person or CI invokes it, over the
 * checked-in fixtures — never in-process, for the same reason `config-datadir.test.ts` does: the
 * script mutates `process.env.HOME` (and every per-harness `<HARNESS>_DIR`) at module load as its
 * own safety guard, and `config.ts` is very likely already imported (and its per-harness constants
 * already evaluated) by an earlier test file in this same `bun test` run — an in-process import
 * would either do nothing observable or, worse, leak the override into every OTHER test file that
 * imports `config.ts` afterwards in the same process. A child process is the only faithful way to
 * exercise the real guard.
 *
 * "asserts zero regressions" is a statement about TODAY's fixtures, proven per-harness by every
 * `differential-<harness>.test.ts` already in this directory; if a genuine regression ever appears
 * here it must be reported, never quietly relaxed into a passing assertion — see CLAUDE.md's rule
 * on `bun test` measuring a tree someone else is mutating, applied to a real finding instead: a red
 * assertion here is real work for a human, not a fixture to adjust.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'parity-matrix.ts')

async function runScript(outDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', SCRIPT, '--out', outDir], {
    stdout: 'pipe',
    stderr: 'pipe',
    // No env override here on purpose: the script's OWN internal guard is exactly what is under
    // test, and it must behave correctly starting from this process's ordinary environment.
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, stdout, stderr }
}

describe('the real parity-matrix runner over the checked-in fixtures', () => {
  test('exits 0, writes both files, and every row is equal or explained — never a regression', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'parity-matrix-test-'))
    try {
      const { code, stdout } = await runScript(outDir)

      const jsonText = await readFile(join(outDir, 'parity-matrix.json'), 'utf-8')
      const mdText = await readFile(join(outDir, 'parity-matrix.md'), 'utf-8')
      const matrix = JSON.parse(jsonText) as { rows: { harness: string; metric: string; status: string; reason?: string; legacyValue: unknown; projectedValue: unknown; bugSessions?: string[] }[] }

      console.log(`parity matrix size: ${matrix.rows.length} rows`)
      console.log(stdout.trim())

      const regressions = matrix.rows.filter(r => r.status === 'regression')
      if (regressions.length > 0) {
        // Per the task's own instruction: do NOT paper over a genuine regression by loosening this
        // assertion. Report it in full so it reaches whoever reads the failing test.
        console.error('GENUINE REGRESSION(S) FOUND — reported, not silenced:')
        for (const r of regressions) {
          console.error(`  ${r.harness}/${r.metric}: legacy=${JSON.stringify(r.legacyValue)} projected=${JSON.stringify(r.projectedValue)} sessions=${(r.bugSessions ?? []).join(',')}`)
        }
      }
      expect(regressions).toEqual([])

      expect(code).toBe(0)
      expect(matrix.rows.length).toBeGreaterThan(0)
      expect(mdText).toContain('| harness | metric |')
      expect(mdText).toContain('regression: 0')

      // Every declared harness in HARNESS_ORDER contributed at least one row (its own comparisons,
      // or at minimum its declared-unsupported capability rows).
      for (const harness of ['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode']) {
        expect(matrix.rows.some(r => r.harness === harness)).toBe(true)
      }

      // Every non-equal row must carry a reason — the generator's own invariant, re-checked here
      // against the REAL fixture run rather than only against hand-built input (parity-matrix.test.ts).
      for (const r of matrix.rows) {
        if (r.status !== 'equal') expect(r.reason).toBeTruthy()
      }
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  }, 60_000)

  test('the kimi "subagent" fixture is INCLUDED, and its subagent rows are settled with a reason, never a regression', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'parity-matrix-test-'))
    try {
      await runScript(outDir)
      const matrix = JSON.parse(await readFile(join(outDir, 'parity-matrix.json'), 'utf-8')) as {
        rows: { harness: string; metric: string; status: string; reason?: string }[]
      }
      const kimi = matrix.rows.filter(r => r.harness === 'kimi')
      // Only the two-agent fixture produces agentMetrics rows for kimi; their presence proves it ran.
      const agentRows = kimi.filter(r => r.metric.startsWith('agentMetrics.'))
      const explained = agentRows.filter(r => r.status === 'explained')
      expect(explained.length).toBeGreaterThan(0)
      for (const r of explained) expect(r.reason ?? '').toContain('ALREADY in the session totals')
      expect(kimi.filter(r => r.status === 'regression')).toEqual([])
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  }, 60_000)
})
