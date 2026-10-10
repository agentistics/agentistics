import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OpenInTerminalPane } from './OpenInTerminalPane'

const open = async () => ({ ok: true, message: '' })

describe('OpenInTerminalPane', () => {
  test('en: names the action and explains it in one sentence', () => {
    const html = renderToStaticMarkup(<OpenInTerminalPane lang="en" theme="dark" isMobile={false} openInTerminal={{ state: 'waiting', open }} />)
    expect(html).toContain('Open in terminal')
    expect(html).toContain('Open the same conversation in a terminal')
  })
  test('pt: Abrir no terminal', () => {
    const html = renderToStaticMarkup(<OpenInTerminalPane lang="pt" theme="light" isMobile openInTerminal={{ state: 'working', open }} />)
    expect(html).toContain('Abrir no terminal')
    expect(html).toContain('Abra a mesma conversa num terminal')
  })
})
