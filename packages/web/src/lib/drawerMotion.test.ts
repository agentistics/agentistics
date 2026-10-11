import { describe, expect, test } from 'bun:test'
import {
  drawerAfterFrame, drawerAfterTransition, drawerFrame, drawerMounted, drawerPhaseFor,
  swipeClosePx, swipeCloses, swipeIsHorizontal, type DrawerPhase,
} from './drawerMotion'

describe('drawer phases', () => {
  test('opening mounts off-screen first, then moves to open on the next frame', () => {
    let p: DrawerPhase = 'closed'
    p = drawerPhaseFor(p, true)
    expect(p).toBe('entering')
    expect(drawerMounted(p)).toBe(true)
    p = drawerAfterFrame(p)
    expect(p).toBe('open')
  })

  test('closing keeps the panel MOUNTED until the transition ends — no pop-out', () => {
    let p: DrawerPhase = 'open'
    p = drawerPhaseFor(p, false)
    expect(p).toBe('leaving')
    expect(drawerMounted(p)).toBe(true)
    p = drawerAfterTransition(p)
    expect(p).toBe('closed')
    expect(drawerMounted(p)).toBe(false)
  })

  test('a transitionend from the OPENING transition never unmounts an open panel', () => {
    expect(drawerAfterTransition('open')).toBe('open')
    expect(drawerAfterTransition('entering')).toBe('entering')
  })

  test('re-opening mid-close goes back in rather than finishing the close', () => {
    expect(drawerPhaseFor('leaving', true)).toBe('entering')
  })

  test('closed stays closed, open stays open', () => {
    expect(drawerPhaseFor('closed', false)).toBe('closed')
    expect(drawerPhaseFor('open', true)).toBe('open')
  })
})

describe('drawerFrame', () => {
  test('left: off-screen at -100% while entering/leaving, at 0 when open; the backdrop fades', () => {
    expect(drawerFrame({ phase: 'entering', side: 'left', reducedMotion: false }).transform).toBe('translateX(-100%)')
    expect(drawerFrame({ phase: 'leaving', side: 'left', reducedMotion: false }).transform).toBe('translateX(-100%)')
    const open = drawerFrame({ phase: 'open', side: 'left', reducedMotion: false })
    expect(open.transform).toBe('translateX(0)')
    expect(open.backdropOpacity).toBe(1)
    expect(drawerFrame({ phase: 'entering', side: 'left', reducedMotion: false }).backdropOpacity).toBe(0)
  })

  test('right drawers slide from the right', () => {
    expect(drawerFrame({ phase: 'entering', side: 'right', reducedMotion: false }).transform).toBe('translateX(100%)')
  })

  test('opening is 240ms on the decelerating curve, closing 200ms ease-in', () => {
    expect(drawerFrame({ phase: 'open', side: 'left', reducedMotion: false }).transition).toContain('240ms cubic-bezier(.2,.8,.2,1)')
    expect(drawerFrame({ phase: 'leaving', side: 'left', reducedMotion: false }).transition).toContain('200ms ease-in')
  })

  test('reduced motion: opacity only, never a slide', () => {
    for (const phase of ['entering', 'open', 'leaving'] as const) {
      const f = drawerFrame({ phase, side: 'left', reducedMotion: true })
      expect(f.transform).toBeUndefined()
      expect(f.transition).not.toContain('transform')
    }
    expect(drawerFrame({ phase: 'entering', side: 'left', reducedMotion: true }).panelOpacity).toBe(0)
    expect(drawerFrame({ phase: 'open', side: 'left', reducedMotion: true }).panelOpacity).toBe(1)
  })

  test('a live drag follows the finger with no transition, and the backdrop fades in proportion', () => {
    const f = drawerFrame({ phase: 'open', side: 'left', reducedMotion: false, dragPx: 100, width: 400 })
    expect(f.transform).toBe('translateX(-100px)')
    expect(f.transition).toBe('none')
    expect(f.backdropOpacity).toBeCloseTo(0.75)
  })
})

describe('swipe', () => {
  test('a left drawer closes leftwards; travel the other way does not stretch it', () => {
    expect(swipeClosePx(-60, 'left')).toBe(60)
    expect(swipeClosePx(40, 'left')).toBe(0)
    expect(swipeClosePx(40, 'right')).toBe(40)
  })
  test('past a third of the width closes, less snaps back', () => {
    expect(swipeCloses(140, 400)).toBe(true)
    expect(swipeCloses(120, 400)).toBe(false)
    expect(swipeCloses(500, 0)).toBe(false)
  })
  test('a vertical move is a scroll, decided after the first few pixels', () => {
    expect(swipeIsHorizontal(3, 2)).toBeNull()
    expect(swipeIsHorizontal(-20, 4)).toBe(true)
    expect(swipeIsHorizontal(4, 30)).toBe(false)
  })
})
