import { describe, expect, test } from 'bun:test'
import {
  anyMagnet, clampFabPos, DEFAULT_NAY_FAB_PREFS, dropFabAt, FAB_MAGNET_PX, magnetEdges, defaultFabPos, FAB_EDGE, FAB_SIZE, NAY_FAB_STYLES, parseNayFabPrefs,
  smoothVelocity, springAtRest, stepSpring, stretchFor, type SpringState,
} from './nayFab'

const VP = { w: 1440, h: 900 }

describe('prefs', () => {
  test('an empty or broken store reads as the defaults, jelly first', () => {
    expect(parseNayFabPrefs(null)).toEqual(DEFAULT_NAY_FAB_PREFS)
    expect(parseNayFabPrefs('x')).toEqual(DEFAULT_NAY_FAB_PREFS)
    expect(DEFAULT_NAY_FAB_PREFS.style).toBe('jelly')
  })
  test('a style nothing can draw falls back instead of sticking', () => {
    expect(parseNayFabPrefs({ style: 'rocket', snap: false }).style).toBe('jelly')
    expect(parseNayFabPrefs({ style: 'comet', snap: false })).toEqual({ style: 'comet', snap: false, pos: null })
  })
  test('keeps a readable position and drops a broken one', () => {
    expect(parseNayFabPrefs({ pos: { x: 10, y: 20 } }).pos).toEqual({ x: 10, y: 20 })
    expect(parseNayFabPrefs({ pos: { x: 'a', y: 20 } }).pos).toBeNull()
  })
  test('every style is listed once', () => {
    expect(new Set(NAY_FAB_STYLES).size).toBe(NAY_FAB_STYLES.length)
  })
})

describe('position', () => {
  test('the default sits bottom-right, lifted above a bottom inset', () => {
    expect(defaultFabPos(VP)).toEqual({ x: 1440 - FAB_SIZE - 24, y: 900 - FAB_SIZE - 24 })
    expect(defaultFabPos(VP, 60).y).toBe(900 - FAB_SIZE - 24 - 60)
  })
  test('clamping keeps the whole button on screen after a resize', () => {
    expect(clampFabPos({ x: 5000, y: -40 }, VP)).toEqual({ x: VP.w - FAB_SIZE - FAB_EDGE, y: FAB_EDGE })
  })
})

describe('motion', () => {
  test('the spring settles on its target', () => {
    let s: SpringState = { pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } }
    const target = { x: 300, y: 100 }
    for (let i = 0; i < 2000 && !springAtRest(s, target); i++) s = stepSpring(s, target, 1 / 240)
    expect(springAtRest(s, target)).toBe(true)
  })
  test('stretch grows with speed and is capped', () => {
    expect(stretchFor(0)).toBe(0)
    expect(stretchFor(800)).toBeLessThan(stretchFor(1600))
    expect(stretchFor(1e6)).toBe(0.42)
    expect(stretchFor(Number.NaN)).toBe(0)
  })
  test('velocity is smoothed rather than taken from one event', () => {
    const v = smoothVelocity({ x: 0, y: 0 }, 100, 0, 0.01)
    expect(v.x).toBeCloseTo(4000)
    expect(smoothVelocity(v, 0, 0, 0.01).x).toBeCloseTo(2400)
  })
})

import { nayFabVisible } from './nayFabVisibility'

describe('visibility inside a session', () => {
  test('a phone inside a session hides the button unless asked', () => {
    expect(nayFabVisible({ isMobile: true, inSession: true, shownInSession: false })).toBe(false)
    expect(nayFabVisible({ isMobile: true, inSession: true, shownInSession: true })).toBe(true)
  })
  test('desktop and the rest of the app always show it', () => {
    expect(nayFabVisible({ isMobile: false, inSession: true, shownInSession: false })).toBe(true)
    expect(nayFabVisible({ isMobile: true, inSession: false, shownInSession: false })).toBe(true)
  })
})

describe('the edge magnet', () => {
  test('a drop away from every edge stays exactly where it was dropped', () => {
    expect(dropFabAt({ x: 600, y: 400 }, VP)).toEqual({ x: 600, y: 400 })
    expect(anyMagnet(magnetEdges({ x: 600, y: 400 }, VP))).toBe(false)
  })
  test('a drop close to one edge snaps to that edge only', () => {
    const near = FAB_MAGNET_PX - 10
    expect(magnetEdges({ x: near, y: 400 }, VP)).toEqual({ left: true, right: false, top: false, bottom: false })
    expect(dropFabAt({ x: near, y: 400 }, VP)).toEqual({ x: FAB_EDGE, y: 400 })
    expect(dropFabAt({ x: 600, y: near }, VP)).toEqual({ x: 600, y: FAB_EDGE })
  })
  test('near a corner both edges light and both pull', () => {
    const m = magnetEdges({ x: VP.w - FAB_SIZE - 20, y: VP.h - FAB_SIZE - 20 }, VP)
    expect(m).toEqual({ left: false, right: true, top: false, bottom: true })
    expect(dropFabAt({ x: VP.w - FAB_SIZE - 20, y: VP.h - FAB_SIZE - 20 }, VP))
      .toEqual({ x: VP.w - FAB_SIZE - FAB_EDGE, y: VP.h - FAB_SIZE - FAB_EDGE })
  })
  test('just outside the zone does not snap', () => {
    const far = FAB_MAGNET_PX + 1
    expect(dropFabAt({ x: far, y: 400 }, VP)).toEqual({ x: far, y: 400 })
  })
  test('with the magnet off nothing snaps, but the button stays on screen', () => {
    expect(dropFabAt({ x: 20, y: 400 }, VP, 0, false)).toEqual({ x: 20, y: 400 })
    expect(dropFabAt({ x: -50, y: 400 }, VP, 0, false)).toEqual({ x: FAB_EDGE, y: 400 })
  })
  test('the bottom edge is measured from the floor above a bottom inset (a phone composer)', () => {
    const inset = 200, floor = VP.h - inset
    expect(magnetEdges({ x: 600, y: floor - FAB_SIZE - 30 }, VP, inset).bottom).toBe(true)
    expect(dropFabAt({ x: 600, y: floor - FAB_SIZE - 30 }, VP, inset)).toEqual({ x: 600, y: floor - FAB_SIZE - FAB_EDGE })
  })
})
