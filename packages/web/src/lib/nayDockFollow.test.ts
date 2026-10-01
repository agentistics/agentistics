import { describe, expect, test } from 'bun:test'
import { initFollow, landImpulse, renderDock, stepFollow, followSettled, NO_FADE, CARD_SIDE_HYSTERESIS, REST_AFTER_FRAMES, nextQuiet, forceRest, shouldWake, restingTransform } from './nayDockFollow'
import { NAY_FAB_STYLES } from './nayFab'

const VP = { w: 1440, h: 900 }
const WANT = { w: 420, h: 560 }
const B = 56

function run(style: (typeof NAY_FAB_STYLES)[number], reduced: boolean) {
  const path: [number, number][] = [[0.9, 0.9], [0.05, 0.05], [0.95, 0.1], [0.5, 0.5], [0.08, 0.9], [0.92, 0.5], [0.4, 0.15], [0.9, 0.92]]
  let bx = VP.w * 0.9, by = VP.h * 0.9
  const st = initFollow({ x: bx, y: by, w: B, h: B }, WANT, VP)
  const bad: string[] = []
  for (const [px, py] of path) {
    const tx = Math.min(VP.w - B - 16, Math.max(16, VP.w * px)), ty = Math.min(VP.h - B - 16, Math.max(16, VP.h * py))
    const x0 = bx, y0 = by
    for (let f = 1; f <= 60; f++) {
      bx = x0 + (tx - x0) * f / 60; by = y0 + (ty - y0) * f / 60
      const speed = Math.hypot(tx - x0, ty - y0)   // ~ px per second at 60 frames/s
      for (let k = 0; k < 4; k++) stepFollow(st, { x: bx, y: by, w: B, h: B }, WANT, VP, style, reduced, 1 / 240)
      const fr = renderDock(st, { x: bx, y: by, w: B, h: B }, VP, style, reduced, speed)
      const over = fr.opacity > 0.3 && fr.left < bx + B && bx < fr.left + fr.w && fr.top < by + B && by < fr.top + fr.h
      const off = fr.left < 0 || fr.top < 0 || fr.left + fr.w > VP.w || fr.top + fr.h > VP.h
      if (over || off) bad.push(`${style} ${px},${py}#${f}${over ? ' over' : ''}${off ? ' off' : ''}`)
    }
    landImpulse(st, style, reduced, 1200)
    for (let k = 0; k < 480; k++) stepFollow(st, { x: bx, y: by, w: B, h: B }, WANT, VP, style, reduced, 1 / 240)
  }
  return { st, bad }
}

describe('dock follow', () => {
  for (const style of NAY_FAB_STYLES) {
    test(`${style}: never covers the button and never leaves the screen, and settles`, () => {
      const { st, bad } = run(style, false)
      expect(bad).toEqual([])
      expect(followSettled(st)).toBe(true)
    })
  }
  test('reduced motion: attached to the target, no effect', () => {
    const { st, bad } = run('jelly', true)
    expect(bad).toEqual([])
    expect(st.x).toBe(st.place.left)
    expect(st.shear).toBe(0)
  })
  test('a side change fades out and back in rather than sliding across the button', () => {
    const st = initFollow({ x: 1300, y: 800, w: B, h: B }, WANT, VP)
    const before = st.key
    let sawFade = false
    for (let k = 0; k < 400; k++) {
      stepFollow(st, { x: 100, y: 100, w: B, h: B }, WANT, VP, 'jelly', false, 1 / 240)
      if (st.swap === 1 && st.o < 0.9) sawFade = true
    }
    expect(sawFade).toBe(true)
    expect(st.key).not.toBe(before)
  })
  test('hysteresis: a button wiggling on the midline does not change sides', () => {
    const st = initFollow({ x: VP.w / 2 + 10 - B / 2, y: 800, w: B, h: B }, WANT, VP)
    const key = st.key
    for (let k = 0; k < 200; k++) stepFollow(st, { x: VP.w / 2 + (k % 2 ? -10 : 10) - B / 2, y: 800, w: B, h: B }, WANT, VP, 'shock', false, 1 / 240)
    expect(st.key).toBe(key)
    expect(st.swap).toBe(0)
  })
})

import { frameStyle } from './nayDockFollow'

describe('a frame at rest leaves no containing block for fixed popovers', () => {
  const fr = { left: 120, top: 80, transform: 'scale(1) skewX(0deg) scale(1, 1)' }
  test('at rest: placed by left/top, no transform, no will-change', () => {
    // Either one makes the dock the containing block of the Select popovers inside it, and the
    // dropdown then closed itself as soon as it opened (owner report, v2.80.2, desktop Chrome).
    const s = frameStyle(fr, { left: 0, top: 0 }, false)
    expect(s).toEqual({ left: 120, top: 80, transform: '', willChange: '' })
  })
  test('in motion: a composited translate from the resting place, on its own layer', () => {
    const s = frameStyle(fr, { left: 100, top: 100 }, true)
    expect(s.transform.startsWith('translate3d(20px, -20px, 0)')).toBe(true)
    expect(s.willChange).toBe('transform')
    expect(s.left).toBeUndefined()
  })
  test('a real deformation at rest is kept', () => {
    expect(frameStyle({ ...fr, transform: 'rotate(3deg)' }, { left: 0, top: 0 }, false).transform).toBe('rotate(3deg)')
  })
})

