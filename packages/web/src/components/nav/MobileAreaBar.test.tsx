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
    // Quiet area, bold page, a lucide chevron — never a text "▾".
    expect(html).toContain('Uso ›</span> <b>Agora</b>')
    expect(html).toContain('lucide-chevron-down')
    expect(html).not.toContain('▾')
    expect(html).toContain('aria-label="Ir para · Uso › Agora"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain('role="dialog"')
    expect(render('/usage/history')).toContain('<b>Histórico</b>')
    expect(render('/usage', undefined, 'en')).toContain('Usage ›</span> <b>Now</b>')
  })

  test('single-page areas do not repeat the area name in a breadcrumb', () => {
    for (const lang of ['pt', 'en'] as const) {
      const html = render('/sessions', 3, lang)
      const name = lang === 'pt' ? 'Sessões' : 'Sessions'
      expect(html).toContain(`<b>${name}</b>`)
      expect(html).not.toContain(`${name} ›`)
      // On Sessions the round shortcut would lead to the page already open: it is not drawn.
      expect(html.match(/<button\b/g) ?? []).toHaveLength(1)
    }
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

describe('AreaTree search in the sheet', () => {
  test('a phone gets a 44px field without a keyboard shortcut hint; desktop keeps Ctrl K', async () => {
    const { AreaTree } = await import('./AreaTree')
    for (const lang of ['pt', 'en'] as const) {
      const sheet = renderToStaticMarkup(<MemoryRouter><AreaTree lang={lang} pathname="/usage" variant="sheet" onNavigate={() => {}} /></MemoryRouter>)
      expect(sheet).not.toContain('Ctrl K')
      expect(sheet).not.toMatch(/placeholder="[^"]*  /)
      expect(sheet).toContain('min-height:44px')
      const aside = renderToStaticMarkup(<MemoryRouter><AreaTree lang={lang} pathname="/usage" onNavigate={() => {}} /></MemoryRouter>)
      expect(aside).toContain('Ctrl K')
      expect(aside).not.toMatch(/placeholder="[^"]*  /)
    }
  })
})

test('the collapsed stats strip in the phone header is a 44px target', async () => {
  const { readFileSync } = await import('node:fs')
  const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
  // The phone header's strip (the desktop has its own hanging tab on the same handler).
  const at = app.indexOf('onClick={toggleFleet}\n                style={{')
  expect(at).toBeGreaterThan(-1)
  expect(app.slice(at, at + 200)).toContain('minHeight: 44')
})
