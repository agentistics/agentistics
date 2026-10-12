import { describe, expect, test } from 'bun:test'
import { visibleQueued } from './queuedCards'

const q = [{ text: 'hello there', at: 1 }]

describe('visibleQueued', () => {
  test('pending + transcript not loaded -> no cards', () => {
    expect(visibleQueued(q, [], false)).toEqual([])
  })
  test('loaded and the turn is present -> no cards', () => {
    expect(visibleQueued(q, ['hello there'], true)).toEqual([])
  })
  test('loaded without the turn -> card shows', () => {
    expect(visibleQueued(q, ['other'], true)).toEqual(q)
  })
  test('fresh echo after load shows', () => {
    expect(visibleQueued([{ text: 'new one' }], [], true)).toEqual([{ text: 'new one' }])
  })
  test('delivered ones are dropped', () => {
    expect(visibleQueued(q, [], true, new Set(['hello there']))).toEqual([])
  })
})

import { shouldRestoreDraft } from './queuedCards'
describe('shouldRestoreDraft', () => {
  test('send failure with no server copy -> text kept', () => {
    expect(shouldRestoreDraft([], 'x')).toBe(true)
    expect(shouldRestoreDraft(undefined, 'x')).toBe(true)
  })
  test('failure but the server already holds it -> composer stays empty', () => {
    expect(shouldRestoreDraft([{ text: 'x' }], 'x')).toBe(false)
  })
})
