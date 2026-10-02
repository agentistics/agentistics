import { describe, expect, test } from 'bun:test'
import { RING_SEGMENTS, circuitLit, circuitTraces, coreBudget, corePieces, piecesLit, spawnRate } from './upgradeCore'

describe('the CPU budget', () => {
  test('reduced motion runs no loop and spawns nothing', () => {
    expect(coreBudget({ isMobile: false, reducedMotion: true, dpr: 3 })).toEqual({ particles: 0, dpr: 2, frameMs: 0, animate: false })
  })
  test('a phone gets fewer particles, a lower pixel ratio and half the frame rate', () => {
    const phone = coreBudget({ isMobile: true, reducedMotion: false, dpr: 3 })
    const desk = coreBudget({ isMobile: false, reducedMotion: false, dpr: 3 })
    expect(phone.particles).toBeLessThan(desk.particles)
    expect(phone.dpr).toBeLessThanOrEqual(1.5)
    expect(phone.frameMs).toBeGreaterThanOrEqual(desk.frameMs * 2 - 1)
    expect(desk.particles).toBeLessThanOrEqual(120)
  })
})

describe('the core assembles piece by piece', () => {
  const pieces = corePieces()
  test('three rings, heart first', () => {
    expect(pieces.length).toBe(RING_SEGMENTS.reduce((a, b) => a + b, 0))
    const firstOuter = pieces.findIndex(p => p.ring === 2)
    expect(pieces.slice(0, firstOuter).every(p => p.ring < 2)).toBe(true)
  })
  test('pieces appear with the charge, all in at 1, none at 0', () => {
    expect(piecesLit(0, pieces.length)).toBe(0)
    expect(piecesLit(1, pieces.length)).toBe(pieces.length)
    let prev = 0
    for (let f = 0; f <= 1.0001; f += 0.05) { const n = piecesLit(f, pieces.length); expect(n).toBeGreaterThanOrEqual(prev); prev = n }
  })
  test('circuits light only after the swap, fully once back', () => {
    expect(circuitLit(0.5)).toBe(0)
    expect(circuitLit(1)).toBe(1)
    expect(circuitTraces(0.3).length).toBe(8)
  })
  test('the download is the busiest stream', () => {
    expect(spawnRate('data', 100)).toBeGreaterThan(spawnRate('wiring', 100))
  })
})
