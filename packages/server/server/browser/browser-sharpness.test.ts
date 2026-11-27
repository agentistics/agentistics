/**
 * NAVEGADOR.FLUIDEZ-NITIDEZ (owner 26/11: "o navegador fica bem travado e com pouca qualidade").
 *
 * (1) The frame is captured at the PHYSICAL pixels it is shown on (surface x devicePixelRatio), capped, and the page
 *     renders at exactly the scale that capture needs — never a CSS-pixel frame upscaled 1.75x on a dense screen,
 *     never a 3x render of a page shown on a 390px phone.
 * (2) Motion frames are cheap; once the page is still, ONE sharp frame replaces the last motion frame.
 * (3) A frame identical to the last one is acked and never re-sent.
 */
import { expect, test } from 'bun:test'
import { castPlan, createViewportCast, MAX_CAPTURE_EDGE } from './browser-viewport'
import {
  createScreencastHub, QUALITY_MOTION, QUALITY_STILL, SHARP_ECHO_MS, SHARP_MIN_INTERVAL_MS, STILL_MS,
  type CastFrame, type RawCastFrame, type ScreenSink,
} from './browser-screencast'

test('a dense screen gets a frame at its physical pixels (the owner: 1240 CSS x 1.75)', () => {
  const p = castPlan({ width: 1240, height: 700, deviceScaleFactor: 1.75 })!
  expect(p.metrics).toEqual({ width: 1240, height: 700, deviceScaleFactor: 1.75 })
  expect(p.capture).toEqual({ maxWidth: 2170, maxHeight: 1225 })
})

test('DPR 1 is unchanged: the frame is the CSS size, scale 1', () => {
  const p = castPlan({ width: 1280, height: 640, deviceScaleFactor: 1 })!
  expect(p.metrics.deviceScaleFactor).toBe(1)
  expect(p.capture).toEqual({ maxWidth: 1280, maxHeight: 640 })
})

test('the physical size is capped and the render scale follows the cap', () => {
  const p = castPlan({ width: 1600, height: 900, deviceScaleFactor: 2 })!
  expect(p.capture.maxWidth).toBe(MAX_CAPTURE_EDGE)
  expect(p.capture.maxHeight).toBe(1440)
  expect(p.metrics.deviceScaleFactor).toBe(1.6)
  const tall = castPlan({ width: 388, height: 900, deviceScaleFactor: 3 })!
  expect(Math.max(tall.capture.maxWidth, tall.capture.maxHeight)).toBeLessThanOrEqual(MAX_CAPTURE_EDGE)
})

test('a phone shows a 1024 page on ~1164 physical px: capture that, render ~1.14x, never 3x', () => {
  const p = castPlan({ width: 388, height: 646, deviceScaleFactor: 3 })!
  expect(p.metrics.width).toBe(1024)
  expect(p.capture.maxWidth).toBe(1164)
  expect(p.metrics.deviceScaleFactor).toBeLessThan(1.2)
  expect(p.metrics.deviceScaleFactor).toBeGreaterThanOrEqual(1)
  // the aspect of the capture is the page's
  expect(Math.abs(p.capture.maxWidth / p.capture.maxHeight - p.metrics.width / p.metrics.height)).toBeLessThan(0.01)
})

test('a frame is never captured below the page CSS width (Chromium downscales worse than the client)', () => {
  const p = castPlan({ width: 388, height: 646, deviceScaleFactor: 1 })!
  expect(p.capture.maxWidth).toBe(1024)
  expect(p.metrics.deviceScaleFactor).toBe(1)
  expect(castPlan({ width: 388, height: 646, deviceScaleFactor: 2 })!.capture.maxWidth).toBe(1024)
})

test('a surface wider than the page cap (2560 CSS @1) is captured at the page width, never upscaled', () => {
  const p = castPlan({ width: 2560, height: 1440, deviceScaleFactor: 1 })!
  expect(p.metrics).toEqual({ width: 1920, height: 1080, deviceScaleFactor: 1 })
  expect(p.capture).toEqual({ maxWidth: 1920, maxHeight: 1080 })
  // shown at 2560 physical px, but the screen is 1x: 1920 px rendered at 1x is all the page has
  const dense = castPlan({ width: 2560, height: 1440, deviceScaleFactor: 2 })!
  expect(dense.capture.maxWidth).toBe(MAX_CAPTURE_EDGE)
})

