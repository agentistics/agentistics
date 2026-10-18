import React from 'react'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ModeSwitch } from './ModeSwitch'

test('both workspace labels and attention counts remain available without truncation', () => {
  for (const lang of ['pt', 'en'] as const) {
    const html = renderToStaticMarkup(<MemoryRouter><ModeSwitch lang={lang} attention={123} /></MemoryRouter>)
    expect(html).toContain(lang === 'pt' ? 'Painel' : 'Dashboard')
    expect(html).toContain(lang === 'pt' ? 'Sessões' : 'Sessions')
    expect(html).toContain('>123</span>')
    expect(html).not.toMatch(/ellipsis|overflow:hidden/)
    expect(html).toContain('container-name:workspace-mode')
  }
})

test('collapsed workspace switch keeps accessible labels and the attention count', () => {
  for (const lang of ['pt', 'en'] as const) {
    const html = renderToStaticMarkup(<MemoryRouter><ModeSwitch lang={lang} collapsed attention={2} /></MemoryRouter>)
    expect(html).toContain(`aria-label="${lang === 'pt' ? 'Sessões' : 'Sessions'}"`)
    expect(html).toContain(`title="${lang === 'pt' ? 'Painel' : 'Dashboard'}"`)
    expect(html).toContain('>2</span>')
    expect(html).toContain('flex-direction:column')
  }
})
