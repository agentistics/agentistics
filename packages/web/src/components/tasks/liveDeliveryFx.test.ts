import { describe, expect, test } from 'bun:test'
import { PARTICLE_CAP, intersects, particleGrid, transitionKind } from './liveDeliveryFx'

describe('particleGrid', () => {
  test('never exceeds the cap, however big the card', () => {
    for (const [w, h] of [[220, 160], [600, 400], [1200, 900]] as [number, number][]) {
      expect(particleGrid({ left: 0, top: 0, width: w, height: h }).length).toBeLessThanOrEqual(PARTICLE_CAP)
    }
  })
  test('covers the box and carries a left→right coordinate in 0..1', () => {
    const pts = particleGrid({ left: 10, top: 20, width: 100, height: 50 })
    expect(pts.length).toBeGreaterThan(10)
    expect(pts.every(p => p.u >= 0 && p.u <= 1 && p.x >= 10 && p.x <= 110 && p.y >= 20 && p.y <= 70)).toBe(true)
  })
})

describe('transitionKind', () => {
  test('only merge → published is the disintegration; other changes glide; none stays put', () => {
    expect(transitionKind('merge', 'published')).toBe('merge-approved')
    expect(transitionKind('running', 'qa')).toBe('move')
    expect(transitionKind('qa', 'qa')).toBe('none')
    expect(transitionKind(undefined, 'qa')).toBe('none')
  })
})

describe('intersects', () => {
  const view = { left: 100, top: 100, width: 500, height: 400 }
  test('a box inside, straddling an edge, and fully outside', () => {
    expect(intersects({ left: 150, top: 150, width: 50, height: 50 }, view)).toBe(true)
    expect(intersects({ left: 80, top: 150, width: 50, height: 50 }, view)).toBe(true)
    expect(intersects({ left: -200, top: 150, width: 100, height: 50 }, view)).toBe(false)
    expect(intersects({ left: 700, top: 150, width: 100, height: 50 }, view)).toBe(false)
  })
})
