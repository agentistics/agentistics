/**
 * The rail's hairline before the Browser (prototype b1-open): the browser is the person's, so a separator sets
 * it apart from the panels about the session — and only when there is something above it (F4 of the S10 QA).
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PanelRail } from './PanelRail'

const noop = () => {}
const rail = (panels: Array<'calendar' | 'livedelivery' | 'browser'>) => renderToStaticMarkup(
  <PanelRail lang="en" panels={panels} hidden={[]} active={null} rightOpen={false}
    railWidth={44} onResizeWidth={noop} onOpen={noop} onMinimize={noop} onMove={noop} onHide={noop} onReveal={noop} onDrop={noop} />,
)

test('the Browser sits after a separator when other panels come before it', () => {
  const html = rail(['calendar', 'livedelivery', 'browser'])
  const sep = html.indexOf('data-rail-separator')
  expect(sep).toBeGreaterThan(-1)
  expect(html.indexOf('data-globe-search')).toBeGreaterThan(sep)
  expect(html.indexOf('lucide-activity')).toBeLessThan(sep)
})

test('no separator without the Browser, nor when it is alone', () => {
  expect(rail(['calendar', 'livedelivery'])).not.toContain('data-rail-separator')
  expect(rail(['browser'])).not.toContain('data-rail-separator')
})
