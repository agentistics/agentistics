/**
 * The screencast hub (NAVEGADOR S4), over fake CDP and a fake clock: frames only while somebody
 * watches, one loop per (browser, tab), at most 12 frames a second, and a slow reader never makes the
 * server queue — it keeps only the newest frame and the ack waits for it (bounded).
 */
import { describe, expect, test } from 'bun:test'
import { createViewportCast } from './browser-viewport'
import {
  createScreencastHub, FRAME_INTERVAL_MS, MAX_ACK_WAIT_MS, MAX_FPS, STATE_POLL_MS,
  type CastFrame, type CastState, type RawCastFrame, type ScreenSink,
} from './browser-screencast'

function clock() {
  let now = 1_000_000
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>()
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const t = ++id; timers.set(t, { at: now + ms, fn }); return t },
    clearTimeout: (t: unknown) => { timers.delete(t as number) },
    setInterval: (fn: () => void, ms: number) => { const t = ++id; timers.set(t, { at: now + ms, fn, every: ms }); return t },
    clearInterval: (t: unknown) => { timers.delete(t as number) },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [tid, t] = due
        now = Math.max(now, t.at)
        if (t.every) t.at = now + t.every
        else timers.delete(tid)
        t.fn()
      }
      now = end
    },
    pending: () => timers.size,
  }
}

function fixture(opts: { state?: () => CastState | null; startFails?: boolean } = {}) {
  const c = clock()
  const casts = new Map<string, { emit: (f: RawCastFrame) => void; acks: number[]; stopped: boolean }>()
  const calls: string[] = []
  const viewers = new Map<string, number>()
  let raw = 0
  const hub = createScreencastHub({
    start: async (key, tab, onFrame) => {
      calls.push(`start ${key} ${tab}`)
      if (opts.startFails) return { ok: false, reason: 'no_browser' }
      const cast = { emit: onFrame, acks: [] as number[], stopped: false }
      casts.set(`${key}|${tab}`, cast)
      return {
        ok: true,
        ack: (n: number) => { cast.acks.push(n) },
        stop: async () => { cast.stopped = true; calls.push(`stop ${key} ${tab}`) },
      }
    },
    state: (key, tab) => (opts.state ? opts.state() : { tab, lock: 'locked', url: 'http://x/', title: 'X', loading: false, tabs: [{ id: tab, title: 'X', active: true }], lastAction: null, activeTab: tab }),
    activeTab: () => 'T1',
    viewer: (key, delta) => { viewers.set(key, (viewers.get(key) ?? 0) + delta) },
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: c.setInterval, clearInterval: c.clearInterval,
  })
  const frame = (key = 'k', tab = 'T1') => {
    const cast = casts.get(`${key}|${tab}`)!
    raw++
    cast.emit({ data: `jpeg${raw}`, sessionId: raw, metadata: { deviceWidth: 1280, deviceHeight: 800 } })
    return raw
  }
  return { hub, c, casts, calls, viewers, frame }
}

function sink(opts: { busy?: () => boolean } = {}) {
  const frames: CastFrame[] = []
  const states: CastState[] = []
  const gone: string[] = []
  const s: ScreenSink = {
    frame: (f) => { if (opts.busy?.()) return false; frames.push(f); return true },
    state: (st) => { states.push(st) },
    gone: (r) => { gone.push(r) },
  }
  return { s, frames, states, gone }
}

const flush = () => new Promise(r => setTimeout(r, 0))

