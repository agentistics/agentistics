import { expect, test } from 'bun:test'
import { MAX_FRAME_S, advanceFinaleClock } from './finaleClock'
import { SUCK_S } from './updateAnim'

test('a stalled frame advances the timeline by one frame at most', () => {
  expect(advanceFinaleClock(0, 3000)).toBe(MAX_FRAME_S)
  expect(advanceFinaleClock(0, 16)).toBeCloseTo(0.016)
  expect(advanceFinaleClock(1, -5)).toBe(1)
})

test('a multi-second stall at boot cannot skip the suction', () => {
  let t = 0
  t = advanceFinaleClock(t, 4000) // first frame after a long stall
  expect(t).toBeLessThan(SUCK_S)
})