describe('the notification card follows without ever fading (NO_FADE)', () => {
  const CARD = { w: 340, h: 230 }
  const M = 8
  // Along each edge, then round the corners, the way the owner dragged it.
  const edges: Record<string, [[number, number], [number, number]]> = {
    top: [[M, M], [VP.w - B - M, M]],
    right: [[VP.w - B - M, M], [VP.w - B - M, VP.h - B - M]],
    bottom: [[VP.w - B - M, VP.h - B - M], [M, VP.h - B - M]],
    left: [[M, VP.h - B - M], [M, M]],
  }
  for (const style of NAY_FAB_STYLES) {
    for (const [edge, [[x0, y0], [x1, y1]]] of Object.entries(edges)) {
      test(`${style}: opacity stays 1 on every frame of a drag along the ${edge} edge`, () => {
        const st = initFollow({ x: x0, y: y0, w: B, h: B }, CARD, VP)
        const dips: string[] = []
        for (let f = 0; f <= 180; f++) {
          const bx = x0 + (x1 - x0) * f / 180, by = y0 + (y1 - y0) * f / 180
          const btn = { x: bx, y: by, w: B, h: B }
          for (let k = 0; k < 4; k++) stepFollow(st, btn, CARD, VP, style, false, 1 / 240, NO_FADE)
          const fr = renderDock(st, btn, VP, style, false, 1800, NO_FADE)
          if (fr.opacity !== 1) dips.push(`#${f} ${fr.opacity}`)
        }
        expect(dips).toEqual([])
      })
    }
  }
  test('a side change is a retarget, not a fade: opacity 1 throughout', () => {
    const st = initFollow({ x: 1300, y: 800, w: B, h: B }, CARD, VP)
    const before = st.key
    let min = 1
    for (let k = 0; k < 400; k++) {
      stepFollow(st, { x: 100, y: 100, w: B, h: B }, CARD, VP, 'jelly', false, 1 / 240, NO_FADE)
      min = Math.min(min, renderDock(st, { x: 100, y: 100, w: B, h: B }, VP, 'jelly', false, 0, NO_FADE).opacity)
    }
    expect(min).toBe(1)
    expect(st.key).not.toBe(before)
  })
  test('side choice is decided once per crossing: a wiggle within the wider band never flips it', () => {
    const cx = VP.w / 2 - B / 2
    const st = initFollow({ x: cx + CARD_SIDE_HYSTERESIS - 5, y: 400, w: B, h: B }, CARD, VP)
    const sides0 = { ...st.sides }
    let flips = 0, last = st.sides.right
    for (let k = 0; k < 600; k++) {
      const x = cx + (k % 2 ? 1 : -1) * (CARD_SIDE_HYSTERESIS - 5)
      stepFollow(st, { x, y: 400, w: B, h: B }, CARD, VP, 'shock', false, 1 / 240, NO_FADE)
      if (st.sides.right !== last) { flips++; last = st.sides.right }
    }
    expect(flips).toBe(0)
    expect(st.sides).toEqual(sides0)
    // A real crossing flips it exactly once.
    for (let k = 0; k < 100; k++) stepFollow(st, { x: 100, y: 400, w: B, h: B }, CARD, VP, 'shock', false, 1 / 240, NO_FADE)
    expect(st.sides.right).toBe(false)
  })
})

