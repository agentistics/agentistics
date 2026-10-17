import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AreaTree } from './AreaTree'

const render = (props: Partial<React.ComponentProps<typeof AreaTree>> & { at: string }) => {
  const { at, ...rest } = props
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[at]}><AreaTree lang="pt" pathname={at} {...rest} /></MemoryRouter>,
  )
}

describe('AreaTree', () => {
  it('expands only the current area and marks the current page', () => {
    const html = render({ at: '/usage/history' })
    expect(html).toContain('Histórico')
    expect(html).toMatch(/aria-current="page"[^>]*>Histórico|Histórico[^<]*<\/a>/)
    expect(html).not.toContain('Modo ausente')
    expect(html).not.toContain('Check-ins')
  })
  it('renders the badge next to Sessões', () => {
    expect(render({ at: '/', badges: { sessions: 4 } })).toMatch(/>4<\/span>/)
  })
  it('collapsed has icons with aria-label and no search', () => {
    const html = render({ at: '/', collapsed: true })
    expect(html).toContain('aria-label="Sessões"')
    expect(html).not.toContain('Buscar')
  })
  it('sheet variant uses 46px areas and 44px subpages', () => {
    const html = render({ at: '/usage', variant: 'sheet' })
    expect(html).toContain('min-height:46px')
    expect(html).toContain('min-height:44px')
  })
})
