import { describe, expect, test } from 'bun:test'
import { STANDALONE_SLACK, standaloneAppHeight } from './standaloneHeight'

const iphone15 = { screenWidth: 393, screenHeight: 852 }

describe('standaloneAppHeight — the PWA height iOS leaves short after the keyboard', () => {
  test('standalone, nothing focused, viewport short of the screen: held at the screen', () => {
    expect(standaloneAppHeight({ standalone: true, editing: false, innerWidth: 393, innerHeight: 793, ...iphone15 })).toBe(852)
  })
  test('a full viewport keeps 100dvh (null)', () => {
    expect(standaloneAppHeight({ standalone: true, editing: false, innerWidth: 393, innerHeight: 852, ...iphone15 })).toBeNull()
  })
  test('within the slack is rounding, not the bug', () => {
    expect(standaloneAppHeight({ standalone: true, editing: false, innerWidth: 393, innerHeight: 852 - STANDALONE_SLACK + 1, ...iphone15 })).toBeNull()
  })
  test('while editing (keyboard possibly up) nothing is touched — the composer rides up by its own rule', () => {
    expect(standaloneAppHeight({ standalone: true, editing: true, innerWidth: 393, innerHeight: 500, ...iphone15 })).toBeNull()
  })
  test('a browser tab is never corrected: its toolbars really do change the height', () => {
    expect(standaloneAppHeight({ standalone: false, editing: false, innerWidth: 393, innerHeight: 700, ...iphone15 })).toBeNull()
  })
  test('landscape uses the short side of the portrait-reported screen', () => {
    expect(standaloneAppHeight({ standalone: true, editing: false, innerWidth: 852, innerHeight: 340, ...iphone15 })).toBe(393)
  })
  test('nonsense readings change nothing', () => {
    expect(standaloneAppHeight({ standalone: true, editing: false, innerWidth: 0, innerHeight: 0, ...iphone15 })).toBeNull()
  })
})
