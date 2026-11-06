import { afterEach, describe, expect, test } from 'bun:test'
import { perfWatchHostOps, recordRequestLatency, resetPerfWatch, takeSample, type PerfWatchDeps } from './perf-watch'
import type { PerfSample } from './perf-watch-plan'

afterEach(() => resetPerfWatch())

function deps(samples: Partial<PerfSample>[], over: Partial<PerfWatchDeps> = {}) {
  const writes: string[] = []
  const notices: { keys: string[]; file: string | null }[] = []
  let i = 0
  const d: PerfWatchDeps = {
    samples: () => [{ at: i, cpuPct: 5, rssMB: 400, loopLagMaxMs: 10, routes: {}, ...samples[Math.min(i++, samples.length - 1)] }],
    profile: async () => ({ nodes: [], samples: [] }),
    write: async file => { writes.push(file) },
    prune: async () => {},
    notify: (b, file) => notices.push({ keys: b.map(x => x.key), file }),
    now: () => 1_800_000_000_000,
    off: () => false,
    ...over,
  }
  return { d, writes, notices }
}

describe('vigia-desempenho host ops', () => {
  test('several samples since the last run are folded in order: a streak inside ONE run fires', async () => {
    const { d, notices } = deps([{}], { samples: () => Array.from({ length: 6 }, (_, k) => ({ at: k, cpuPct: 97, rssMB: 1, loopLagMaxMs: 1, routes: {} })) })
    const ops = perfWatchHostOps(d)
    const s = await ops['amostrar-desempenho']({}) as { samples: number; fire: { key: string }[] }
    expect(s.samples).toBe(6)
    expect(s.fire.map(b => b.key)).toEqual(['cpuPct'])
    await ops['capturar-desempenho'](s)
    expect(notices.map(n => n.keys)).toEqual([['cpuPct']])
  })

  test('within budget: samples, captures nothing, tells nobody', async () => {
    const { d, writes, notices } = deps([{}])
    const ops = perfWatchHostOps(d)
    const s = await ops['amostrar-desempenho']({}) as { fire: unknown[] }
    expect(s.fire).toEqual([])
    expect(await ops['capturar-desempenho'](s)).toMatchObject({ ok: true, captured: null })
    expect(writes).toEqual([]); expect(notices).toEqual([])
  })

  test('a loop lag over budget for 3 samples: one profile, one notice naming it, then quiet', async () => {
    const { d, writes, notices } = deps([{ loopLagMaxMs: 900 }])
    const ops = perfWatchHostOps(d)
    for (let k = 0; k < 5; k++) await ops['capturar-desempenho'](await ops['amostrar-desempenho']({}))
    expect(writes.length).toBe(1)
    expect(writes[0]).toMatch(/perf\/.+\.cpuprofile$/)
    expect(notices).toEqual([{ keys: ['loopLagMaxMs'], file: writes[0]! }])
  })

  test('dry run decides and writes nothing', async () => {
    const { d, writes, notices } = deps([{ loopLagMaxMs: 900 }])
    const ops = perfWatchHostOps(d)
    let last: unknown
    for (let k = 0; k < 3; k++) last = await ops['amostrar-desempenho']({})
    expect(await ops['capturar-desempenho']({ ...(last as object), dryRun: true })).toMatchObject({ captured: null, would: ['loopLagMaxMs'] })
    expect(writes).toEqual([]); expect(notices).toEqual([])
  })

  test('off refuses in words, never a silent success', async () => {
    const { d } = deps([{}], { off: () => true })
    expect(await perfWatchHostOps(d)['amostrar-desempenho']({})).toMatchObject({ refused: true })
  })

  test('a profile that cannot be taken still notifies', async () => {
    const { d, notices } = deps([{ cpuPct: 99 }], { profile: async () => { throw new Error('no inspector') } })
    const ops = perfWatchHostOps(d)
    for (let k = 0; k < 6; k++) await ops['capturar-desempenho'](await ops['amostrar-desempenho']({}))
    expect(notices).toEqual([{ keys: ['cpuPct'], file: null }])
  })
})

describe('the real sample', () => {
  test('reads the REAL requests of the window by route, and a window with none is null', () => {
    takeSample()
    recordRequestLatency('/api/fleet', 40); recordRequestLatency('/api/fleet', 60)
    recordRequestLatency('/api/version', 5)
    recordRequestLatency('/api/events', 99_999)
    const s = takeSample()
    expect(s.routes['/api/fleet']).toBe(60)
    expect(s.routes['*']).toBe(60)
    expect(s.routes['/api/tasks']).toBeNull()
    expect(takeSample().routes['/api/fleet']).toBeNull()
    expect(s.rssMB).toBeGreaterThan(0)
  })
})
