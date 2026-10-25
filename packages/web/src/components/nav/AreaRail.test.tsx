import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AREA_RAIL_W, AreaRail } from './AreaRail'
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
    test(`a 60px column, one link per area except Ajustes, the current area marked (${lang})`, () => {
      expect(AREA_RAIL_W).toBe(60)
      const html = render(lang)
      expect(html).toContain('width:60px')
      for (const area of APP_AREAS) {
        const label = pageLabel(area, lang)
        if (area.id === 'settings') expect(html).not.toContain(`aria-label="${label}"`)
        else expect(html).toContain(`aria-label="${label}"`)
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
    test(`"show tree" is a toggle that opens the area tree beside the rail (${lang})`, () => {
      const closed = render(lang)
      expect(closed).toContain('aria-expanded="false"')
      expect(closed).not.toContain('id="ag-area-rail-tree"')
      const open = render(lang, { initialTreeOpen: true })
      expect(open).toContain('aria-expanded="true"')
      expect(open).toContain('id="ag-area-rail-tree"')
      expect(open).toContain('role="dialog"')
      expect(open).toContain(lang === 'pt' ? 'Agentask' : 'Agentask')
    })
  }
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
