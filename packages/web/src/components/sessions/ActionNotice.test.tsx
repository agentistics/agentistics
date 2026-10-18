import React from 'react'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActionNotice, actionNoticeSummary } from './ActionNotice'

test('long memory refusals stay compact; diagnostics need an explicit disclosure', () => {
  const message = 'Sem memória livre: sessão na fila. pid 123456 agentop restart server ' + 'diagnóstico '.repeat(100)
  for (const lang of ['pt', 'en']) {
    const h = renderToStaticMarkup(<ActionNotice message={message} lang={lang} onDismiss={() => {}} />)
    const visible = h.split('<details')[0]!
    expect(visible).not.toMatch(/pid|agentop|diagnóstico|ellipsis/)
    expect(actionNoticeSummary(message, lang).length).toBeLessThan(85)
    expect(h).toContain('<details')
    expect(h).not.toContain('<details open')
    expect(h).toContain(message)
    expect(h).toContain(lang === 'pt' ? 'Detalhes' : 'Details')
    expect(h).toContain(lang === 'pt' ? 'Fechar aviso' : 'Dismiss notice')
    expect(h).not.toContain('position:absolute')
  }
})

test('short feedback stays readable and empty conversations have a plain explanation', () => {
  expect(actionNoticeSummary('Filed', 'en')).toBe('Filed')
  expect(actionNoticeSummary('nenhuma conversa para reabrir — id 1234', 'pt')).toBe('Esta sessão ainda não tem conversa para reabrir.')
  const h = renderToStaticMarkup(<ActionNotice message="Filed" lang="en" onDismiss={() => {}} />)
  expect(h).not.toContain('<details')
})


test('expanded notice diagnostics have a bounded keyboard-scrollable region', () => {
  for (const lang of ['pt', 'en']) {
    const html = renderToStaticMarkup(<ActionNotice message={'diagnostics '.repeat(100)} lang={lang} onDismiss={() => {}} />)
    expect(html).toContain('role="region"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('overflow-y:scroll')
    expect(html).toContain('max-height:min(180px, calc(20dvh / var(--ui-zoom, 1)))')
    expect(html).toContain('border:1px solid var(--border-subtle)')
    expect(html).toContain(lang === 'pt' ? 'Detalhes do aviso' : 'Notice details')
  }
})

test('multiline feedback reserves space before the details disclosure and its focus ring', () => {
  const html = renderToStaticMarkup(<ActionNotice message={'memory queue diagnostics '.repeat(20)} lang="en" onDismiss={() => {}} />)
  const root = html.split('><div')[0]!
  expect(root).toContain('flex-shrink:0')
  expect(root).toContain('display:flex;flex-direction:column;gap:6px')
  expect(html).toContain('overflow-wrap:anywhere')
  expect(html).not.toMatch(/line-clamp|position:absolute|height:0/)
})
