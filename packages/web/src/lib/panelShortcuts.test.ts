import { expect, test, describe } from 'bun:test'
import {
  matchPanelShortcut, shouldHandlePanelShortcut, type PanelShortcutInput,
} from './panelShortcuts'

const base: PanelShortcutInput = {
  key: 'b', code: 'KeyB', ctrl: false, meta: false, shift: false, alt: false,
  isComposing: false, focusInTerminal: false,
}

describe('matchPanelShortcut', () => {
  test('Ctrl+B is toggle-left', () => {
    expect(matchPanelShortcut({ ...base, ctrl: true })).toBe('toggle-left')
  })

  test('Cmd+B (macOS) is also toggle-left', () => {
    expect(matchPanelShortcut({ ...base, meta: true, platform: 'mac' })).toBe('toggle-left')
  })

  test('Ctrl+Shift+B is toggle-right', () => {
    expect(matchPanelShortcut({ ...base, ctrl: true, shift: true })).toBe('toggle-right')
  })

  test('Cmd+Shift+B is also toggle-right', () => {
    expect(matchPanelShortcut({ ...base, meta: true, shift: true })).toBe('toggle-right')
  })

  test('Ctrl+Quote (US apostrophe key) is toggle-band', () => {
    expect(matchPanelShortcut({ ...base, key: "'", code: 'Quote', ctrl: true })).toBe('toggle-band')
  })

  test('Ctrl+Backquote is also toggle-band', () => {
    expect(matchPanelShortcut({ ...base, key: '`', code: 'Backquote', ctrl: true })).toBe('toggle-band')
  })

  test('a browser that reports the key but a different code still matches via `key`', () => {
    // The ABNT2 case named in the brief: `code` may not be `Quote`/`Backquote` on that layout, so
    // the `key` the browser DID report is the fallback.
    expect(matchPanelShortcut({ ...base, key: "'", code: 'BracketRight', ctrl: true })).toBe('toggle-band')
    expect(matchPanelShortcut({ ...base, key: '`', code: 'IntlBackslash', ctrl: true })).toBe('toggle-band')
  })

  test('Cmd+Quote / Cmd+Backquote also toggle the band', () => {
    expect(matchPanelShortcut({ ...base, key: "'", code: 'Quote', meta: true })).toBe('toggle-band')
    expect(matchPanelShortcut({ ...base, key: '`', code: 'Backquote', meta: true })).toBe('toggle-band')
  })

  test('no modifier at all matches nothing', () => {
    expect(matchPanelShortcut({ ...base, key: "'", code: 'Quote' })).toBeNull()
    expect(matchPanelShortcut(base)).toBeNull()
  })

  test('Alt held alongside the mod key matches nothing, for either combo', () => {
    expect(matchPanelShortcut({ ...base, ctrl: true, alt: true })).toBeNull()
    expect(matchPanelShortcut({ ...base, key: "'", code: 'Quote', ctrl: true, alt: true })).toBeNull()
  })

  test('an IME composition in progress matches nothing', () => {
    expect(matchPanelShortcut({ ...base, ctrl: true, isComposing: true })).toBeNull()
  })

  test('Ctrl+Shift+Quote is unclaimed — the band toggle never takes Shift', () => {
    expect(matchPanelShortcut({ ...base, key: "'", code: 'Quote', ctrl: true, shift: true })).toBeNull()
  })

  test('an unrelated key matches nothing', () => {
    expect(matchPanelShortcut({ ...base, key: 'k', code: 'KeyK', ctrl: true })).toBeNull()
  })

  test('the browser bookmarks-bar combo (Ctrl+Shift+B) is exactly what this module must be able '
    + 'to preventDefault on — asserted here as a plain match, the caller does the preventDefault', () => {
    expect(matchPanelShortcut({ ...base, ctrl: true, shift: true })).toBe('toggle-right')
  })
})

describe('shouldHandlePanelShortcut', () => {
  const textInput = { tagName: 'INPUT' }
  const div = { tagName: 'DIV' }

  test('toggle-left/right are refused with focus inside a terminal', () => {
    expect(shouldHandlePanelShortcut({ ...base, ctrl: true, focusInTerminal: true }, div)).toBeNull()
    expect(shouldHandlePanelShortcut({ ...base, ctrl: true, shift: true, focusInTerminal: true }, div)).toBeNull()
  })

  test('toggle-left/right are refused from an ordinary text field, even without terminal focus', () => {
    expect(shouldHandlePanelShortcut({ ...base, ctrl: true }, textInput)).toBeNull()
  })

  test('toggle-left/right fire normally outside a terminal and outside a text field', () => {
    expect(shouldHandlePanelShortcut({ ...base, ctrl: true }, div)).toBe('toggle-left')
    expect(shouldHandlePanelShortcut({ ...base, ctrl: true, shift: true }, div)).toBe('toggle-right')
  })

  test('toggle-band fires even with focus inside a terminal — it is the way OUT of one', () => {
    expect(shouldHandlePanelShortcut(
      { ...base, key: "'", code: 'Quote', ctrl: true, focusInTerminal: true }, div,
    )).toBe('toggle-band')
  })

  test('toggle-band is refused from an ordinary text field', () => {
    expect(shouldHandlePanelShortcut(
      { ...base, key: "'", code: 'Quote', ctrl: true }, textInput,
    )).toBeNull()
  })

  test('a contentEditable field also counts as an ordinary typing target', () => {
    expect(shouldHandlePanelShortcut({ ...base, ctrl: true }, { isContentEditable: true })).toBeNull()
  })

  test('a null/undefined target is never a typing target', () => {
    expect(shouldHandlePanelShortcut({ ...base, ctrl: true }, null)).toBe('toggle-left')
    expect(shouldHandlePanelShortcut({ ...base, ctrl: true }, undefined)).toBe('toggle-left')
  })

  test('nothing fires during IME composition, regardless of focus', () => {
    expect(shouldHandlePanelShortcut({ ...base, ctrl: true, isComposing: true }, div)).toBeNull()
  })
})
