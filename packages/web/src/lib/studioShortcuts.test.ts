import { describe, expect, test } from 'bun:test'
import {
  isTypingTarget, matchStudioShortcut, shouldHandleGlobally, type ShortcutKeyInfo,
} from './studioShortcuts'

const key = (over: Partial<ShortcutKeyInfo>): ShortcutKeyInfo =>
  ({ key: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over })

describe('matchStudioShortcut', () => {
  test('Ctrl+B is toggle', () => {
    expect(matchStudioShortcut(key({ key: 'b', ctrlKey: true }))).toBe('toggle')
  })

  test('Cmd+B (macOS) is toggle too', () => {
    expect(matchStudioShortcut(key({ key: 'b', metaKey: true }))).toBe('toggle')
  })

  test('Ctrl+Shift+F is search', () => {
    expect(matchStudioShortcut(key({ key: 'f', ctrlKey: true, shiftKey: true }))).toBe('search')
  })

  test('Cmd+Shift+F (macOS) is search too', () => {
    expect(matchStudioShortcut(key({ key: 'F', metaKey: true, shiftKey: true }))).toBe('search')
  })

  test('bare Ctrl+F — the browser\'s own find — is NEITHER, structurally', () => {
    expect(matchStudioShortcut(key({ key: 'f', ctrlKey: true }))).toBeNull()
  })

  test('the letter alone, with no modifier, is neither', () => {
    expect(matchStudioShortcut(key({ key: 'b' }))).toBeNull()
    expect(matchStudioShortcut(key({ key: 'f', shiftKey: true }))).toBeNull()
  })

  test('Ctrl+Shift+B is unclaimed — never misread as toggle', () => {
    expect(matchStudioShortcut(key({ key: 'b', ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  test('an Alt chord is never one of these two, on either shortcut', () => {
    expect(matchStudioShortcut(key({ key: 'b', ctrlKey: true, altKey: true }))).toBeNull()
    expect(matchStudioShortcut(key({ key: 'f', ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull()
  })

  test('an unrelated key with the modifier held is neither', () => {
    expect(matchStudioShortcut(key({ key: 'k', ctrlKey: true }))).toBeNull()
  })

  test('case does not matter — the browser reports the shifted letter, not a flag', () => {
    expect(matchStudioShortcut(key({ key: 'B', ctrlKey: true }))).toBe('toggle')
  })
})

describe('isTypingTarget', () => {
  test('an input or textarea is a typing target', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true)
  })

  test('a contenteditable div is too — the chat composer\'s own shape in some builds', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  test('an ordinary element is not', () => {
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
  })

  test('null or undefined is not a typing target', () => {
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
  })
})

describe('shouldHandleGlobally — the one gate every caller goes through', () => {
  test('a matched shortcut, from an ordinary element, is handled', () => {
    expect(shouldHandleGlobally(key({ key: 'b', ctrlKey: true }), { tagName: 'DIV' })).toBe('toggle')
  })

  test('the SAME keystroke from the chat composer is refused', () => {
    expect(shouldHandleGlobally(key({ key: 'b', ctrlKey: true }), { tagName: 'TEXTAREA' })).toBeNull()
    expect(shouldHandleGlobally(
      key({ key: 'f', ctrlKey: true, shiftKey: true }), { tagName: 'INPUT' },
    )).toBeNull()
  })

  test('no shortcut matched at all — the target never even gets asked about', () => {
    expect(shouldHandleGlobally(key({ key: 'k', ctrlKey: true }), { tagName: 'DIV' })).toBeNull()
  })

  test('a null target (no focused element) is never a typing target', () => {
    expect(shouldHandleGlobally(key({ key: 'b', ctrlKey: true }), null)).toBe('toggle')
  })
})