test('invalid viewer sizes plan nothing', () => {
  expect(castPlan({ width: NaN, height: 1, deviceScaleFactor: 1 })).toBeNull()
})

test('the cast asks Chromium for the planned physical size at the motion quality', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const cast = createViewportCast(async (method, params) => { calls.push([method, params]) })
  await cast.start({ width: 1240, height: 700, deviceScaleFactor: 1.75 })
  expect(calls[0]).toEqual(['Emulation.setDeviceMetricsOverride', { width: 1240, height: 700, deviceScaleFactor: 1.75, mobile: false }])
  expect(calls[1]).toEqual(['Page.startScreencast', { format: 'jpeg', quality: QUALITY_MOTION, maxWidth: 2170, maxHeight: 1225, everyNthFrame: 1 }])
  // the frame-size check still compares CSS sizes
  expect(cast.current()).toEqual({ w: 1240, h: 700 })
  expect(QUALITY_STILL).toBeGreaterThan(QUALITY_MOTION)
})

test('the sharp still frame is a screenshot at the still quality, sized like the capture', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const cast = createViewportCast(async (method, params) => { calls.push([method, params]); return method === 'Page.captureScreenshot' ? { data: 'SHARP' } : {} })
  await cast.start({ width: 1240, height: 700, deviceScaleFactor: 1.75 })
  expect(await cast.sharp()).toBe('SHARP')
  expect(calls.at(-1)).toEqual(['Page.captureScreenshot', { format: 'jpeg', quality: QUALITY_STILL, optimizeForSpeed: true }])
})

// ── the hub: sharp-when-still, dedupe ──────────────────────────────────────────

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
  }
}

const tick = () => new Promise(r => setTimeout(r, 0))

async function rig(sharpResult: () => Promise<string | null> = async () => 'SHARP') {
  const c = clock()
  let emit: (f: RawCastFrame) => void = () => {}
  const acks: number[] = []
  let sharps = 0
  const hub = createScreencastHub({
    start: async (_k, _t, onFrame) => {
      emit = onFrame
      return { ok: true, ack: n => { acks.push(n) }, stop: async () => {}, sharp: () => { sharps++; return sharpResult() } }
    },
    state: (_k, tab) => ({ tab, lock: 'locked', url: 'u', title: 't', loading: false, tabs: [{ id: tab, title: 't', active: true }], lastAction: null, activeTab: tab }),
    activeTab: () => 'T1',
    viewer: () => {},
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: c.setInterval, clearInterval: c.clearInterval,
  })
  const frames: CastFrame[] = []
  const s: ScreenSink = { frame: f => { frames.push(f); return true }, state: () => {}, gone: () => {} }
  const sub = await hub.subscribe('k', 'T1', s)
  let n = 0
  const raw = (data?: string) => { n++; emit({ data: data ?? `jpeg${n}`, sessionId: n, metadata: { deviceWidth: 1280, deviceHeight: 800 } }) }
  return { c, hub, frames, acks, raw, sub, sharps: () => sharps }
}

test('a still page gets ONE sharp frame after STILL_MS, replacing the last motion frame', async () => {
  const r = await rig()
  r.raw()
  expect(r.frames.length).toBe(1)
  r.c.advance(STILL_MS - 1)
  expect(r.sharps()).toBe(0)
  r.c.advance(1)
  await tick()
  expect(r.sharps()).toBe(1)
  expect(r.frames.length).toBe(2)
  const [motion, sharp] = r.frames
  expect(sharp!.jpeg).toBe('SHARP')
  expect(sharp!.sharp).toBe(true)
  expect(sharp!.seq).toBeGreaterThan(motion!.seq)
  expect({ w: sharp!.w, h: sharp!.h, epoch: sharp!.epoch }).toEqual({ w: motion!.w, h: motion!.h, epoch: motion!.epoch })
  // still longer: no second sharp frame of the same picture
  r.c.advance(10 * STILL_MS)
  await tick()
  expect(r.sharps()).toBe(1)
  r.sub.close()
})

test('motion keeps the sharp frame away; real motion while the screenshot is taken wins', async () => {
  let release: (v: string | null) => void = () => {}
  const r = await rig(() => new Promise(res => { release = res }))
  for (let i = 0; i < 5; i++) { r.raw(); r.c.advance(STILL_MS / 2) }
  expect(r.sharps()).toBe(0)
  r.c.advance(STILL_MS)
  expect(r.sharps()).toBe(1)
  r.raw() // the page really moved meanwhile (ONE frame is enough: a toggled checkbox repaints once)
  release('SHARP')
  await tick()
  r.c.advance(200)
  expect(r.frames.some(f => f.jpeg === 'SHARP')).toBe(false)
  expect(r.frames.at(-1)!.jpeg).toBe('jpeg6')
  r.sub.close()
})