describe('the dock comes to rest wherever the drag ends (REST_AFTER_FRAMES)', () => {
  // The loop the dock runs, reduced to its decisions: step, count quiet frames, force rest.
  function settleAt(style: (typeof NAY_FAB_STYLES)[number], end: { x: number; y: number }, jitter: number, reportedSpeed: number, vp = VP) {
    const st = initFollow({ x: vp.w - B - 24, y: vp.h - B - 24, w: B, h: B }, WANT, vp)
    let bx = vp.w - B - 24, by = vp.h - B - 24
    for (let f = 1; f <= 30; f++) { // the drag
      bx += (end.x - bx) / (31 - f); by += (end.y - by) / (31 - f)
      for (let k = 0; k < 4; k++) stepFollow(st, { x: bx, y: by, w: B, h: B }, WANT, vp, style, false, 1 / 240)
    }
    let quiet = 0, px = bx, py = by
    for (let f = 1; f <= 300; f++) { // after release: a button that keeps republishing sub-pixel noise
      const x = end.x + (f % 2 ? jitter : -jitter), y = end.y
      for (let k = 0; k < 4; k++) stepFollow(st, { x, y, w: B, h: B }, WANT, vp, style, false, 1 / 240)
      quiet = nextQuiet(quiet, Math.hypot(x - px, y - py), reportedSpeed); px = x; py = y
      const forced = quiet >= REST_AFTER_FRAMES
      if (forced) forceRest(st)
      if (forced || (followSettled(st) && reportedSpeed < 1)) return { frames: f, st, btn: { x, y } }
    }
    return { frames: Infinity, st, btn: { x: end.x, y: end.y } }
  }
  const spots = (vp: { w: number; h: number }) => ({
    middle: { x: vp.w / 2 - B / 2, y: vp.h / 2 - B / 2 }, topLeft: { x: 16, y: 16 },
    bottomCenter: { x: vp.w / 2 - B / 2, y: vp.h - B - 16 }, corner: { x: vp.w - B - 24, y: vp.h - B - 24 },
  })
  for (const vp of [VP, { w: 1366, h: 657 }]) for (const style of NAY_FAB_STYLES) for (const [name, at] of Object.entries(spots(vp))) {
    test(`${vp.w}x${vp.h} ${style} ${name}: at rest within ${REST_AFTER_FRAMES} + a few frames, even with a jittering button`, () => {
      const r = settleAt(style, at, 0.4, 5, vp)
      expect(r.frames).toBeLessThanOrEqual(REST_AFTER_FRAMES + 2)
      // At rest: no deformation, full opacity, and the frame draws no transform at all.
      const fr = renderDock(r.st, { ...r.btn, w: B, h: B }, vp, style, false, 0)
      expect(fr.opacity).toBe(1)
      expect(restingTransform(fr.transform)).toBe('')
      expect(frameStyle(fr, { left: 0, top: 0 }, false).willChange).toBe('')
    })
  }
  test('a sub-pixel republish does not wake a dock at rest; a real move does', () => {
    expect(shouldWake(500, 400, { x: 500.4, y: 400.3 }, 3)).toBe(false)
    expect(shouldWake(500, 400, { x: 520, y: 400 }, 0)).toBe(true)
    expect(shouldWake(500, 400, { x: 500, y: 400 }, 400)).toBe(true)
    expect(shouldWake(NaN, NaN, { x: 0, y: 0 }, 0)).toBe(true)
  })
})

describe('every card-follow style visibly moves the card (owner: "only Gelatina animates")', () => {
  const CARD = { w: 340, h: 230 }
  /** Drag the button across the screen and collect what each frame would draw on the card. */
  function drag(style: (typeof NAY_FAB_STYLES)[number]) {
    let bx = 1300, by = 800
    const st = initFollow({ x: bx, y: by, w: B, h: B }, CARD, VP)
    const frames = []
    for (let f = 1; f <= 60; f++) {
      bx -= 12; by -= 6
      const btn = { x: bx, y: by, w: B, h: B }
      for (let k = 0; k < 4; k++) stepFollow(st, btn, CARD, VP, style, false, 1 / 240, NO_FADE)
      frames.push(renderDock(st, btn, VP, style, false, 900, NO_FADE))
    }
    const lefts = new Set(frames.map(fr => Math.round(fr.left)))
    const deformed = frames.some(fr => restingTransform(fr.transform) !== '')
    const echoed = frames.some(fr => fr.echoes.some(e => e.opacity > 0.05))
    // The landing, which is where `shock` speaks.
    landImpulse(st, style, false, 1500)
    stepFollow(st, { x: bx, y: by, w: B, h: B }, CARD, VP, style, false, 1 / 240, NO_FADE)
    const landed = restingTransform(renderDock(st, { x: bx, y: by, w: B, h: B }, VP, style, false, 0, NO_FADE).transform) !== ''
    return { moved: lefts.size > 30, deformed, echoed, landed, opacities: frames.map(fr => fr.opacity) }
  }
  test('jelly: follows and shears', () => { const r = drag('jelly'); expect(r.moved).toBe(true); expect(r.deformed).toBe(true) })
  test('trail: follows and leaves outline echoes', () => { const r = drag('trail'); expect(r.moved).toBe(true); expect(r.echoed).toBe(true) })
  test('comet: follows, leans and leaves echoes', () => { const r = drag('comet'); expect(r.moved).toBe(true); expect(r.deformed).toBe(true); expect(r.echoed).toBe(true) })
  test('shock: follows and squashes on landing', () => { const r = drag('shock'); expect(r.moved).toBe(true); expect(r.landed).toBe(true) })
  test('no style fades the card', () => {
    for (const s of NAY_FAB_STYLES) expect(drag(s).opacities.every(o => o === 1)).toBe(true)
  })
})
