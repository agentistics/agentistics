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
    expect(at('data-tabs-safe-top')).toBeLessThan(at('<div data-session-title'))
  })
  test('a split pane renders the strip before its own header', () => {
    const hoist = src.lastIndexOf('{tabStripAboveTitle ? tabStripEl : null}')
    expect(hoist).toBeGreaterThan(-1)
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
  test('the phone strip reserves the safe area itself and the title row no longer does', () => {
    expect(src).toContain("data-tabs-safe-top style={{ paddingTop: 'calc(var(--safe-top) + 0px)'")
    expect(src).toContain("paddingTop: tabStripAboveTitle && tabStripEl ? 4 : 'calc(var(--safe-top) + 4px)'")
  })
  test('TopBar renders `above` before `trailing`', () => {
    const bar = readFileSync(new URL('../components/nav/TopBar.tsx', import.meta.url), 'utf8')
    expect(bar.indexOf('{above ?')).toBeGreaterThan(-1)
    expect(bar.indexOf('{above ?')).toBeLessThan(bar.indexOf('{trailing &&'))
  })
  test('tab feedback reserves a row below the session header', () => {
    const strip = readFileSync(new URL('../components/sessions/SessionTabStrip.tsx', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const bar = readFileSync(new URL('../components/nav/TopBar.tsx', import.meta.url), 'utf8')
    expect(strip).toContain('onNoticeChange?.(notice)')
    expect(strip).not.toContain("top: '100%'")
    expect(app).toContain('TABS_ROW_H + tabNoticeHeight')
    expect(app).toContain('onBelowHeight={setTabNoticeHeight}')
    expect(bar.indexOf('{below ?')).toBeGreaterThan(bar.indexOf('{trailing &&'))
    expect(src).toContain('{tabNoticeEl}')
  })
})
