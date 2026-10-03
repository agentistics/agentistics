import { describe, expect, test } from 'bun:test'
import { createRebuildScheduler } from './rebuild-scheduler'

function harness(minGapMs = 0) {
  let t = 0
  const timers: { at: number; f: () => void; id: number }[] = []
  let id = 0
  const builds: (() => void)[] = []
  let rebuilt = 0
  const s = createRebuildScheduler({
    build: () => new Promise<void>(r => builds.push(r)),
    onRebuilt: () => { rebuilt++ },
    debounceMs: 300, minGapMs,
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
  const finish = async () => { builds.shift()!(); for (let i = 0; i < 5; i++) await Promise.resolve() }
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
})
