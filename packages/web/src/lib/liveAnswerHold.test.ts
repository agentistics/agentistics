import { describe, expect, test } from 'bun:test'
import { HOLD_MAX_MS, holdLiveAnswer, type HeldLive } from './liveAnswer'

const T = 1_000_000
const answer = 'answer to x lorem ipsum dolor sit amet'

describe('holdLiveAnswer — the live bubble stays until the finished turn is on screen', () => {
  test('a live answer is shown and remembered', () => {
    const r = holdLiveAnswer(null, answer, 4, undefined, T)
    expect(r.text).toBe(answer)
    expect(r.held).toEqual({ text: answer, turns: 4, seenAt: T })
  })

  test('the screen moved on (null) but the finished turn has NOT landed: the answer stays — never an empty gap', () => {
    const held: HeldLive = { text: answer, turns: 4, seenAt: T }
    for (const dt of [100, 2_000, 6_000, 15_000]) {
      const r = holdLiveAnswer(held, null, 4, 'something older', T + dt)
      expect(r.text).toBe(answer)
      expect(r.held).toBe(held)
    }
  })

  test('the finished turn lands (the committed answer starts with the held text, markdown and wrapping aside): released', () => {
    const held: HeldLive = { text: answer, turns: 4, seenAt: T }
    expect(holdLiveAnswer(held, null, 4, `**answer** to x lorem ips\num dolor sit amet and more`, T + 50).text).toBeNull()
  })

  test('a turn landed or the person wrote (the turn list changed): released', () => {
    const held: HeldLive = { text: answer, turns: 4, seenAt: T }
    expect(holdLiveAnswer(held, null, 5, 'older', T + 50)).toEqual({ held: null, text: null })
  })

  test('an interrupted answer cannot stay forever: released HOLD_MAX_MS after the screen last showed it', () => {
    const held: HeldLive = { text: answer, turns: 4, seenAt: T }
    expect(holdLiveAnswer(held, null, 4, 'older', T + HOLD_MAX_MS - 1).text).toBe(answer)
    expect(holdLiveAnswer(held, null, 4, 'older', T + HOLD_MAX_MS).text).toBeNull()
  })

  test('nothing held and nothing live: nothing drawn; a growing answer replaces the held one', () => {
    expect(holdLiveAnswer(null, null, 4, 'x', T)).toEqual({ held: null, text: null })
    const held: HeldLive = { text: answer, turns: 4, seenAt: T }
    expect(holdLiveAnswer(held, answer + ' more', 4, undefined, T + 100).text).toBe(answer + ' more')
  })
})
