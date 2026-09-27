import { expect, test, describe } from 'bun:test'
import {
  activeJunctions, applyAxisDrag, applyJunctionDrag, clampSize, gapHitRect, isDragEndEvent,
  junctionHitRect, pointInRect, resolveHitZone, type JunctionAxis,
} from './panelLayout'

describe('clampSize', () => {
  test('holds a value inside its bounds', () => {
    expect(clampSize(300, 170, 420)).toBe(300)
    expect(clampSize(10, 170, 420)).toBe(170)
    expect(clampSize(9000, 170, 420)).toBe(420)
  })
})

describe('applyAxisDrag', () => {
  test('a positive-sign axis grows with a positive delta', () => {
    // The left list: dragging the gap RIGHT (positive dx) grows it.
    expect(applyAxisDrag(250, 40, 1, 170, 420)).toBe(290)
  })

  test('a negative-sign axis grows with a negative delta', () => {
    // The right aside: dragging the gap LEFT (negative dx) grows it.
    expect(applyAxisDrag(300, -50, -1, 200, 480)).toBe(350)
  })

  test('clamps at the floor', () => {
    expect(applyAxisDrag(180, -100, 1, 170, 420)).toBe(170)
  })

  test('clamps at the ceiling', () => {
    expect(applyAxisDrag(400, 100, 1, 170, 420)).toBe(420)
  })
})

describe('applyJunctionDrag', () => {
  const vertical: JunctionAxis = { start: 250, sign: 1, min: 170, max: 420 }
  const horizontal: JunctionAxis = { start: 170, sign: -1, min: 90, max: 380 }

  test('resolves both axes from ONE pointer delta, each on its own component', () => {
    // dx grows the vertical (left-list) boundary; dy (moving UP, negative) grows the band's height
    // through its own -1 sign.
    const result = applyJunctionDrag(vertical, horizontal, 30, -20)
    expect(result.vertical).toBe(280)
    expect(result.horizontal).toBe(190)
  })

  test('a null axis passes straight through, and the other axis is unaffected by it', () => {
    const onlyVertical = applyJunctionDrag(vertical, null, 30, -20)
    expect(onlyVertical.vertical).toBe(280)
    expect(onlyVertical.horizontal).toBeNull()

    const onlyHorizontal = applyJunctionDrag(null, horizontal, 30, -20)
    expect(onlyHorizontal.vertical).toBeNull()
    expect(onlyHorizontal.horizontal).toBe(190)
  })

  test('each axis stays within its OWN limits even when the other is far past its own', () => {
    const result = applyJunctionDrag(vertical, horizontal, 10000, -10000)
    expect(result.vertical).toBe(420)
    expect(result.horizontal).toBe(380)
  })

  test('both null yields both null', () => {
    expect(applyJunctionDrag(null, null, 30, -20)).toEqual({ vertical: null, horizontal: null })
  })
})

describe('activeJunctions', () => {
  test('both junctions exist when everything is open', () => {
    const ids = activeJunctions({ leftOpen: true, rightOpen: true, bandOpen: true })
    expect(ids).toContain('bottom-left')
    expect(ids).toContain('bottom-right')
    expect(ids).toHaveLength(2)
  })

  test('no junction exists once the band is closed, whatever the asides are doing', () => {
    expect(activeJunctions({ leftOpen: true, rightOpen: true, bandOpen: false })).toEqual([])
  })

  test('only the right junction exists when the left list is closed', () => {
    expect(activeJunctions({ leftOpen: false, rightOpen: true, bandOpen: true })).toEqual(['bottom-right'])
  })

  test('only the left junction exists when the right aside is closed', () => {
    expect(activeJunctions({ leftOpen: true, rightOpen: false, bandOpen: true })).toEqual(['bottom-left'])
  })

  test('nothing exists with every neighbour closed', () => {
    expect(activeJunctions({ leftOpen: false, rightOpen: false, bandOpen: true })).toEqual([])
  })
})

