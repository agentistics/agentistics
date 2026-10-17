import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./SessionsPage.tsx', import.meta.url), 'utf8')
const at = (needle: string) => {
  const i = src.indexOf(needle)
  expect(i).toBeGreaterThan(-1)
  return i
}

describe('session tab strip sits above the session title', () => {
  test('flag OFF builds no strip at all', () => {
    expect(src).toContain('const tabStripEl = tabsOn && selected ? (')
    expect(src).toContain('const tabStripAboveTitle = tabsOn && (isMobile || splitRoute !== null)')
  })
  test('the phone bar renders the strip before the title bar', () => {
    expect(at('{tabStripAboveTitle ? tabStripEl : null}')).toBeLessThan(at('<div data-session-title'))
  })
  test('a split pane renders the strip before its own header', () => {
    const hoist = src.lastIndexOf('{tabStripAboveTitle ? tabStripEl : null}')
    expect(hoist).toBeLessThan(at('<SplitPaneHeader'))
    expect(hoist).toBeGreaterThan(at('{splitRoute && selected ? ('))
  })
  test('the panel never hosts the strip (App draws it on a desktop single pane)', () => {
    expect(src).not.toContain('tabStrip: tabStripEl')
  })
  test('App.tsx draws the strip as the first row of the top area, flag-gated, desktop single pane only', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('const tabsRowOn = sessionTabsOn && !isMobile && headerSession !== undefined')
    expect(app).toMatch(/\{\.\.\.\(tabsRowOn && headerSession \? \{\s*aboveHeight: TABS_ROW_H,/)
  })
})
