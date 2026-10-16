import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SystemEventRow } from './ChatBubble'

describe('SystemEventRow', () => {
  test('collapsed: one localized line, no echo chrome, body hidden', () => {
    const html = renderToStaticMarkup(<SystemEventRow event={{ kind: 'handback', sender: 'ab12', body: 'all green' }} pt titleOf={() => 'Migração'} />)
    expect(html).toContain('Sessão Migração entregou')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('all green')
    expect(html).not.toContain('Enviar agora')
    expect(html).not.toContain('entregue à sessão')
  })
  test('falls back to the short id without a title', () => {
    const html = renderToStaticMarkup(<SystemEventRow event={{ kind: 'block', sender: 'ab12', body: 'x' }} pt={false} />)
    expect(html).toContain('Session ab12 is blocked')
  })
  test('expanded: the full text shows', () => {
    const html = renderToStaticMarkup(<SystemEventRow event={{ kind: 'handback', sender: 'ab12', body: 'all green' }} pt={false} defaultOpen />)
    expect(html).toContain('all green')
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('Send now')
  })
})
