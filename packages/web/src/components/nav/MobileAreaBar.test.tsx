import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { MobileActionRow, MobileAreaBar } from './MobileAreaBar'

function render(pathname: string, attention?: number, lang: 'pt' | 'en' = 'pt') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[pathname]}>
      <MobileAreaBar lang={lang} pathname={pathname} attention={attention} onNavigate={() => {}} actions={[]} />
    </MemoryRouter>,
  )
}

describe('MobileAreaBar', () => {
  test('option A has five equal destinations in the approved order', () => {
    for (const lang of ['pt', 'en'] as const) {
      const html = render('/usage', undefined, lang)
      expect(html.match(/<button\b/g) ?? []).toHaveLength(5)
      const labels = lang === 'pt' ? ['Agentask', 'Uso', 'Sessões', 'Métricas', 'Mais'] : ['Agentask', 'Usage', 'Sessions', 'Metrics', 'More']
      let at = -1
      for (const label of labels) { at = html.indexOf(`>${label}</span>`, at + 1); expect(at).toBeGreaterThan(-1) }
      for (const button of html.match(/<button\b[^>]*>/g) ?? []) {
        expect(button).toContain('flex:1')
        expect(button).toContain('min-width:0')
        expect(button).toContain('min-height:44px')
      }
      expect(html).toContain('background:rgba(17, 17, 24, 0.84)')
      expect(html).toContain('aria-haspopup="dialog"')
      expect(html).toContain('aria-expanded="false"')
      expect(html).not.toContain('role="dialog"')
    }
  })

  test('the centre becomes Home throughout the Sessions area, including open conversations', () => {
    for (const pathname of ['/sessions', '/sessions/abc', '/leadership/checkins']) {
      for (const lang of ['pt', 'en'] as const) {
        const html = render(pathname, 2, lang)
        expect(html).toContain(lang === 'pt' ? '>Início</span>' : '>Home</span>')
        expect(html).toContain('lucide-house')
        expect(html).toContain('border-radius:50%')
        expect(html).toContain('width:40px;height:40px')
        expect(html.match(/<button\b/g) ?? []).toHaveLength(5)
      }
    }
    expect(render('/usage')).toContain('lucide-terminal')
  })

  test('the central destination reports attention only when measured and positive', () => {
    const html = render('/usage', 4)
    expect(html).toContain('aria-label="Sessões, 4 precisam de você"')
    expect(html).toContain('background:var(--anthropic-orange);color:#0a0a0f')
    expect(html).toMatch(/>4<\/span>/)
    for (const count of [undefined, 0]) {
      const idle = render('/usage', count)
      expect(idle).not.toContain('precisam de você')
      expect(idle).not.toContain('>0</span>')
    }
  })

  test('global action rows share area geometry and show their current value', () => {
    const html = renderToStaticMarkup(<MobileActionRow action={{ key: 'lang', label: 'Language', icon: RefreshCw, onClick: () => {}, value: 'EN' }} />)
    expect(html).toContain('width:100%')
    expect(html).toContain('min-height:46px')
    expect(html).toContain('Language')
    expect(html).toContain('>EN</span>')
    expect(html).not.toContain('lucide-chevron-right')
  })

  test('the update row has its description and badge; hardware has a trailing chevron', () => {
    const html = renderToStaticMarkup(<MobileActionRow action={{ key: 'update-app', label: 'Atualizar app', icon: RefreshCw, onClick: () => {}, accent: true, description: 'Nova versão disponível', badge: 'NOVO' }} />)
    expect(html).toContain('Atualizar app')
    expect(html).toContain('Nova versão disponível')
    expect(html).toContain('>NOVO</span>')
    expect(html).toContain('border-color:var(--anthropic-orange)')
    const hardware = renderToStaticMarkup(<MobileActionRow action={{ key: 'hardware', label: 'Hardware', icon: RefreshCw, onClick: () => {} }} />)
    expect(hardware).toContain('lucide-chevron-right')
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