/** A base64 JPEG whose SOF says `w`x`h` (what `jpegDims` reads); `tag` makes distinct pictures distinct bytes. */
function fakeJpeg(w: number, h: number, tag: string): string {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0])
  return Buffer.concat([head, Buffer.from(tag)]).toString('base64')
}

// Measured on headless Chromium (r2, 1240x700@1.75 and 1280x720@1, 12 screenshots): a screenshot makes the screencast
// re-send the still page BYTE FOR BYTE (every time), and at a dense size sometimes also one frame at the screenshot's
// physical size first (1 of 6). Those are the echoes; anything else is the page changing and must reach the screen.
test('the echoes a screenshot provokes (the same bytes again) do not replace the sharp frame', async () => {
  let release: (v: string | null) => void = () => {}
  const r = await rig(() => new Promise(res => { release = res }))
  r.raw('A')
  r.c.advance(STILL_MS)
  expect(r.sharps()).toBe(1)
  r.raw('A') // echo while the screenshot is taken: it must not void the screenshot
  release('SHARP')
  await tick()
  r.c.advance(10)
  r.raw('A') // echo just after
  r.c.advance(SHARP_ECHO_MS + 5_000); await tick()
  expect(r.frames.map(f => f.jpeg)).toEqual(['A', 'SHARP'])
  expect(r.acks.length).toBe(3) // every echo acked, Chromium is never left waiting
  expect(r.sharps()).toBe(1)
  r.raw('B')
  expect(r.frames.at(-1)!.jpeg).toBe('B')
  r.sub.close()
})

test('a physical-size echo followed by the same-bytes echo is not shown and costs no extra screenshot', async () => {
  const r = await rig(async () => fakeJpeg(2240, 1400, 'SHARP'))
  const A = fakeJpeg(1280, 800, 'A')
  r.raw(A)
  r.c.advance(STILL_MS); await tick()
  expect(r.frames.at(-1)!.sharp).toBe(true)
  r.c.advance(40); r.raw(fakeJpeg(2240, 1400, 'echo-of-A'))
  r.c.advance(70); r.raw(A)
  r.c.advance(5_000); await tick(); r.c.advance(5_000); await tick()
  expect(r.frames.length).toBe(2)
  expect(r.frames.at(-1)!.sharp).toBe(true)
  expect(r.sharps()).toBe(1)
  r.sub.close()
})

test('a physical-size frame nothing follows is never dropped: one fresh screenshot, then the frame itself', async () => {
  const shots: string[] = []
  const r = await rig(async () => { const s = fakeJpeg(2240, 1400, `SHARP${shots.length}`); shots.push(s); return s })
  const A = fakeJpeg(1280, 800, 'A')
  r.raw(A)
  r.c.advance(STILL_MS); await tick()
  expect(r.sharps()).toBe(1)
  const odd1 = fakeJpeg(2240, 1400, 'B-at-physical') // could be the page changing while it was photographed
  r.c.advance(40); r.raw(odd1)
  r.c.advance(SHARP_ECHO_MS); await tick()
  // the window closed holding it: a screenshot NOW tells the truth (bounded: one)
  expect(r.sharps()).toBe(2)
  expect(r.frames.at(-1)!.jpeg).toBe(shots[1]!)
  const odd2 = fakeJpeg(2240, 1400, 'C-at-physical')
  r.c.advance(40); r.raw(odd2)
  r.c.advance(SHARP_ECHO_MS); await tick()
  // the second time it is shown as it is: one extra frame, never a stale screen and never a screenshot loop
  expect(r.frames.at(-1)!.jpeg).toBe(odd2)
  r.c.advance(20_000); await tick(); r.c.advance(20_000); await tick()
  expect(r.sharps()).toBeLessThanOrEqual(3)
  r.sub.close()
})

