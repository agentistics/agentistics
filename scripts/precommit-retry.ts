/**
 * precommit-retry.ts — PURE: decide whether a failed pre-commit test run earns ONE isolated retry.
 *
 * Under load, the full suite (~25k tests) fails a different handful of timing-sensitive tests on
 * each run (5 s timeouts, slow child processes, "too many open files"); every one of them passes
 * alone. One such failure threw away a 25–30 minute run. The hook now reads the run's JUnit report,
 * re-runs only the failed FILES, one at a time, and accepts the commit only if every one of them
 * passes alone. Anything it cannot attribute to a file — a crash with no report, an error outside
 * any test, too many failing files to be load noise — fails exactly as before. Typecheck failures
 * never reach this module.
 */

/** More failing files than this is a real break, not load noise: no retry. */
export const MAX_RETRY_FILES = 8

/** Files of every <testcase> that carries a <failure> or <error>, in report order, deduplicated. */
export function failingFiles(junitXml: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
  for (let m = caseRe.exec(junitXml); m; m = caseRe.exec(junitXml)) {
    const body = m[3] ?? ''
    if (!/<(failure|error)\b/.test(body)) continue
    const file = /\bfile="([^"]+)"/.exec(m[1] ?? '')?.[1]
    if (file && !seen.has(file)) { seen.add(file); out.push(file) }
  }
  return out
}

/** Failures the report counts at the top level (`<testsuites failures="N" errors="M">`); null when absent. */
export function reportedFailures(junitXml: string): number | null {
  const top = /<testsuites\b([^>]*)>/.exec(junitXml)?.[1]
  if (!top) return null
  const n = (k: string) => Number(new RegExp(`\\b${k}="(\\d+)"`).exec(top)?.[1] ?? 0)
  return n('failures') + n('errors')
}

/**
 * What Bun's own console summary says: ` N fail`, ` N error(s)` and any "Unhandled error between
 * tests". The JUnit report leaves out an error thrown OUTSIDE every test (a module that fails to
 * import, say), so the console is the only place that error shows; `fail` null = no summary seen.
 */
export function consoleSummary(text: string): { fail: number | null; errors: number } {
  // The LAST match: Bun's summary is printed last, and a test may print a look-alike line earlier.
  const last = (re: RegExp) => [...text.matchAll(re)].at(-1)
  const fail = last(/^\s*(\d+) fail\s*$/gm)
  const err = last(/^\s*(\d+) errors?\s*$/gm)
  const unhandled = /Unhandled error/i.test(text) ? 1 : 0
  return { fail: fail ? Number(fail[1]) : null, errors: Math.max(err ? Number(err[1]) : 0, unhandled) }
}

export type RetryDecision =
  | { kind: 'pass' }
  | { kind: 'retry'; files: string[] }
  | { kind: 'fail'; reason: string }

/**
 * `exitCode` is the suite's; `junitXml` its report and `consoleText` (the tail of) its console
 * output — each null when missing. Only failures the REPORT attributes to test files are retried;
 * an error outside any test, a console count the report does not match, or a missing piece of
 * evidence fails at once: it is not a flaky test.
 */
export function decideRetry(exitCode: number, junitXml: string | null, consoleText: string | null): RetryDecision {
  if (exitCode === 0) return { kind: 'pass' }
  if (junitXml === null) return { kind: 'fail', reason: 'no test report was written' }
  if (consoleText === null) return { kind: 'fail', reason: 'no console summary to check the report against' }
  const sum = consoleSummary(consoleText)
  if (sum.errors > 0) return { kind: 'fail', reason: `${sum.errors} error(s) outside any test` }
  const reported = reportedFailures(junitXml)
  if (sum.fail === null || reported === null) return { kind: 'fail', reason: 'the run ended without a test summary' }
  if (sum.fail > reported) return { kind: 'fail', reason: `${sum.fail} failures on the console but ${reported} in the report` }
  const files = failingFiles(junitXml)
  if (files.length === 0) return { kind: 'fail', reason: 'the run failed outside any test (no failing test in the report)' }
  if (files.length > MAX_RETRY_FILES) return { kind: 'fail', reason: `${files.length} files failed (more than ${MAX_RETRY_FILES}): not load noise` }
  return { kind: 'retry', files }
}

/** The first, full run: exit code, its JUnit report and the tail of its console (null = missing). */
export interface FirstRun { code: number; report: string | null; console: string | null }

export interface RetryIO {
  /** Runs `bun test <args>` (one failed file, alone); returns the exit code. */
  runTests(args: string[]): number
  log(line: string): void
}

/**
 * Given the first run, re-runs each failed file once ALONE when `decideRetry` allows it.
 * `ok` = the commit may proceed; `flaky` = the files that failed together but passed alone.
 */
export function runWithRetry(first: FirstRun, io: RetryIO): { ok: boolean; flaky: string[] } {
  const decision = decideRetry(first.code, first.report, first.console)
  if (decision.kind === 'pass') return { ok: true, flaky: [] }
  if (decision.kind === 'fail') { io.log(`[pre-commit] tests failed; no retry: ${decision.reason}`); return { ok: false, flaky: [] } }
  io.log(`[pre-commit] retrying ${decision.files.length} failed file(s) once, each alone: ${decision.files.join(', ')}`)
  const still = decision.files.filter(f => io.runTests([`./${f}`]) !== 0)
  if (still.length > 0) { io.log(`[pre-commit] failed again alone: ${still.join(', ')}`); return { ok: false, flaky: [] } }
  io.log(`[pre-commit] flaky (passed alone): ${decision.files.join(', ')}`)
  return { ok: true, flaky: decision.files }
}
