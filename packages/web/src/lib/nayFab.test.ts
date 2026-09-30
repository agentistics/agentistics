import { describe, expect, test } from 'bun:test'
import {
  clampFabPos, DEFAULT_NAY_FAB_PREFS, defaultFabPos, FAB_EDGE, FAB_SIZE, NAY_FAB_STYLES, parseNayFabPrefs,
  smoothVelocity, snapFabToEdge, springAtRest, stepSpring, stretchFor, type SpringState,
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
  test('snaps to the nearest edge and keeps the other axis', () => {
    expect(snapFabToEdge({ x: 30, y: 400 }, VP)).toEqual({ x: FAB_EDGE, y: 400 })
    expect(snapFabToEdge({ x: 700, y: 820 }, VP)).toEqual({ x: 700, y: VP.h - FAB_SIZE - FAB_EDGE })
    expect(snapFabToEdge({ x: 1380, y: 400 }, VP)).toEqual({ x: VP.w - FAB_SIZE - FAB_EDGE, y: 400 })
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