test('hub passes each viewer size, last resize wins; only final reader clears metrics', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const c = clock()
  const hub = createScreencastHub({
    ...c,
    activeTab: () => 'T1', viewer: () => {},
    state: () => ({ tab: 'T1', activeTab: 'T1', lock: 'locked', url: '', title: '', loading: false, tabs: [], lastAction: null }),
    start: async (_key, _tab, _onFrame, size) => {
      const cast = createViewportCast(async (method, params) => { calls.push([method, params]) })
      await cast.start(size)
      return { ok: true, ack: () => {}, resize: cast.resize, stop: cast.stop }
    },
  })
  expect(calls).toEqual([])
  const a = await hub.subscribe('k', null, sink().s, { width: 390, height: 260, deviceScaleFactor: 2 })
  expect(calls[0]).toEqual(['Emulation.setDeviceMetricsOverride', { width: 390, height: 260, deviceScaleFactor: 2, mobile: false }])
  const b = await hub.subscribe('k', null, sink().s, { width: 1100, height: 700, deviceScaleFactor: 1 })
  expect(calls.filter(([m]) => m === 'Emulation.setDeviceMetricsOverride').at(-1)?.[1]).toMatchObject({ width: 1100, height: 700 })
  a.close()
  await flush()
  expect(calls.some(([m]) => m === 'Emulation.clearDeviceMetricsOverride')).toBe(false)
  b.close()
  await flush()
  expect(calls.at(-1)?.[0]).toBe('Emulation.clearDeviceMetricsOverride')
})

describe('nobody watching = no screencast', () => {
  test('no subscriber: start is never called', () => {
    const f = fixture()
    expect(f.calls).toEqual([])
    expect(f.hub.loops()).toBe(0)
  })

  test('first viewer starts, last viewer stops (Page.stopScreencast); nothing is left running', async () => {
    const f = fixture()
    const a = sink(); const b = sink()
    const ua = await f.hub.subscribe('k', 'T1', a.s)
    const ub = await f.hub.subscribe('k', 'T1', b.s)
    expect(f.calls).toEqual(['start k T1']) // ONE loop for two readers
    expect(f.viewers.get('k')).toBe(2)
    ua.close()
    expect(f.calls).toEqual(['start k T1'])
    ub.close()
    await flush()
    expect(f.calls).toEqual(['start k T1', 'stop k T1'])
    expect(f.casts.get('k|T1')!.stopped).toBe(true)
    expect(f.hub.loops()).toBe(0)
    expect(f.viewers.get('k')).toBe(0)
    expect(f.c.pending()).toBe(0) // no timer survives the last viewer
  })

  test('a frame arriving after the last viewer left is never delivered nor acked', async () => {
    const f = fixture()
    const a = sink()
    const u = await f.hub.subscribe('k', 'T1', a.s)
    const cast = f.casts.get('k|T1')!
    u.close()
    cast.emit({ data: 'late', sessionId: 99, metadata: { deviceWidth: 1, deviceHeight: 1 } })
    f.c.advance(2000)
    expect(a.frames).toEqual([])
    expect(cast.acks).toEqual([])
  })

  test('a browser that cannot cast says so and leaves no loop', async () => {
    const f = fixture({ startFails: true })
    const a = sink()
    await f.hub.subscribe('k', 'T1', a.s)
    expect(a.gone).toEqual(['no_browser'])
    expect(f.hub.loops()).toBe(0)
    expect(f.viewers.get('k') ?? 0).toBe(0)
  })

  test('closing twice cannot drive the viewer count negative', async () => {
    const f = fixture()
    const u = await f.hub.subscribe('k', 'T1', sink().s)
    u.close(); u.close()
    expect(f.viewers.get('k')).toBe(0)
  })
})

