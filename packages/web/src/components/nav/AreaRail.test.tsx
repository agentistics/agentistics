import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AREA_RAIL_OPEN_W, AREA_RAIL_W, AreaRail } from './AreaRail'
import { APP_AREAS, pageLabel } from '../../lib/appAreas'

const render = (lang: 'pt' | 'en', extra: Partial<Parameters<typeof AreaRail>[0]> = {}) => renderToStaticMarkup(
  <MemoryRouter initialEntries={['/sessions']}><AreaRail lang={lang} pathname="/sessions" {...extra} /></MemoryRouter>,
)

describe('AreaRail', () => {
  test('a leadership deep link activates Sessions without a separate leadership icon', () => {
    const html = render('pt', { pathname: '/leadership/checkins' })
    expect(html).toContain('aria-label="Sessões" aria-current="page"')
    expect(html).not.toContain('lucide-crown')
    expect(html).not.toContain('aria-label="Liderança"')
  })
  for (const lang of ['pt', 'en'] as const) {
    test(`a 60px column, one link per area including Ajustes, the current area marked (${lang})`, () => {
      expect(AREA_RAIL_W).toBe(60)
      const html = render(lang)
      expect(html).toContain('width:60px')
      for (const area of APP_AREAS) {
        const label = pageLabel(area, lang)
        expect(html).toContain(`aria-label="${label}"`)
      }
      expect(html.match(/aria-current="page"/g)).toHaveLength(1)
      expect(html).toContain(`aria-label="${lang === 'pt' ? 'Sessões' : 'Sessions'}" aria-current="page"`)
    })
    test(`the sessions badge is drawn only when positive and named in words (${lang})`, () => {
      const html = render(lang, { badges: { sessions: 3 } })
      expect(html).toContain(lang === 'pt' ? 'aria-label="Sessões, 3 precisam de você"' : 'aria-label="Sessions, 3 need you"')
      expect(html).toMatch(/>3<\/span>/)
      expect(render(lang, { badges: { sessions: 0 } })).not.toMatch(/>0<\/span>/)
      expect(render(lang, { badges: { usage: 2 } })).toContain(lang === 'pt' ? 'aria-label="Uso, 2 acima do ritmo"' : 'aria-label="Usage, 2 over pace"')
    })
    test(`"show tree" widens the SAME bar: no second column, labels and sections inside it (${lang})`, () => {
      const closed = render(lang)
      expect(closed).toContain('aria-expanded="false"')
      expect(closed).toContain('data-open="false"')
      expect(closed).not.toContain('id="ag-area-rail-tree"')
      const open = render(lang, { initialTreeOpen: true })
      expect(open).toContain('aria-expanded="true"')
      expect(open).toContain('data-open="true"')
      expect(open).toContain('id="ag-area-rail-tree"')
      expect(open).not.toContain('role="dialog"')
      // One <nav data-area-rail> hosting the tree: the tree's own nav is the only other one, and it is inside.
      expect(open.match(/data-area-rail/g)).toHaveLength(1)
      expect(open).toContain(`width:${AREA_RAIL_OPEN_W}px`)
      expect(open).toContain('Agentask')
      // Each area appears once (no icon column duplicating the tree rows).
      const first = pageLabel(APP_AREAS[0]!, lang)
      expect(open.split(`>${first}</a>`).length - 1).toBe(1)
    })
    test(`Métricas leads and Sessões follows (${lang})`, () => {
      const html = render(lang)
      const at = (id: string) => html.indexOf(`aria-label="${pageLabel(APP_AREAS.find(a => a.id === id)!, lang)}`)
      expect(APP_AREAS.slice(0, 2).map(a => a.id)).toEqual(['metrics', 'sessions'])
      expect(at('metrics')).toBeGreaterThan(-1)
      expect(at('metrics')).toBeLessThan(at('sessions'))
    })
  }
  test('collapsed icons and expanded parents contain every area in the same order', () => {
    const closed = render('en'), open = render('en', { initialTreeOpen: true })
    const labels = APP_AREAS.map(a => pageLabel(a, 'en'))
    let previousClosed = -1, previousOpen = -1
    for (const label of labels) {
      const c = closed.indexOf(`aria-label="${label}"`)
      const o = open.indexOf(`>${label}`)
      expect(c).toBeGreaterThan(previousClosed)
      expect(o).toBeGreaterThan(previousOpen)
      previousClosed = c; previousOpen = o
    }
    expect(open).toContain('position:absolute')
    expect(open).toContain('width:60px')
  })
  test('area badges are dark ink on the solid accent and never the breathing attention class (QA r3)', () => {
    const html = render('pt', { badges: { usage: 2, sessions: 3 } })
    const badges = html.match(/<span data-area-badge[^>]*>/g) ?? []
    expect(badges).toHaveLength(2)
    for (const b of badges) {
      expect(b).toContain('background:var(--anthropic-orange)')
      expect(b).toContain('color:#0a0a0f')
      expect(b).not.toContain('ag-attn-count')
    }
  })
})
