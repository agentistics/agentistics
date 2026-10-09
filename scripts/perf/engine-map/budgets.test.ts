import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { annotations, BENCH_HARNESSES, coverageAnnotations, evaluate, exitCode, harnessCoverage, measure, renderBudgets, renderCoverage, rowOf, type BenchResult, type Budgets } from './budgets.ts'

const row = (n: number, c: number, o: Partial<import('./budgets.ts').BenchRow> = {}) => ({ n, c, cpuSelf: 0.2, cpuChildren: 0.1, tmuxPerMin: 12, fleetKB: 3, ...o })

/** What `PLAN=quick` produces: N=0; N=1 C=1; N=10 C=0/1/5 — no N=50, no soak. */
const quick: BenchResult = {
  rows: [
    row(0, 0, { fleetKB: 0.4 }),
    row(1, 1, { sendEchoP95: 300, answerLagP95: 200, switchFirstP95: 120 }),
    row(10, 0, { cpuSelf: 0.6, cpuChildren: 0.2 }),
    row(10, 1, { cpuSelf: 1.4, cpuChildren: 0.4, sendEchoP95: 410, answerLagP95: 250, switchFirstP95: 300 }),
    row(10, 5, { cpuSelf: 4.0, cpuChildren: 1.0, sendEchoP95: 480, answerLagP95: 280, switchFirstP95: 390, fleetKB: 18 }),
  ],
}

const budgets: Budgets = {
  switchFirstP95Ms: { label: 'switch', max: 400, level: 'warn', unit: 'ms' },
  sendToEchoP95Ms: { label: 'echo', max: 500, level: 'warn', unit: 'ms' },
  writeToShownP95Ms: { label: 'shown', max: 300, level: 'warn', unit: 'ms' },
  idleCpuPct: { label: 'idle', max: 1, level: 'warn', unit: '%' },
  perClientCpuPct: { label: 'per client', max: 1, level: 'warn', unit: '%' },
  tmuxPerMinN50: { label: 'tmux', max: 60, level: 'warn', unit: '/min' },
  fleetFirstFrameKB: { label: 'fleet kb', max: 50, level: 'warn', unit: 'KB' },
  soakSlopeMBh: { label: 'soak', max: 5, level: 'warn', unit: 'MB/h' },
}

describe('measure', () => {
  test('reads each budget off the busiest probed N=10 condition', () => {
    const m = measure(quick)
    expect(m.switchFirstP95Ms!.value).toBe(390)
    expect(m.sendToEchoP95Ms!.value).toBe(480)
    expect(m.writeToShownP95Ms!.value).toBe(280)
    expect(m.fleetFirstFrameKB!.value).toBe(18)
  })
  test('idle CPU is own + children at N=10, C=0', () => {
    expect(measure(quick).idleCpuPct!.value).toBe(0.8)
  })
  test('per-client CPU is the added CPU divided by the number of clients', () => {
    // (4.0 + 1.0) - (0.6 + 0.2) = 4.2 over 5 clients
    expect(measure(quick).perClientCpuPct!.value).toBe(0.8)
  })
  test('per-client CPU never goes negative on noise', () => {
    const r: BenchResult = { rows: [row(10, 0, { cpuSelf: 2 }), row(10, 5, { cpuSelf: 1, cpuChildren: 0.1 })] }
    expect(measure(r).perClientCpuPct!.value).toBe(0)
  })
  test('a plan that stopped at N=10 does not claim the N=50 tmux budget', () => {
    const m = measure(quick)
    expect(m.tmuxPerMinN50!.value).toBeNull()
    expect(m.tmuxPerMinN50!.note).toContain('N=10')
  })
  test('the N=50 tmux budget reads the C=1 row of the biggest fleet', () => {
    const r: BenchResult = { rows: [...quick.rows, row(50, 1, { tmuxPerMin: 44 }), row(50, 5, { tmuxPerMin: 900 })] }
    expect(measure(r).tmuxPerMinN50!.value).toBe(44)
  })
  test('no soak means no slope, not a slope of zero', () => {
    expect(measure(quick).soakSlopeMBh!.value).toBeNull()
    expect(measure({ ...quick, soak: { slopeMBh: 2.5 } }).soakSlopeMBh!.value).toBe(2.5)
  })
  test('an empty result measures nothing and throws nothing', () => {
    const m = measure({ rows: [] })
    for (const v of Object.values(m)) expect(v.value).toBeNull()
  })
  test('NaN (a probe that never answered) is not a measurement', () => {
    const r: BenchResult = { rows: [row(10, 5, { sendEchoP95: NaN, answerLagP95: NaN, switchFirstP95: NaN })] }
    expect(measure(r).sendToEchoP95Ms!.value).toBeNull()
  })
  test('rowOf finds an exact condition', () => {
    expect(rowOf(quick.rows, 10, 1)?.sendEchoP95).toBe(410)
    expect(rowOf(quick.rows, 50, 1)).toBeUndefined()
  })
})

describe('evaluate', () => {
  test('over, ok and skipped are three different verdicts', () => {
    const r = evaluate(quick, budgets)
    const by = Object.fromEntries(r.map(x => [x.key, x.verdict]))
    expect(by.switchFirstP95Ms).toBe('ok')
    expect(by.idleCpuPct).toBe('ok')
    expect(by.tmuxPerMinN50).toBe('skipped')
    expect(by.soakSlopeMBh).toBe('skipped')
    const worse = evaluate({ ...quick, soak: { slopeMBh: 9 } }, budgets).find(x => x.key === 'soakSlopeMBh')!
    expect(worse.verdict).toBe('over')
  })
  test('a ceiling is inclusive', () => {
    const r: BenchResult = { rows: [row(10, 5, { sendEchoP95: 500 })] }
    expect(evaluate(r, budgets).find(x => x.key === 'sendToEchoP95Ms')!.verdict).toBe('ok')
  })
})