describe('at most 12 frames a second', () => {
  test('constants', () => {
    expect(MAX_FPS).toBe(12)
    expect(FRAME_INTERVAL_MS).toBeGreaterThanOrEqual(1000 / 12)
  })

  test('a page producing 60 frames/s is delivered at ≤ 12/s, always the NEWEST frame', async () => {
    const f = fixture()
    const a = sink()
    await f.hub.subscribe('k', 'T1', a.s)
    // Chromium sends 60 frames a second whatever we ack (the worst case); 3 seconds of it.
    for (let i = 0; i < 180; i++) { f.frame(); f.c.advance(1000 / 60) }
    f.c.advance(500)
    expect(a.frames.length).toBeLessThanOrEqual(3 * MAX_FPS + 1)
    expect(a.frames.length).toBeGreaterThanOrEqual(3 * MAX_FPS - 2)
    // The last frame the page drew is the last frame the viewer got (coalescing never loses the end).
    expect(a.frames.at(-1)!.jpeg).toBe('jpeg180')
    // No two deliveries closer than the interval.
    const gaps = a.frames.slice(1).map((fr, i) => fr.at - a.frames[i]!.at)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(FRAME_INTERVAL_MS)
  })

  test('every received frame is acked (so Chromium never stalls), but no sooner than its slot', async () => {
    const f = fixture()
    await f.hub.subscribe('k', 'T1', sink().s)
    const cast = f.casts.get('k|T1')!
    const n1 = f.frame()
    expect(cast.acks).toEqual([n1]) // first frame: slot free, delivered and acked at once
    const n2 = f.frame()
    expect(cast.acks).toEqual([n1]) // inside the interval: held
    f.c.advance(FRAME_INTERVAL_MS)
    expect(cast.acks).toEqual([n1, n2])
  })

  test('acks are released ONE per slot (a batch would let Chromium encode several frames per slot)', async () => {
    const f = fixture()
    await f.hub.subscribe('k', 'T1', sink().s)
    const cast = f.casts.get('k|T1')!
    for (let i = 0; i < 4; i++) f.frame() // Chromium's few frames in flight, arriving together
    expect(cast.acks.length).toBe(1)
    f.c.advance(FRAME_INTERVAL_MS)
    expect(cast.acks.length).toBe(2)
    f.c.advance(FRAME_INTERVAL_MS * 2)
    expect(cast.acks).toEqual([1, 2, 3, 4]) // all of them, in order — the page never stalls
    f.c.advance(10_000)
    expect(cast.acks.length).toBe(4)
  })

  test('a still page costs nothing: no frames, no acks, no deliveries', async () => {
    const f = fixture()
    const a = sink()
    await f.hub.subscribe('k', 'T1', a.s)
    f.c.advance(10_000)
    expect(a.frames).toEqual([])
    expect(f.casts.get('k|T1')!.acks).toEqual([])
  })
})

describe('back-pressure: a slow reader keeps the newest frame, never a queue', () => {
  test('the ack waits for a busy reader (bounded by MAX_ACK_WAIT_MS)', async () => {
    const f = fixture()
    let busy = true
    const slow = sink({ busy: () => busy })
    const u = await f.hub.subscribe('k', 'T1', slow.s)
    const cast = f.casts.get('k|T1')!
    const n1 = f.frame()
    expect(slow.frames).toEqual([])
    expect(cast.acks).toEqual([]) // not acked: the reader has not taken it
    f.c.advance(MAX_ACK_WAIT_MS - 1)
    expect(cast.acks).toEqual([])
    f.c.advance(1)
    expect(cast.acks).toEqual([n1]) // bounded: a stuck reader cannot freeze the page's cast forever
    busy = false
    u.drained()
    expect(slow.frames.map(x => x.jpeg)).toEqual(['jpeg1'])
  })

  test('S4b (QA Q-M6): the bound is ONE SECOND in wall time — a stuck reader costs the page at most ~1 frame/s, never less', async () => {
    // Literal numbers on purpose: a test written against the constant moves with it, so raising the bound
    // (e.g. to 10 min, which would reduce the page to ~1 frame per 10 min) would go unnoticed.
    expect(MAX_ACK_WAIT_MS).toBe(1_000)
    const f = fixture()
    const stuck = sink({ busy: () => true })
    await f.hub.subscribe('k', 'T1', stuck.s)
    const cast = f.casts.get('k|T1')!
    const acked: number[] = []
    for (let i = 0; i < 3; i++) {
      const n = f.frame()
      f.c.advance(1_000)
      if (cast.acks.includes(n)) acked.push(n)
    }
    expect(acked.length).toBe(3) // every frame acked within 1 s of a stuck reader
  })

  test('frames arriving while a reader is behind replace each other; it gets only the newest', async () => {
    const f = fixture()
    let busy = true
    const slow = sink({ busy: () => busy })
    const fast = sink()
    const us = await f.hub.subscribe('k', 'T1', slow.s)
    await f.hub.subscribe('k', 'T1', fast.s)
    for (let i = 0; i < 10; i++) { f.frame(); f.c.advance(FRAME_INTERVAL_MS) }
    expect(slow.frames).toEqual([])
    busy = false
    us.drained()
    expect(slow.frames.map(x => x.jpeg)).toEqual(['jpeg10']) // one frame, the newest — no backlog
    expect(fast.frames.length).toBeGreaterThan(1) // the fast reader was never held back past the bound
  })

  test('a reader that drains releases the ack at once', async () => {
    const f = fixture()
    let busy = true
    const slow = sink({ busy: () => busy })
    const u = await f.hub.subscribe('k', 'T1', slow.s)
    const cast = f.casts.get('k|T1')!
    const n1 = f.frame()
    expect(cast.acks).toEqual([])
    busy = false
    u.drained()
    expect(cast.acks).toEqual([n1])
  })
})

