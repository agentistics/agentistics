import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Match the source layout contracts used by NayNotifyCard.layout.test.ts;
// real 390px/400px screenshots remain part of independent live QA.
const source = readFileSync(join(import.meta.dir, 'NayDock.tsx'), 'utf8')
test('Nay tabs get a full wrapping row and 44px targets without clipped labels', () => {
  const tabs = source.slice(source.indexOf('<div role="tablist"'), source.indexOf('<DockSettings pt='))
  expect(tabs).toContain("flex: '1 1 100%'")
  expect(tabs).toContain("flexWrap: 'wrap'")
  expect(tabs).toContain("flex: '1 0 auto'")
  expect(tabs).toContain('minWidth: 44')
  expect(tabs).toContain('minHeight: 44')
  expect(tabs).toContain("whiteSpace: 'normal'")
  expect(tabs).not.toContain('ellipsis')
  expect(tabs).toContain("pt ? 'Sessões' : 'Sessions'")
  expect(tabs).toContain("pt ? 'Limites' : 'Limits'")
})

test('every mobile dock tab shares physical 44px controls, including settings, close and change', () => {
  const css = readFileSync(join(import.meta.dir, '../../index.css'), 'utf8')
  expect(source).toContain('className="ag-nay-dock"')
  const rule = css.slice(css.indexOf('.ag-nay-dock :is(button'))
  expect(rule).toContain('min-width: 44px')
  expect(rule).toContain('min-height: 44px')
  expect(rule).toContain('flex-shrink: 0')
  const launch = source.slice(source.indexOf('{launchLine && ('), source.indexOf('{pickerOpen && picker'))
  expect(launch).not.toContain('ellipsis')
  expect(launch).toContain("whiteSpace: 'normal'")
})

test('engine sections belong inside Sessions; the four top-level tabs stay unchanged', () => {
  const tabs = source.slice(source.indexOf('<div role="tablist"'), source.indexOf('<DockSettings pt='))
  expect(tabs).toContain('DOCK_TABS.map')
  expect(tabs).not.toContain('engineTabs')
  const sessions = source.slice(source.indexOf('<SessionsAside'), source.indexOf('onGoToSession={goToSession}', source.indexOf('<SessionsAside')))
  expect(sessions).toContain('extraTabs={engineTabs.map')
  expect(source).toContain("useEngineSurfaces('nay-sessions')")
})
