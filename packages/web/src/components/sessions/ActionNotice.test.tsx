import React from 'react'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActionNotice, actionNoticeSummary, NOTICE_MS } from './ActionNotice'

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


// ACTION-NOTICE.TRANSIENT — a short confirmation is a bottom toast of at most 2 s with a shrinking bar.
test('a short confirmation is transient: bottom-fixed, a bar that runs exactly NOTICE_MS, X still closes it', () => {
  expect(NOTICE_MS).toBe(2000)
  const h = renderToStaticMarkup(<ActionNotice message="Jarvis encerrada." lang="pt" onDismiss={() => {}} />)
  expect(h).toContain('data-transient="true"')
  expect(h).toContain('class="ag-action-toast"')
  expect(h).toContain('data-notice-progress')
  expect(h).toContain('animation:ag-notice-shrink 2000ms linear forwards')
  expect(h).toContain('Fechar aviso')
})
test('a notice with Details is a diagnostic: no clock, no bar, inline where it was', () => {
  const h = renderToStaticMarkup(<ActionNotice message={'diagnostics '.repeat(30)} lang="en" onDismiss={() => {}} />)
  expect(h).not.toContain('data-transient')
  expect(h).not.toContain('data-notice-progress')
  expect(h).not.toContain('ag-action-toast')
})

test('the toast class pins it to the BOTTOM edge, above the phone bottom bar, and never to the top', async () => {
  const css = await Bun.file(new URL('../../index.css', import.meta.url)).text()
  const rule = css.match(/\.ag-action-toast \{[^}]*\}/)![0]
  expect(rule).toContain('position: fixed')
  expect(rule).toMatch(/bottom: 20px/)
  expect(rule).not.toMatch(/(^|[^-])top:/)
  expect(css).toMatch(/@media \(max-width: 767px\) \{ \.ag-action-toast \{ bottom: calc\(var\(--mobile-nav-h\) \+ 12px\)/)
  expect(css).toContain('@keyframes ag-notice-shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }')
})
