import { describe, expect, test } from 'bun:test'
import { DEFAULT_PERF_BUDGETS, NOTICE_GAP_MS, RECOVER_SAMPLES, SAMPLE_EVERY_MS, describeBreach, emptyPerfWatchState, evaluatePerf, p95, routeBucket, type PerfSample } from './perf-watch-plan'

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

  test('only RECOVER_SAMPLES calm samples in a row end the episode; breaking again after the gap fires again', () => {
    let st = emptyPerfWatchState()
    let at = 0
    const next = (v: number) => { const r = evaluatePerf(st, sample({ at, loopLagMaxMs: v })); st = r.state; at += SAMPLE_EVERY_MS; return r }
    for (let i = 0; i < 3; i++) next(900)
    expect(st.fired).toEqual(['loopLagMaxMs'])
    for (let i = 0; i < RECOVER_SAMPLES - 1; i++) next(10)
    expect(st.fired).toEqual(['loopLagMaxMs'])
    next(10)
    expect(st.fired).toEqual([])
    expect(st.streaks.loopLagMaxMs).toBeUndefined()
    // a new episode inside the notice gap is held back…
    const early = [1, 2, 3].map(() => next(900).fire.length)
    expect(early).toEqual([0, 0, 0])
    // …and fires once the gap has passed while it is still broken.
    at += NOTICE_GAP_MS
    expect(next(900).fire.map(b => b.key)).toEqual(['loopLagMaxMs'])
  })

  test('a calm sample inside a busy stretch does not end the episode (the oscillating CPU of the QA repro)', () => {
    let st = emptyPerfWatchState()
    let notices = 0
    const SAMPLES = (8 * 3_600_000) / SAMPLE_EVERY_MS
    for (let i = 0; i < SAMPLES; i++) {
      // 6 samples at 40 % then 1 at 10 %, repeating, for 8 hours of 30 s samples.
      const r = evaluatePerf(st, sample({ at: i * SAMPLE_EVERY_MS, cpuPct: i % 7 === 6 ? 10 : 40 }))
      st = r.state
      notices += r.fire.length
    }
    expect(notices).toBe(1)
  })

  test('a budget never fires twice inside NOTICE_GAP_MS, however the episodes fall', () => {
    let st = emptyPerfWatchState()
    const stamps: number[] = []
    const SAMPLES = (8 * 3_600_000) / SAMPLE_EVERY_MS
    for (let i = 0; i < SAMPLES; i++) {
      // 6 over, then a full recovery (RECOVER_SAMPLES under): every cycle is a genuinely new episode.
      const phase = i % (6 + RECOVER_SAMPLES)
      const at = i * SAMPLE_EVERY_MS
      const r = evaluatePerf(st, sample({ at, cpuPct: phase < 6 ? 40 : 10 }))
      st = r.state
      if (r.fire.length) stamps.push(at)
    }
    expect(stamps.length).toBeGreaterThan(1)
    expect(stamps.length).toBeLessThanOrEqual(Math.ceil(8 * 60 / 30) + 1)
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]! - stamps[i - 1]!).toBeGreaterThanOrEqual(NOTICE_GAP_MS)
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
