import { describe, expect, test } from 'bun:test'
import { DEFAULT_PERF_BUDGETS, describeBreach, emptyPerfWatchState, evaluatePerf, p95, routeBucket, type PerfSample } from './perf-watch-plan'

const sample = (o: Partial<PerfSample> = {}): PerfSample => ({ at: 0, cpuPct: 5, rssMB: 500, loopLagMaxMs: 20, routes: {}, ...o })

describe('evaluatePerf', () => {
  test('a budget counts only after its streak, and fires once per episode', () => {
    let st = emptyPerfWatchState()
    const fires: number[] = []
    for (let i = 0; i < 9; i++) {
      const r = evaluatePerf(st, sample({ cpuPct: 98 }))
      st = r.state
      fires.push(r.fire.length)
    }
    // cpu streak is 6: fires on the 6th sample, and never again while it stays broken.
    expect(fires).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0])
  })

  test('recovering clears the episode; breaking again fires again', () => {
    let st = emptyPerfWatchState()
    for (let i = 0; i < 3; i++) st = evaluatePerf(st, sample({ loopLagMaxMs: 900 })).state
    expect(st.fired).toEqual(['loopLagMaxMs'])
    st = evaluatePerf(st, sample({ loopLagMaxMs: 10 })).state
    expect(st.fired).toEqual([])
    expect(st.streaks.loopLagMaxMs).toBeUndefined()
    const again = [1, 2, 3].map(() => { const r = evaluatePerf(st, sample({ loopLagMaxMs: 900 })); st = r.state; return r.fire.length })
    expect(again).toEqual([0, 0, 1])
  })

  test('one slow sample in between good ones is not a breach', () => {
    let st = emptyPerfWatchState()
    const seq = [900, 10, 900, 10, 900]
    const fired = seq.map(v => { const r = evaluatePerf(st, sample({ loopLagMaxMs: v })); st = r.state; return r.fire.length })
    expect(fired.every(n => n === 0)).toBe(true)
  })

  test('a route with no request in the window is neither fast nor slow: the streak is kept', () => {
    let st = emptyPerfWatchState()
    st = evaluatePerf(st, sample({ routes: { '/api/fleet': 4000 } })).state
    st = evaluatePerf(st, sample({ routes: { '/api/fleet': null } })).state
    st = evaluatePerf(st, sample({ routes: { '/api/fleet': 4000 } })).state
    const r = evaluatePerf(st, sample({ routes: { '/api/fleet': 4000 } }))
    expect(r.fire.map(b => b.key)).toEqual(['route:/api/fleet'])
    expect(r.fire[0]!.streak).toBe(3)
  })

  test('the default budgets are the brief: CPU > 25 % for 3 min at 30 s samples, lag > 200 ms', () => {
    expect(DEFAULT_PERF_BUDGETS.cpuPct).toEqual({ max: 25, streak: 6 })
    expect(DEFAULT_PERF_BUDGETS.loopLagMaxMs.max).toBe(200)
  })
})

describe('helpers', () => {
  test('p95 of nothing is null, never 0', () => {
    expect(p95([])).toBeNull()
    expect(p95([1, 2, 3, 100])).toBe(100)
  })
  test('streams and assets are not requests; the two polled routes have their own bucket', () => {
    expect(routeBucket('/api/events')).toBeNull()
    expect(routeBucket('/api/fleet/events')).toBeNull()
    expect(routeBucket('/api/shell/stream')).toBeNull()
    expect(routeBucket('/api/fleet/input')).toBeNull()
    expect(routeBucket('/assets/index.js')).toBeNull()
    expect(routeBucket('/api/fleet')).toBe('/api/fleet')
    expect(routeBucket('/api/tasks')).toBe('/api/tasks')
    expect(routeBucket('/api/version')).toBe('*')
  })
  test('the notice names what broke, in both languages', () => {
    const b = { key: 'route:/api/fleet', value: 3700, max: 1500, streak: 3 }
    expect(describeBreach(b, 'en')).toContain('/api/fleet')
    expect(describeBreach(b, 'pt')).toContain('3700 ms')
    expect(describeBreach({ key: 'cpuPct', value: 98, max: 25, streak: 6 }, 'pt')).toContain('CPU do servidor')
  })
})
