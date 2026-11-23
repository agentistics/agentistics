import { describe, expect, test } from 'bun:test'
import { consoleSummary, decideRetry, failingFiles, MAX_RETRY_FILES, reportedFailures, runWithRetry, type RetryIO } from './precommit-retry'

const report = (cases: string, top = 'failures="1" skipped="0"') => `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" ${top}>
  <testsuite name="a.test.ts" file="a.test.ts" tests="2" failures="1">
${cases}
  </testsuite>
</testsuites>`

const con = (fail: number, extra = '') => `${extra}\n 10 pass\n ${fail} fail\n Ran 12 tests across 3 files.`

const ok = (file: string) => `<testcase name="ok" classname="" time="0.1" file="${file}" line="2" assertions="1" />`
const bad = (file: string, tag = 'failure') => `<testcase name="bad" classname="" time="5" file="${file}" line="9" assertions="1">
      <${tag} type="AssertionError" />
    </testcase>`

describe('failingFiles', () => {
  test('lists the files of failing testcases only, deduplicated, in order', () => {
    const xml = report([ok('a.test.ts'), bad('b.test.ts'), bad('c.test.ts', 'error'), bad('b.test.ts'), ok('d.test.ts')].join('\n'))
    expect(failingFiles(xml)).toEqual(['b.test.ts', 'c.test.ts'])
  })
  test('nested describe suites still attribute the file', () => {
    const xml = `<testsuites failures="1"><testsuite name="x.test.ts" file="x.test.ts"><testsuite name="group">${bad('x.test.ts')}</testsuite></testsuite></testsuites>`
    expect(failingFiles(xml)).toEqual(['x.test.ts'])
  })
  test('a clean report has none', () => {
    expect(failingFiles(report(ok('a.test.ts'), 'failures="0"'))).toEqual([])
  })
})

describe('reportedFailures', () => {
  test('sums failures and errors at the top', () => {
    expect(reportedFailures(report('', 'failures="2" errors="1"'))).toBe(3)
  })
  test('null without a <testsuites> element', () => {
    expect(reportedFailures('garbage')).toBeNull()
  })
})

describe('consoleSummary', () => {
  test('reads fail and error counts from Bun\'s summary', () => {
    expect(consoleSummary(' 4 pass\n 4 fail\n 1 error\n')).toEqual({ fail: 4, errors: 1 })
  })
  test('an "Unhandled error between tests" counts as an error even without the count line', () => {
    expect(consoleSummary('# Unhandled error between tests\n 1 fail\n').errors).toBe(1)
  })
  test('QA r2: a look-alike line printed by a test does not shadow the real summary', () => {
    expect(consoleSummary(' 0 fail\n 0 error\nnoise\n 3 pass\n 2 fail\n 1 error\n')).toEqual({ fail: 2, errors: 1 })
  })
  test('no summary at all = fail null', () => {
    expect(consoleSummary('crashed').fail).toBeNull()
  })
})

describe('decideRetry', () => {
  const two = () => report([bad('p.test.ts'), bad('q.test.ts')].join('\n'), 'failures="2"')
  test('exit 0 passes without reading anything', () => {
    expect(decideRetry(0, null, null)).toEqual({ kind: 'pass' })
  })
  test('a failure with no report is not retried', () => {
    expect(decideRetry(1, null, con(1)).kind).toBe('fail')
  })
  test('a failure with no console summary is not retried', () => {
    expect(decideRetry(1, two(), null).kind).toBe('fail')
    expect(decideRetry(1, two(), 'killed').kind).toBe('fail')
  })
  test('QA r1: an error outside any test blocks even when other files failed attributably', () => {
    expect(decideRetry(1, two(), con(2, '# Unhandled error between tests\n') + '\n 1 error').kind).toBe('fail')
  })
  test('more failures on the console than in the report blocks', () => {
    expect(decideRetry(1, two(), con(3)).kind).toBe('fail')
  })
  test('a failure outside any test is not retried', () => {
    expect(decideRetry(1, report(ok('a.test.ts'), 'failures="0"'), con(0)).kind).toBe('fail')
  })
  test('a few failing files earn one retry of exactly those files', () => {
    expect(decideRetry(1, two(), con(2))).toEqual({ kind: 'retry', files: ['p.test.ts', 'q.test.ts'] })
  })
  test('more than the cap is a real break', () => {
    const n = MAX_RETRY_FILES + 1
    const many = Array.from({ length: n }, (_, i) => bad(`f${i}.test.ts`)).join('\n')
    expect(decideRetry(1, report(many, `failures="${n}"`), con(n)).kind).toBe('fail')
  })
  test('exactly the cap is still retried', () => {
    const n = MAX_RETRY_FILES
    const cap = Array.from({ length: n }, (_, i) => bad(`f${i}.test.ts`)).join('\n')
    expect(decideRetry(1, report(cap, `failures="${n}"`), con(n)).kind).toBe('retry')
  })
})

describe('runWithRetry', () => {
  const io = (codes: Record<string, number>) => {
    const calls: string[][] = []
    const lines: string[] = []
    const r: RetryIO = { runTests: a => { calls.push(a); return codes[a.join(' ')] ?? 0 }, log: l => lines.push(l) }
    return { r, calls, lines }
  }
  const two = () => report([bad('p.test.ts'), bad('q.test.ts')].join('\n'), 'failures="2"')
  test('a green first run is not retried', () => {
    const { r, calls } = io({})
    expect(runWithRetry({ code: 0, report: null, console: null }, r)).toEqual({ ok: true, flaky: [] })
    expect(calls).toEqual([])
  })
  test('failed files that pass alone let the commit through and are reported flaky', () => {
    const { r, calls, lines } = io({})
    expect(runWithRetry({ code: 1, report: two(), console: con(2) }, r)).toEqual({ ok: true, flaky: ['p.test.ts', 'q.test.ts'] })
    expect(calls).toEqual([['./p.test.ts'], ['./q.test.ts']])
    expect(lines.at(-1)).toContain('flaky (passed alone)')
  })
  test('a file that fails again alone blocks the commit', () => {
    const { r } = io({ './q.test.ts': 1 })
    expect(runWithRetry({ code: 1, report: two(), console: con(2) }, r).ok).toBe(false)
  })
  test('an unattributable failure blocks without any retry', () => {
    const { r, calls } = io({})
    expect(runWithRetry({ code: 1, report: two(), console: con(2, '# Unhandled error between tests') }, r).ok).toBe(false)
    expect(calls).toEqual([])
  })
})
