import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { MobileActionTile, MobileAreaBar } from './MobileAreaBar'

function render(pathname: string, attention?: number, lang: 'pt' | 'en' = 'pt') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[pathname]}>
      <MobileAreaBar lang={lang} pathname={pathname} attention={attention} onNavigate={() => {}} actions={[]} />
    </MemoryRouter>,
  )
}

describe('MobileAreaBar', () => {
  test('the place pill names the current registry area and page', () => {
    const html = render('/usage')
    expect(html).toContain('Uso › Agora ▾')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain('role="dialog"')
    expect(render('/usage/history')).toContain('Uso › Histórico ▾')
    expect(render('/usage', undefined, 'en')).toContain('Usage › Now ▾')
  })

  test('single-page areas do not repeat the area name in a breadcrumb', () => {
    const html = render('/sessions')
    expect(html).toContain('Sessões ▾')
    expect(html).not.toContain('Sessões ›')
    expect(html).toContain('aria-label="Sessões" aria-current="page"')
  })

  test('the round shortcut reports attention only when measured and positive', () => {
    const html = render('/usage', 4)
    expect(html).toContain('aria-label="Sessões, 4 precisam de você"')
    expect(html).toMatch(/>4<\/span>/)
    for (const count of [undefined, 0]) {
      const idle = render('/usage', count)
      expect(idle).not.toContain('precisam de você')
      expect(idle).not.toContain('>0</span>')
    }
  })

  test('both bar buttons have at least 44px targets and the shortcut is round', () => {
    const buttons = render('/usage').match(/<button\b[^>]*>/g) ?? []
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      expect(button).toContain('min-width:44px')
      expect(button).toContain('min-height:44px')
      expect(button).toContain('height:52px')
    }
    expect(buttons[1]).toContain('flex:0 0 52px')
  })

  test('the moved action tile keeps its badge and a full touch target', () => {
    const html = renderToStaticMarkup(<MobileActionTile tile={{ key: 'refresh', label: 'Refresh', icon: RefreshCw, onClick: () => {}, badge: 'EN' }} />)
    expect(html).toContain('min-width:44px')
    expect(html).toContain('min-height:64px')
    expect(html).toContain('Refresh')
    expect(html).toContain('>EN</span>')
  })
})
