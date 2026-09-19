import { describe, expect, test } from 'bun:test'
import { CTRL_SHORTCUTS, shortcutDecision } from './terminalShortcuts'

const ev = (over: Partial<Parameters<typeof shortcutDecision>[0]> = {}) => ({
  ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'c', ...over,
})

describe('the shortcuts a terminal owns while it has the keyboard', () => {
  test('every ctrl key the channel accepts is TAKEN from the browser', () => {
    // Reported: "quando eu estiver no terminal, quero que os atalhos funcionem (ctrl l ctrl w etc)".
    // Today `ctrl+w` closes the tab and `ctrl+l` goes to the address bar; neither reaches the pane.
    for (const key of CTRL_SHORTCUTS) expect(shortcutDecision(ev({ key }))).toBe('take')
  })

  test('a ctrl key the channel does NOT accept is left to the browser', () => {
    // `C-z` (suspend) and `C-t`/`C-n`/`C-r` are outside `KEY_ALLOWLIST`. Swallowing one would cost
    // the person their browser shortcut and deliver nothing in exchange.
    for (const key of ['z', 't', 'n', 'r', 'p', 's']) {
      expect(shortcutDecision(ev({ key }))).toBe('leave')
    }
  })
})

describe('what may NEVER be swallowed', () => {
  test('ctrl+shift+* stays the browser’s', () => {
    // Devtools, the incognito window, reopen-tab. The VS Code extension records the same rule for
    // its panel: swallow these and the editor around the terminal stops working.
    for (const key of CTRL_SHORTCUTS) {
      expect(shortcutDecision(ev({ key, shiftKey: true }))).toBe('leave')
    }
  })

  test('Cmd / Win is never touched', () => {
    // On a Mac every application shortcut is Cmd. A terminal that ate them would be a terminal you
    // cannot copy out of, quit, or switch away from.
    for (const key of CTRL_SHORTCUTS) {
      expect(shortcutDecision(ev({ key, metaKey: true }))).toBe('leave')
      expect(shortcutDecision(ev({ key, ctrlKey: false, metaKey: true }))).toBe('leave')
    }
  })

  test('alt combinations are left alone', () => {
    expect(shortcutDecision(ev({ key: 'c', altKey: true }))).toBe('leave')
  })

  test('a bare letter is not a shortcut at all', () => {
    expect(shortcutDecision(ev({ key: 'c', ctrlKey: false }))).toBe('leave')
  })

  test('case does not decide it — a capital arrives with shift, and shift already refuses', () => {
    expect(shortcutDecision(ev({ key: 'C' }))).toBe('take')
    expect(shortcutDecision(ev({ key: 'C', shiftKey: true }))).toBe('leave')
  })
})

describe('the set is closed and matches the channel', () => {
  test('exactly the letters `KEY_ALLOWLIST` carries as C-<letter>', () => {
    expect([...CTRL_SHORTCUTS].sort()).toEqual(['a', 'c', 'd', 'e', 'k', 'l', 'u', 'w'])
  })
})

describe('copy — Ctrl+C (and its cousins) with a selection', () => {
  // Reported: selecting text and pressing Ctrl+C sent an interrupt instead of copying. Plain
  // Ctrl+C was in `CTRL_SHORTCUTS` unconditionally, so it always took the browser's own copy away.
  test('Ctrl+C with a selection copies, not interrupts', () => {
    expect(shortcutDecision(ev({ key: 'c' }), true)).toBe('copy')
  })

  test('Ctrl+C with NO selection still interrupts, exactly as before', () => {
    expect(shortcutDecision(ev({ key: 'c' }), false)).toBe('take')
    expect(shortcutDecision(ev({ key: 'c' }))).toBe('take') // hasSelection defaults to false
  })

  test('Cmd+C with a selection copies too', () => {
    expect(shortcutDecision(ev({ key: 'c', ctrlKey: false, metaKey: true }), true)).toBe('copy')
  })

  test('Ctrl+Shift+C with a selection copies too — shift does not refuse the copy decision', () => {
    expect(shortcutDecision(ev({ key: 'c', shiftKey: true }), true)).toBe('copy')
  })

  test('a selection does not turn an unrelated ctrl combo into a copy', () => {
    expect(shortcutDecision(ev({ key: 'w' }), true)).toBe('take')
    expect(shortcutDecision(ev({ key: 'z' }), true)).toBe('leave')
  })

  test('Alt+C is never a copy, selection or not', () => {
    expect(shortcutDecision(ev({ key: 'c', altKey: true }), true)).toBe('leave')
  })

  test('case does not decide the copy check either', () => {
    expect(shortcutDecision(ev({ key: 'C' }), true)).toBe('copy')
  })
})
