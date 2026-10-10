import { describe, expect, test } from 'bun:test'
import { createSessionHub } from './session-hub'
import type { SessionSnapshot } from './sessions-host'

/** A hand-driven clock and timer queue: nothing runs until the test advances time. */
function fakeTime() {
  let t = 0
  let seq = 0
  const timers = new Map<number, { at: number; f: () => void }>()
  return {
    now: () => t,
    setTimer: (f: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: t + ms, f }); return id },
    clearTimer: (id: unknown) => { timers.delete(id as number) },
    pending: () => timers.size,
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        t = due[1].at
        due[1].f()
        await flush()
      }
      t = end
      await flush()
    },
  }
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function snap(n: number, at: number): SessionSnapshot {
  return { sessions: [], attention: n, rang: [], polledAtMs: at }
}

/** A poller that resolves only when told to, so concurrency is observable. */
function gatedPoller(clock: { now(): number }) {
  let calls = 0
  const gates: Array<(s: SessionSnapshot) => void> = []
  return {
    calls: () => calls,
    open: () => gates.length,
    poll: () => { calls++; return new Promise<SessionSnapshot>(r => gates.push(r)) },
    release() { const g = gates.shift(); g?.(snap(calls, clock.now())) },
  }
}

function instantPoller(clock: { now(): number }) {
  let calls = 0
  return { calls: () => calls, poll: async () => snap(++calls, clock.now()) }
}

describe('session hub — single flight', () => {
  test('a TICKING hub answers a reader from the last snapshot while the next poll is still running', async () => {
    const time = fakeTime()
    const p = gatedPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, ...time })
    hub.subscribe(() => {})
    await time.advance(0) // the first tick starts
    p.release(); await flush()
    expect(hub.last()?.attention).toBe(1)
    await time.advance(5000) // the second tick is now in flight, and slow
    expect(p.open()).toBe(1)
    let answered: SessionSnapshot | null = null
    void hub.read().then(s => { answered = s })
    await flush()
    // Not held behind the slow poll: the last tick (5 s old) is fresh for a ticking hub.
    expect(answered!.attention).toBe(1)
    expect(p.calls()).toBe(2)
    p.release(); await flush()
  })

  test('with NOTHING fresh, a reader still joins the poll in flight instead of starting a second', async () => {
    const time = fakeTime()
    const p = gatedPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, ...time })
    const first = hub.read()
    await time.advance(100)
    const second = hub.read()
    expect(p.calls()).toBe(1)
    p.release()
    expect((await first).attention).toBe((await second).attention)
  })

  test('concurrent readers share ONE poll', async () => {
    const time = fakeTime()
    const p = gatedPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, ...time })
    const a = hub.read(); const b = hub.read(); const c = hub.read()
    expect(p.calls()).toBe(1)
    p.release()
    const [x, y, z] = await Promise.all([a, b, c])
    expect(x).toBe(y); expect(y).toBe(z)
    expect(p.calls()).toBe(1)
    hub.stop()
  })

  test('a fresh snapshot is served without polling again', async () => {
    const time = fakeTime()
    const p = instantPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, idleMaxAgeMs: 1000, ...time })
    await hub.read()
    await time.advance(500)
    await hub.read()
    expect(p.calls()).toBe(1)
    hub.stop()
  })

  test('refresh never runs two polls at once, and its poll starts AFTER the call', async () => {
    const time = fakeTime()
    const p = gatedPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, ...time })
    const first = hub.read()
    const r1 = hub.refresh(); const r2 = hub.refresh()
    expect(p.calls()).toBe(1) // the refresh waits for the in-flight poll
    p.release(); await first; await flush()
    expect(p.calls()).toBe(2) // then exactly one more, shared by both refreshes
    p.release()
    const [a, b] = await Promise.all([r1, r2])
    expect(a).toBe(b)
    expect(a.attention).toBe(2)
    hub.stop()
  })

  test('a failed poll rejects its readers and keeps the previous snapshot', async () => {
    const time = fakeTime()
    let fail = false
    let n = 0
    const hub = createSessionHub({
      poll: async () => { if (fail) throw new Error('tmux gone'); return snap(++n, time.now()) },
      intervalMs: 5000, idleMaxAgeMs: 0, ...time, warn: () => {},
    })
    const ok = await hub.read()
    fail = true
    await time.advance(10)
    await expect(hub.read({ maxAgeMs: 0 })).rejects.toThrow('tmux gone')
    expect(hub.last()).toBe(ok)
    hub.stop()
  })
})

