/**
 * "Buscar na conversa" is a PANEL LIKE THE OTHERS — on the rail by default, movable to the bottom
 * band and back, hideable, floatable, and named/iconed through the same tables every other panel is.
 */
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_PLACEMENT, EMPTY_SLOT_LAYOUT, PANEL_IDS, allowed, bottomPanels, isTabPanelId, planPanelDrop,
  railPanels, setPlacement,
} from './panelSlots'
import { PANEL_META } from './panelMeta'
import { panelMenuEntries, panelMinimizeAction, fullscreenModeFor } from './panelMenu'

describe('the search panel is registered', () => {
  test('is a tab panel, first in the reading order, on the rail by default', () => {
    expect(isTabPanelId('search')).toBe(true)
    expect(PANEL_IDS[0]).toBe('search')
    expect(DEFAULT_PLACEMENT.search).toBe('rail')
    expect(railPanels(EMPTY_SLOT_LAYOUT)[0]).toBe('search')
  })

  test('has a title and a description in both languages', () => {
    expect(PANEL_META.search.title.pt).toBe('Buscar na conversa')
    expect(PANEL_META.search.title.en).toBe('Search the conversation')
    expect(PANEL_META.search.description.pt.length).toBeGreaterThan(10)
  })
})

describe('it reaches the bottom band and back, like every panel', () => {
  test('every placement allows it', () => {
    for (const p of ['rail', 'bottom', 'hidden'] as const) expect(allowed(p, 'search')).toBe(true)
  })

  test('the rail menu offers to move it down, and once down it lives in the band', () => {
    const entries = panelMenuEntries({ panel: 'search', placement: 'rail', lang: 'pt', panelName: 'Buscar na conversa' })
    expect(entries.map(e => e.id)).toEqual(['move-bottom'])
    const down = setPlacement(EMPTY_SLOT_LAYOUT, 'search', 'bottom')
    expect(bottomPanels(down)).toContain('search')
    expect(railPanels(down)).not.toContain('search')
    const back = setPlacement(down, 'search', 'rail')
    expect(railPanels(back)).toContain('search')
  })

  test('a drag onto the bottom band moves it there, and a drag onto a rail icon brings it back', () => {
    const down = planPanelDrop(EMPTY_SLOT_LAYOUT, 'search', { placement: 'bottom' })
    expect(down.placement.search).toBe('bottom')
    expect(bottomPanels(down)).toContain('search')
    const back = planPanelDrop(down, 'search', { panel: 'gallery' })
    expect(back.placement.search).toBe('rail')
  })

  test('minimize and full screen behave like the other content panels', () => {
    expect(panelMinimizeAction('search', 'bottom')).toBe('collapse-bottom')
    expect(panelMinimizeAction('search', 'rail')).toBe('close-right')
    expect(fullscreenModeFor('search')).toBe('overlay')
  })
})
