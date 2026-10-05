import { describe, expect, test } from 'bun:test'
import { createRebuildScheduler } from './rebuild-scheduler'

function harness(minGapMs = 0, load: { maxGapMs?: number; loadFactor?: number } = {}) {
  let t = 0
  const timers: { at: number; f: () => void; id: number }[] = []
  let id = 0
  const builds: (() => void)[] = []
  let rebuilt = 0
  const s = createRebuildScheduler({
    build: () => new Promise<void>(r => builds.push(r)),
    onRebuilt: () => { rebuilt++ },
    debounceMs: 300, minGapMs, ...load,
    now: () => t,
    setTimer: (f, ms) => { const x = { at: t + ms, f, id: ++id }; timers.push(x); return x.id },
    clearTimer: x => { const i = timers.findIndex(y => y.id === x); if (i >= 0) timers.splice(i, 1) },
  })
  const advance = async (ms: number) => {
    t += ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const due = timers[0]
      if (!due || due.at > t) break
      timers.shift(); due.f(); await Promise.resolve()
    }
  }
  const finish = async (tookMs = 0) => { t += tookMs; builds.shift()!(); for (let i = 0; i < 5; i++) await Promise.resolve() }
  return { s, advance, finish, builds, rebuilt: () => rebuilt }
}

describe('createRebuildScheduler', () => {
  test('a burst of changes is one build, and clients hear about it only when the new data exists', async () => {
    const h = harness()
    h.s.changed(); await h.advance(100); h.s.changed(); await h.advance(100); h.s.changed()
    await h.advance(299)
    expect(h.builds.length).toBe(0)
    await h.advance(1)
    expect(h.builds.length).toBe(1)
    expect(h.rebuilt()).toBe(0)
    await h.finish()
    expect(h.rebuilt()).toBe(1)
  })

  test('changes during a build become ONE more build after it', async () => {
    const h = harness()
    h.s.changed(); await h.advance(300)
    h.s.changed(); h.s.changed(); h.s.changed()
    await h.finish()
    await h.advance(300)
    expect(h.builds.length).toBe(1)
    await h.finish()
    await h.advance(10_000)
    expect(h.builds.length).toBe(0)
    expect(h.rebuilt()).toBe(2)
  })

  test('builds start at most every minGapMs', async () => {
    const h = harness(5000)
    h.s.changed(); await h.advance(300); await h.finish()
    h.s.changed(); await h.advance(300)
    expect(h.builds.length).toBe(0)
    // the first build started at 300; the next may start at 5300, not earlier
    await h.advance(4699)
    expect(h.builds.length).toBe(0)
    await h.advance(1)
    expect(h.builds.length).toBe(1)
  })

  test('a failed build tells nobody and keeps the old data', async () => {
    let calls = 0
    const s = createRebuildScheduler({ build: async () => { calls++; throw new Error('x') }, onRebuilt: () => { throw new Error('must not') }, debounceMs: 0, minGapMs: 0 })
    s.changed()
    await Bun.sleep(10)
    expect(calls).toBe(1)
  })

  test('the gap is IDLE time after a build ENDS — a 2 s build no longer runs back to back', async () => {
    // The storm: changes land during every build; measured from the START, a 2 s gap was already
    // spent when a 2 s build finished, and the next one began at once.
    const h = harness(2000)
    h.s.changed(); await h.advance(300)
    h.s.changed() // during the build
    await h.finish(2000)
    await h.advance(1999)
    expect(h.builds.length).toBe(0)
    await h.advance(1)
    expect(h.builds.length).toBe(1)
  })

  test('the idle time grows with the build: duty cycle held near 20 % under constant change', async () => {
    const h = harness(2000, { maxGapMs: 10_000, loadFactor: 4 })
    let busy = 0, span = 0
    h.s.changed(); await h.advance(300)
    for (let i = 0; i < 6; i++) {
      expect(h.builds.length).toBe(1)
      h.s.changed() // a session writes during every build
      await h.finish(2000); busy += 2000
      // wait until the next build starts
      let waited = 0
      while (h.builds.length === 0 && waited < 20_000) { await h.advance(100); waited += 100 }
      expect(waited).toBeGreaterThanOrEqual(8000) // 4 x 2000
      span += 2000 + waited
    }
    expect(busy / span).toBeLessThanOrEqual(0.2 + 1e-9)
  })

  test('a very slow build waits at most maxGapMs, a fast one keeps the floor', async () => {
    const h = harness(2000, { maxGapMs: 10_000, loadFactor: 4 })
    h.s.changed(); await h.advance(300)
    h.s.changed(); await h.finish(9000)
    await h.advance(9999); expect(h.builds.length).toBe(0)
    await h.advance(1); expect(h.builds.length).toBe(1)
    h.s.changed(); await h.finish(10)
    await h.advance(1999); expect(h.builds.length).toBe(0)
    await h.advance(1); expect(h.builds.length).toBe(1)
  })

  test('changes that never stop cannot postpone the build forever', async () => {
    const h = harness(2000)
    for (let i = 0; i < 100; i++) { h.s.changed(); await h.advance(50) } // 5 s of a write every 50 ms
    expect(h.builds.length).toBe(1)
  })
})