describe('session hub — timer on demand', () => {
  test('nobody asking costs nothing', async () => {
    const time = fakeTime()
    const p = instantPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, ...time })
    await time.advance(60_000)
    expect(p.calls()).toBe(0)
    expect(hub.stats().ticking).toBe(false)
    hub.stop()
  })

  test('a subscriber makes it tick once per interval, and every tick reaches it', async () => {
    const time = fakeTime()
    const p = instantPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, ...time })
    const seen: number[] = []
    const off = hub.subscribe(s => seen.push(s.attention))
    await time.advance(0)
    await time.advance(60_000)
    // 0, 5, 10, … 60 s — one poll per interval, never more.
    expect(p.calls()).toBe(13)
    expect(seen.length).toBe(13)
    off()
    await time.advance(60_000)
    expect(p.calls()).toBe(13)
    hub.stop()
  })

  test('N readers while ticking cost no extra polls', async () => {
    const time = fakeTime()
    const p = instantPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, ...time })
    const off = hub.subscribe(() => {})
    await time.advance(0)
    for (let i = 0; i < 12; i++) {
      await Promise.all([hub.read(), hub.read(), hub.read(), hub.read(), hub.read()])
      await time.advance(5000)
    }
    // 61 s of ticking at 5 s: 13 polls, whatever the 60 reads did.
    expect(p.calls()).toBe(13)
    off(); hub.stop()
  })

  test('a reader holds the hub ticking for its lease, then it stops by itself', async () => {
    const time = fakeTime()
    const p = instantPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, leaseMs: 30_000, ...time })
    await hub.read()
    expect(hub.stats().ticking).toBe(true)
    await time.advance(60_000)
    // the read at t=0 polled, then ticks at 5…25 s while the lease lasts (ends at 30 s): 6 polls.
    expect(p.calls()).toBe(6)
    expect(hub.stats().ticking).toBe(false)
    hub.stop()
  })

  test('a refresh between ticks does not shorten the next interval below the cadence', async () => {
    const time = fakeTime()
    const polls: number[] = []
    const hub = createSessionHub({
      poll: async () => { polls.push(time.now()); return snap(polls.length, time.now()) },
      intervalMs: 5000, ...time,
    })
    const off = hub.subscribe(() => {})
    await time.advance(0)
    await time.advance(2000)
    await hub.refresh()
    await time.advance(10_000)
    expect(polls).toEqual([0, 2000, 7000, 12_000])
    off(); hub.stop()
  })

  test('an observer gets every poll but creates no demand', async () => {
    const time = fakeTime()
    const p = instantPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, ...time })
    const seen: number[] = []
    hub.observe(s => seen.push(s.attention))
    await time.advance(30_000)
    expect(p.calls()).toBe(0)
    await hub.read()
    expect(seen).toEqual([1])
    hub.stop()
  })

  test('a throwing listener does not stop the others', async () => {
    const time = fakeTime()
    const p = instantPoller(time)
    const warnings: string[] = []
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, ...time, warn: m => warnings.push(m) })
    let got = 0
    hub.subscribe(() => { throw new Error('boom') })
    hub.subscribe(() => { got++ })
    await time.advance(0)
    expect(got).toBe(1)
    expect(warnings.length).toBe(1)
    hub.stop()
  })
})

describe('session hub — idle cadence for background demand (PERF.SLOW)', () => {
  const opts = (time: ReturnType<typeof fakeTime>, poller: ReturnType<typeof instantPoller>, busy: () => boolean) =>
    ({ poll: poller.poll, intervalMs: 5000, idleIntervalMs: 15_000, busy, leaseMs: 30_000, ...time })

  test('only a background subscriber and a still fleet: polls every idleIntervalMs', async () => {
    const time = fakeTime(); const p = instantPoller(time)
    const hub = createSessionHub(opts(time, p, () => false))
    hub.subscribe(() => {}, { background: true })
    await time.advance(0)
    expect(p.calls()).toBe(1)
    await time.advance(14_000)
    expect(p.calls()).toBe(1)
    await time.advance(1_000)
    expect(p.calls()).toBe(2)
  })

  test('a turn running keeps the full rate', async () => {
    const time = fakeTime(); const p = instantPoller(time)
    const hub = createSessionHub(opts(time, p, () => true))
    hub.subscribe(() => {}, { background: true })
    await time.advance(0)
    await time.advance(10_000)
    expect(p.calls()).toBe(3)
  })

  test('a foreground subscriber arriving brings the full rate back at once', async () => {
    const time = fakeTime(); const p = instantPoller(time)
    const hub = createSessionHub(opts(time, p, () => false))
    hub.subscribe(() => {}, { background: true })
    await time.advance(0)
    await time.advance(2_000)
    hub.subscribe(() => {})
    await time.advance(3_000) // 5 s after the first poll
    expect(p.calls()).toBe(2)
  })

  test('a reader inside its lease keeps the full rate; past the lease it idles again', async () => {
    const time = fakeTime(); const p = instantPoller(time)
    const hub = createSessionHub(opts(time, p, () => false))
    hub.subscribe(() => {}, { background: true })
    await time.advance(0)
    void hub.read()
    await time.advance(30_000)
    const during = p.calls()
    expect(during).toBeGreaterThanOrEqual(6)
    await time.advance(45_000)
    expect(p.calls() - during).toBeLessThanOrEqual(4)
  })

  test('without idleIntervalMs nothing changes', async () => {
    const time = fakeTime(); const p = instantPoller(time)
    const hub = createSessionHub({ poll: p.poll, intervalMs: 5000, ...time })
    hub.subscribe(() => {}, { background: true })
    await time.advance(0)
    await time.advance(10_000)
    expect(p.calls()).toBe(3)
  })
})
