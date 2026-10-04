import { afterEach, describe, expect, test } from 'bun:test'
import { applyTheme, COLORS, currentTheme, harnessColor, harnessLabel, THEME_IDS } from './theme'

afterEach(() => applyTheme('dark'))

describe('ST-04 — the palette follows the theme', () => {
  test('every theme fills every colour, and switching mutates the ONE palette screens read', () => {
    const keys = Object.keys(COLORS).sort()
    for (const id of THEME_IDS) {
      applyTheme(id)
      expect(currentTheme()).toBe(id)
      expect(Object.keys(COLORS).sort()).toEqual(keys)
      for (const k of keys) expect(typeof (COLORS as Record<string, string>)[k]).toBe('string')
    }
    applyTheme('dark')
    const dark = COLORS.text
    applyTheme('light')
    expect(COLORS.text).not.toBe(dark)
  })
})

describe('harness names for any id the data carries', () => {
  test('the native harness and an unknown id never come back undefined', () => {
    expect(harnessLabel('claude')).toBe('Claude')
    expect(harnessLabel('agentistics')).toBe('Agentistics')
    expect(harnessLabel('some-new-cli')).toBe('some-new-cli')
    expect(typeof harnessColor('some-new-cli')).toBe('string')
    expect(harnessColor('agentistics')).toBe(COLORS.accent)
  })
})