describe('state and endings', () => {
  test('a newcomer gets the last frame and the state at once', async () => {
    const f = fixture()
    await f.hub.subscribe('k', 'T1', sink().s)
    f.frame()
    const b = sink()
    await f.hub.subscribe('k', 'T1', b.s)
    expect(b.frames.map(x => x.jpeg)).toEqual(['jpeg1'])
    expect(b.states.length).toBe(1)
  })

  test('state is pushed only when it changed', async () => {
    let title = 'A'
    const f = fixture({ state: () => ({ tab: 'T1', lock: 'locked', url: 'u', title, loading: false, tabs: [], lastAction: null, activeTab: 'T1' }) })
    const a = sink()
    await f.hub.subscribe('k', 'T1', a.s)
    f.c.advance(STATE_POLL_MS * 4)
    expect(a.states.map(s => s.title)).toEqual(['A'])
    title = 'B'
    f.c.advance(STATE_POLL_MS)
    expect(a.states.map(s => s.title)).toEqual(['A', 'B'])
  })

  test('the tab or browser disappearing ends every reader with gone and stops the loop', async () => {
    let alive = true
    const f = fixture({ state: () => (alive ? { tab: 'T1', lock: 'locked', url: 'u', title: 't', loading: false, tabs: [], lastAction: null, activeTab: 'T1' } : null) })
    const a = sink()
    await f.hub.subscribe('k', 'T1', a.s)
    alive = false
    f.c.advance(STATE_POLL_MS)
    expect(a.gone).toEqual(['tab_closed'])
    expect(f.hub.loops()).toBe(0)
  })

  test('browserGone(key, reason) ends that browser\'s readers with the reason', async () => {
    const f = fixture()
    const a = sink(); const b = sink()
    await f.hub.subscribe('k', 'T1', a.s)
    await f.hub.subscribe('other', 'T1', b.s)
    f.hub.browserGone('k', 'idle')
    expect(a.gone).toEqual(['idle'])
    expect(b.gone).toEqual([])
    expect(f.hub.loops()).toBe(1)
  })

  test('frames carry seq, size and the page', async () => {
    const f = fixture()
    const a = sink()
    await f.hub.subscribe('k', 'T1', a.s)
    f.frame(); f.c.advance(FRAME_INTERVAL_MS); f.frame()
    expect(a.frames.map(x => x.seq)).toEqual([1, 2])
    expect(a.frames[0]).toMatchObject({ tab: 'T1', w: 1280, h: 800, url: 'http://x/', title: 'X' })
    expect(f.hub.viewport('k', 'T1')).toEqual({ w: 1280, h: 800 })
  })
})
