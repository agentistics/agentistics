import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskNavigationLinks } from './TaskNavigationLinks'
import { PanelRail } from './PanelRail'
import { panelIconFor } from '../../lib/panelIcons'
import { panelTitle } from '../../lib/panelMeta'

for (const lang of ['pt', 'en'] as const) for (const mobile of [false, true]) test(`Calendar and real Live routes/icons are present (${lang}, phone=${mobile})`, () => {
  const html = renderToStaticMarkup(<TaskNavigationLinks lang={lang} mobile={mobile} pathname="/tasks/live" />)
  expect(html).toContain('href="/tasks/calendar"')
  expect(html).toContain('href="/tasks/live"')
  expect(html).toContain('lucide-calendar-days')
  expect(html).toContain('lucide-activity')
  expect(html).toContain(`aria-label="${lang === 'pt' ? 'Calendário' : 'Calendar'}"`)
  expect(html).toContain('aria-label="Live" title="Live" aria-current="page"')
  if (mobile) expect(html).toContain('height:44px')
})

test('the actual icon rail includes task navigation and gives the old session Live tab FileDiff', () => {
  const noop = () => {}
  const html = renderToStaticMarkup(<PanelRail lang="en" panels={['live', 'tasks']} hidden={[]} active="live" rightOpen
    railWidth={44} onResizeWidth={noop} onOpen={noop} onMinimize={noop} onMove={noop} onHide={noop} onReveal={noop} onDrop={noop} />)
  expect(html).toContain('href="/tasks/calendar"'); expect(html).toContain('href="/tasks/live"')
  const fileIcon = renderToStaticMarkup(<>{panelIconFor('live')}</>)
  expect(fileIcon).toContain('lucide-file-diff'); expect(fileIcon).not.toContain('lucide-activity')
  expect(panelTitle('live', false)).toBe('Files'); expect(panelTitle('live', true)).toBe('Arquivos')
})
