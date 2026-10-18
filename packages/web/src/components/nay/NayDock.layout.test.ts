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

test('dock session rows reserve the muted indicator column even when unmuted', () => {
  const aside = readFileSync(join(import.meta.dir, '../nav/SessionsAside.tsx'), 'utf8')
  expect(aside).toContain('data-session-mute-slot')
  expect(aside).toContain('aria-hidden="true" data-session-mute-slot style={{ width: 18, height: 20, flexShrink: 0 }}')
  expect(aside).toContain("goTo && !mutedKeys.includes(pinKeyOf(session)) && !(muteWorkers && role === 'worker' && sessionRunning(session))")
})