describe('level', () => {
  const over: BenchResult = { rows: [row(10, 5, { sendEchoP95: 9000 })] }
  test('warn: reported as a warning annotation, exit code 0', () => {
    const r = evaluate(over, budgets)
    expect(exitCode(r)).toBe(0)
    expect(annotations(r).some(a => a.startsWith('::warning '))).toBe(true)
    expect(annotations(r).some(a => a.startsWith('::error '))).toBe(false)
  })
  test('fail: the same number is an error annotation and exit code 1', () => {
    const r = evaluate(over, { ...budgets, sendToEchoP95Ms: { ...budgets.sendToEchoP95Ms!, level: 'fail' } })
    expect(exitCode(r)).toBe(1)
    expect(annotations(r).some(a => a.startsWith('::error '))).toBe(true)
  })
  test('a skipped fail-level budget does not fail the run', () => {
    const r = evaluate(quick, { ...budgets, soakSlopeMBh: { ...budgets.soakSlopeMBh!, level: 'fail' } })
    expect(exitCode(r)).toBe(0)
  })
})

describe('tolerance', () => {
  const failing: Budgets = { ...budgets, sendToEchoP95Ms: { ...budgets.sendToEchoP95Ms!, level: 'fail' } }
  test('inside max × 1.1 is "near": a warning, never a failure', () => {
    const r = evaluate({ rows: [row(10, 5, { sendEchoP95: 540 })] }, failing)
    expect(r.find(x => x.key === 'sendToEchoP95Ms')!.verdict).toBe('near')
    expect(exitCode(r)).toBe(0)
    expect(annotations(r).some(a => a.startsWith('::warning ') && a.includes('tolerance'))).toBe(true)
  })
  test('the ceiling itself passes, one past it fails', () => {
    expect(exitCode(evaluate({ rows: [row(10, 5, { sendEchoP95: 550 })] }, failing))).toBe(0)
    expect(exitCode(evaluate({ rows: [row(10, 5, { sendEchoP95: 551 })] }, failing))).toBe(1)
  })
  test('a budget may set its own tolerance', () => {
    const tight: Budgets = { ...failing, sendToEchoP95Ms: { ...failing.sendToEchoP95Ms!, tolerance: 0 } }
    expect(exitCode(evaluate({ rows: [row(10, 5, { sendEchoP95: 501 })] }, tight))).toBe(1)
  })
})

describe('renderBudgets', () => {
  test('says "not measured" rather than a number for a skipped budget', () => {
    const md = renderBudgets(evaluate(quick, budgets))
    expect(md).toContain('not measured')
    expect(md).toContain('| switch |')
  })
})

describe('the shipped budgets.json', () => {
  test('every engineMap budget is measured by measure() and has a valid level', async () => {
    const all = await Bun.file(`${import.meta.dir}/../budgets.json`).json() as { engineMap: Budgets }
    const known = Object.keys(measure({ rows: [] }))
    for (const [key, def] of Object.entries(all.engineMap)) {
      expect(known).toContain(key)
      expect(def.level).toBe('fail') // F4.B: the budgets are failures, not warnings
      expect(def.max).toBeGreaterThan(0)
    }
    expect(Object.keys(all.engineMap).sort()).toEqual([...known].sort())
  })
})

describe('harnessCoverage', () => {
  const ph = (o: Partial<{ linked: boolean; echo: number | null; shown: number | null }> = {}) => ({ linked: true, ack: 'ok', sendAck: 10, echo: 100, shown: 100, idle: 1000, chatGetMs: 5, chatKB: 1, ...o })
  const full = Object.fromEntries(BENCH_HARNESSES.map(h => [h, ph()]))
  const with_ = (perHarness: Record<string, ReturnType<typeof ph>>): BenchResult => ({ rows: [row(10, 5, { perHarness })] })

  test('a fleet where all six answer has no findings', () => {
    expect(harnessCoverage(with_(full))).toEqual([])
    expect(renderCoverage([])).toContain('Every harness')
  })
  test('names the harness that is missing, unlinked, or never answered', () => {
    const { kimi: _kimi, ...rest } = full
    const f = harnessCoverage(with_({ ...rest, codex: ph({ linked: false }), gemini: ph({ echo: null }), copilot: ph({ shown: null }) }))
    expect(f.find(x => x.harness === 'kimi')!.problem).toContain('not probed')
    expect(f.find(x => x.harness === 'codex')!.problem).toContain('not linked')
    expect(f.find(x => x.harness === 'gemini')!.problem).toContain('never echoed')
    expect(f.find(x => x.harness === 'copilot')!.problem).toContain('never reached')
    expect(f.find(x => x.harness === 'claude')).toBeUndefined()
    expect(coverageAnnotations(f).every(a => a.startsWith('::warning '))).toBe(true)
  })
  test('a plan without probes says so for every harness instead of passing', () => {
    expect(harnessCoverage({ rows: [row(0, 0)] }).map(f => f.harness)).toEqual([...BENCH_HARNESSES])
  })
  test('the expected set is the six CLI harnesses bench.ts spawns', () => {
    const bench = readFileSync(`${import.meta.dir}/bench.ts`, 'utf8')
    const m = /arg\('harnesses', '([^']+)'\)/.exec(bench)!
    expect(m[1]!.split(',')).toEqual([...BENCH_HARNESSES])
  })
})
