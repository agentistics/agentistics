import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { EMPTY_SLOT_LAYOUT, PANEL_IDS, bottomPanels, closePanel, isTabPanelId, movePanel, openPanel, railPanels, rightSlotShowing } from '../../lib/panelSlots'
import { panelIconFor } from '../../lib/panelIcons'
import { panelTitle } from '../../lib/panelMeta'
import { PanelRail } from './PanelRail'

const ids = ['calendar', 'livedelivery'] as const

test('Calendar and Live are ordinary panels: in the registry, on the rail by default, titled in both languages', () => {
  for (const id of ids) {
    expect(PANEL_IDS).toContain(id)
    expect(isTabPanelId(id)).toBe(true)
    expect(railPanels(EMPTY_SLOT_LAYOUT)).toContain(id)
    expect(panelTitle(id, true).length).toBeGreaterThan(0)
  }
  expect(panelTitle('calendar', true)).toBe('Calendário')
  expect(renderToStaticMarkup(<>{panelIconFor('calendar')}</>)).toContain('lucide-calendar-days')
  expect(renderToStaticMarkup(<>{panelIconFor('livedelivery')}</>)).toContain('lucide-activity')
})

for (const id of ids) {
  test(`${id} opens in the RIGHT panel and in the BOTTOM band, never as a page`, () => {
    const right = openPanel(EMPTY_SLOT_LAYOUT, id)
    expect(rightSlotShowing(right)).toBe(id)
    const bottom = openPanel(movePanel(EMPTY_SLOT_LAYOUT, id, 'bottom'), id)
    expect(bottomPanels(bottom)).toContain(id)
    expect(bottom.bottom).toBe(id)
    expect(rightSlotShowing(closePanel(right, id))).not.toBe(id)
  })
}

test('the icon rail draws Calendar and Live as panel buttons, not links to a page', () => {
  const noop = () => {}
  const html = renderToStaticMarkup(<PanelRail lang="en" panels={['calendar', 'livedelivery']} hidden={[]} active={null} rightOpen={false}
    railWidth={44} onResizeWidth={noop} onOpen={noop} onMinimize={noop} onMove={noop} onHide={noop} onReveal={noop} onDrop={noop} />)
  expect(html).not.toContain('href="/tasks/calendar"')
  expect(html).not.toContain('href="/tasks/live"')
  expect(html).toContain('lucide-calendar-days')
  expect(html).toContain('lucide-activity')
})