// QA r1 (leader/qa/navegador-fluidez-qa.md): a click that repaints ONCE right after the sharp frame was lost for good.
test('one real frame 100 ms after the sharp frame reaches the screen', async () => {
  let page = 'A'
  const r = await rig(async () => `SHARP_OF_${page}`)
  r.raw('A')
  r.c.advance(STILL_MS); await tick()
  expect(r.frames.at(-1)!.jpeg).toBe('SHARP_OF_A')
  r.c.advance(100)
  page = 'B'
  r.raw('B') // the person clicked: the page really changed, Chromium sends ONE frame
  r.c.advance(10_000); await tick(); r.c.advance(10_000); await tick()
  expect(r.frames.at(-1)!.jpeg).not.toBe('SHARP_OF_A')
  expect(r.frames.some(f => f.jpeg === 'B')).toBe(true)
  r.sub.close()
})

test('one real frame WHILE the screenshot is taken voids that screenshot (it predates the change)', async () => {
  let release: (v: string | null) => void = () => {}
  const r = await rig(() => new Promise(res => { release = res }))
  r.raw('A')
  r.c.advance(STILL_MS)
  r.raw('B') // real change during the capture
  release('SHARP_OF_A')
  await tick()
  r.c.advance(10_000); await tick(); r.c.advance(10_000); await tick()
  expect(r.frames.some(f => f.jpeg === 'SHARP_OF_A')).toBe(false)
  expect(r.frames.at(-1)!.jpeg).toBe('B')
  r.sub.close()
})

test('a page that goes back to the picture on screen while a newer frame waits for its slot shows the page as it is', async () => {
  const r = await rig(async () => null)
  r.raw('A')
  r.c.advance(5)
  r.raw('B') // waits for its delivery slot
  r.raw('A') // …and the page is back to A before the slot: A is what must be on screen
  r.c.advance(1_000)
  expect(r.frames.map(f => f.jpeg)).toEqual(['A']) // already there: B never shown, A never sent twice
  r.sub.close()
})

test('a real frame after a held physical-size frame supersedes it (no extra screenshot)', async () => {
  const r = await rig(async () => fakeJpeg(2240, 1400, 'SHARP'))
  r.raw(fakeJpeg(1280, 800, 'A'))
  r.c.advance(STILL_MS); await tick()
  expect(r.sharps()).toBe(1)
  r.c.advance(30); r.raw(fakeJpeg(2240, 1400, 'odd'))
  r.c.advance(10); r.raw(fakeJpeg(1280, 800, 'B')) // the page changed: shown at once
  r.c.advance(SHARP_ECHO_MS); await tick() // the window closed: nothing was left held
  expect(r.frames.at(-1)!.jpeg).toBe(fakeJpeg(1280, 800, 'B'))
  expect(r.sharps()).toBe(1)
  r.sub.close()
})

test('a screenshot that fails shows the physical-size frame held while it was taken', async () => {
  let release: (v: string | null) => void = () => {}
  const r = await rig(() => new Promise(res => { release = res }))
  r.raw(fakeJpeg(1280, 800, 'A'))
  r.c.advance(STILL_MS)
  const odd = fakeJpeg(2240, 1400, 'odd')
  r.raw(odd)
  release(null)
  await tick()
  r.c.advance(200)
  expect(r.frames.at(-1)!.jpeg).toBe(odd)
  r.sub.close()
})

test('a screenshot that fails lets the held echo through', async () => {
  let release: (v: string | null) => void = () => {}
  const r = await rig(() => new Promise(res => { release = res }))
  r.raw()
  r.c.advance(STILL_MS)
  r.raw()
  release(null)
  await tick()
  r.c.advance(200)
  expect(r.frames.at(-1)!.jpeg).toBe('jpeg2')
  r.sub.close()
})

test('sharp frames are rate limited (a blinking caret is not a screenshot loop)', async () => {
  const r = await rig()
  const t0 = r.c.now()
  for (let i = 0; i < 20; i++) { r.raw(); r.c.advance(STILL_MS + 50); await tick() }
  const elapsed = r.c.now() - t0
  expect(r.sharps()).toBeLessThanOrEqual(Math.ceil(elapsed / SHARP_MIN_INTERVAL_MS) + 1)
  r.sub.close()
})

test('an identical frame is acked and not sent again', async () => {
  const r = await rig(async () => null)
  r.raw('SAME')
  r.c.advance(200)
  r.raw('SAME')
  r.c.advance(200)
  expect(r.frames.length).toBe(1)
  expect(r.acks).toEqual([1, 2])
  r.sub.close()
})

test('a failed screenshot changes nothing', async () => {
  const r = await rig(async () => { throw new Error('gone') })
  r.raw()
  r.c.advance(STILL_MS)
  await tick()
  expect(r.frames.length).toBe(1)
  r.sub.close()
})
