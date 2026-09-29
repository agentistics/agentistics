import { describe, expect, test } from 'bun:test'
import { blurAfterDrag } from './dragCleanup'

describe('blurAfterDrag', () => {
  test('the row or folder a drag started from loses its leftover focus ring', () => {
    expect(blurAfterDrag({ tagName: 'BUTTON' })).toBe(true)
    expect(blurAfterDrag({ tagName: 'div' })).toBe(true)
  })
  test('never takes focus out of somewhere a person is typing', () => {
    expect(blurAfterDrag({ tagName: 'INPUT' })).toBe(false)
    expect(blurAfterDrag({ tagName: 'textarea' })).toBe(false)
    expect(blurAfterDrag({ tagName: 'DIV', isContentEditable: true })).toBe(false)
  })
  test('nothing focused, or the body, is left alone', () => {
    expect(blurAfterDrag(null)).toBe(false)
    expect(blurAfterDrag({ tagName: 'BODY' })).toBe(false)
  })
})
