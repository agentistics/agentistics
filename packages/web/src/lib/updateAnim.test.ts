import { describe, expect, test } from 'bun:test'
import {
  DOWNLOAD_SHARE, RESTART_CAP, SUCK_S, easeFactor, easeToward, estimateDownload, finaleBeat, finaleLogoPose, measureRate,
  runningLogoPose, sceneTarget,
} from './updateAnim'
import { UPDATE_ANIMATION } from './upgradeSteps'

test('the default animation is the Core', () => { expect(UPDATE_ANIMATION).toBe('core') })

describe('easing', () => {
  test('never overshoots and never jumps', () => {
    let v = 0
    for (let i = 0; i < 200; i++) { const n = easeToward(v, 1, 16); expect(n).toBeGreaterThanOrEqual(v); expect(n).toBeLessThanOrEqual(1); v = n }
    expect(v).toBeGreaterThan(0.99)
  })
  test('frame-rate independent', () => {
    let a = 0, b = 0
    for (let i = 0; i < 60; i++) a = easeToward(a, 1, 16.6667)
    for (let i = 0; i < 30; i++) b = easeToward(b, 1, 33.3333)
    expect(Math.abs(a - b)).toBeLessThan(0.001)
    expect(easeFactor(0)).toBe(0)
  })
})

describe('download estimation between polls', () => {
  const s = { received: 10, total: 100, at: 0 }
  test('rate is measured from two real samples', () => {
    expect(measureRate(null, s, null)).toBeNull()
    expect(measureRate(s, { received: 40, total: 100, at: 1500 }, null)).toBeCloseTo(20)
  })
  test('advances with the rate but never past one poll of bytes', () => {
    expect(estimateDownload(s, 20, 750, 1500)).toBeCloseTo(0.25)
    expect(estimateDownload(s, 20, 60_000, 1500)).toBeCloseTo(0.4) // 10 + 20*1.5
  })
  test('no rate = the real value; clamps at the total', () => {
    expect(estimateDownload(s, null, 500, 1500)).toBeCloseTo(0.1)
    expect(estimateDownload({ received: 99, total: 100, at: 0 }, 1000, 1000, 1500)).toBe(1)
    expect(estimateDownload(null, 5, 0, 1500)).toBe(0)
  })
})

describe('scene target per real step', () => {
  test('download maps to its share; monotone across steps', () => {
    expect(sceneTarget('data', 1, 0).p).toBeCloseTo(DOWNLOAD_SHARE)
    const ps = [sceneTarget('data', 1, 0), sceneTarget('brain', undefined, 0, 1), sceneTarget('wiring', undefined, 0), sceneTarget('power', undefined, 0)].map(t => t.p)
    for (let i = 1; i < ps.length; i++) expect(ps[i]!).toBeGreaterThanOrEqual(ps[i - 1]!)
  })
  test('restart is indeterminate, creeps, and is capped', () => {
    const a = sceneTarget('wiring', undefined, 1000), b = sceneTarget('wiring', undefined, 600_000)
    expect(a.indet).toBe(true); expect(b.p).toBeGreaterThan(a.p); expect(b.p).toBeLessThanOrEqual(RESTART_CAP)
    expect(sceneTarget('data', 0.5, 0).indet).toBe(false)
  })
})

describe('logo and finale timeline', () => {
  test('the pose carries only scale, alpha and glow', () => {
    for (const p of [runningLogoPose(0.5, true, 100, false), finaleLogoPose(2, false), finaleLogoPose(0.3, true)])
      expect(Object.keys(p).sort()).toEqual(['alpha', 'glow', 'scale'])
  })
  test('result text only after the step text has gone, burst after the suction', () => {
    const early = finaleBeat(SUCK_S - 0.1), mid = finaleBeat(SUCK_S + 0.2), late = finaleBeat(SUCK_S + 1)
    expect(early.burst).toBe(false); expect(mid.burst).toBe(true)
    expect(mid.chromeGone).toBe(true); expect(mid.textIn).toBe(false)
    expect(late.textIn).toBe(true)
    for (let t = 0; t < 5; t += 0.05) { const b = finaleBeat(t); if (b.textIn) expect(b.chromeGone).toBe(true) }
  })
  test('suction lasts about 1.25 s', () => { expect(SUCK_S).toBeCloseTo(1.25) })
})
