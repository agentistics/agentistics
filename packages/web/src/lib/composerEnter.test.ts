import { describe, expect, test } from 'bun:test'
import { enterSends, type EnterKey } from './composerEnter'

const k = (o: Partial<EnterKey>): EnterKey => ({ key: 'Enter', shiftKey: false, isMobile: false, ...o })

describe('enterSends — one rule for both composer fields', () => {
  test('plain Enter sends on a hardware layout and breaks the line on a touch one', () => {
    expect(enterSends(k({}))).toBe(true)
    expect(enterSends(k({ isMobile: true }))).toBe(false)
  })
  test('Cmd/Ctrl+Enter sends wherever the window is — the narrow-window Mac the owner reported', () => {
    expect(enterSends(k({ metaKey: true, isMobile: true }))).toBe(true)
    expect(enterSends(k({ ctrlKey: true, isMobile: true }))).toBe(true)
    expect(enterSends(k({ metaKey: true }))).toBe(true)
  })
  test('shift+Enter always breaks the line, even with a modifier chord', () => {
    expect(enterSends(k({ shiftKey: true }))).toBe(false)
    expect(enterSends(k({ shiftKey: true, metaKey: true }))).toBe(false)
  })
  test('an Enter that commits an accent / IME composition is not a send', () => {
    expect(enterSends(k({ isComposing: true }))).toBe(false)
    expect(enterSends(k({ keyCode: 229 }))).toBe(false)
  })
  test('other keys never send', () => {
    expect(enterSends(k({ key: 'a' }))).toBe(false)
    expect(enterSends(k({ key: 'Escape', metaKey: true }))).toBe(false)
  })
})