describe('gapHitRect', () => {
  test('a vertical gap is at least as wide as the gap itself', () => {
    const r = gapHitRect('vertical', { x: 250, y: 0 }, { start: 0, end: 900 }, 6, 0)
    expect(r).toEqual({ x: 247, y: 0, width: 6, height: 900 })
  })

  test('extends into each neighbour by the overflow, never narrower than the gap', () => {
    const r = gapHitRect('vertical', { x: 250, y: 0 }, { start: 0, end: 900 }, 6, 2)
    expect(r.width).toBe(10)
    expect(r.x).toBe(245)
    expect(r.x + r.width).toBe(255)
  })

  test('a horizontal gap spans the given range in x and centres in y', () => {
    const r = gapHitRect('horizontal', { x: 0, y: 500 }, { start: 260, end: 1100 }, 6, 2)
    expect(r).toEqual({ x: 260, y: 495, width: 840, height: 10 })
  })
})

describe('junctionHitRect', () => {
  test('is a square at least gap x gap, centred on the crossing point', () => {
    const r = junctionHitRect({ x: 700, y: 500 }, 6, 0)
    expect(r).toEqual({ x: 697, y: 497, width: 6, height: 6 })
  })

  test('grows past the bare gap by `extra`, symmetrically', () => {
    const r = junctionHitRect({ x: 700, y: 500 }, 6, 4)
    expect(r.width).toBe(10)
    expect(r.height).toBe(10)
    expect(r.x).toBe(695)
    expect(r.y).toBe(495)
  })
})

describe('pointInRect', () => {
  const r = { x: 10, y: 10, width: 20, height: 20 }
  test('inside is true', () => { expect(pointInRect({ x: 15, y: 15 }, r)).toBe(true) })
  test('on the edge is true (inclusive)', () => { expect(pointInRect({ x: 10, y: 10 }, r)).toBe(true); expect(pointInRect({ x: 30, y: 30 }, r)).toBe(true) })
  test('outside is false', () => { expect(pointInRect({ x: 5, y: 5 }, r)).toBe(false); expect(pointInRect({ x: 31, y: 15 }, r)).toBe(false) })
})

describe('isDragEndEvent', () => {
  test('mouseup, pointerup, pointercancel, touchend, touchcancel and blur all end a drag', () => {
    expect(isDragEndEvent('mouseup')).toBe(true)
    expect(isDragEndEvent('pointerup')).toBe(true)
    expect(isDragEndEvent('pointercancel')).toBe(true)
    expect(isDragEndEvent('touchend')).toBe(true)
    expect(isDragEndEvent('touchcancel')).toBe(true)
    expect(isDragEndEvent('blur')).toBe(true)
  })

  test('a move or an unrelated event never ends a drag', () => {
    expect(isDragEndEvent('mousemove')).toBe(false)
    expect(isDragEndEvent('pointermove')).toBe(false)
    expect(isDragEndEvent('keydown')).toBe(false)
    expect(isDragEndEvent('')).toBe(false)
  })
})

describe('resolveHitZone', () => {
  const junction = { x: 697, y: 497, width: 10, height: 10 }
  const vertical = { x: 247, y: 0, width: 10, height: 900 }
  const horizontal = { x: 260, y: 495, width: 840, height: 10 }

  test('the junction wins wherever it claims the point', () => {
    expect(resolveHitZone({ x: 700, y: 500 }, { junction, vertical, horizontal })).toBe('junction')
  })

  test('falls back to whichever lone gap claims the point outside the junction', () => {
    expect(resolveHitZone({ x: 250, y: 100 }, { junction, vertical, horizontal })).toBe('vertical')
    expect(resolveHitZone({ x: 500, y: 498 }, { junction, vertical, horizontal })).toBe('horizontal')
  })

  test('null when nothing claims the point', () => {
    expect(resolveHitZone({ x: 900, y: 900 }, { junction, vertical, horizontal })).toBeNull()
  })

  test('missing zones are simply skipped', () => {
    expect(resolveHitZone({ x: 700, y: 500 }, {})).toBeNull()
  })
})
