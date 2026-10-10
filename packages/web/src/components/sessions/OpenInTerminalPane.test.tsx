import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OpenInTerminalPane, openInTerminalFor } from './OpenInTerminalPane'

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
  test('a TUI row (no enabled `terminal` verb) keeps its terminal pane: no door', () => {
    const act = async () => ({ ok: true, message: '' })
    expect(openInTerminalFor(undefined, act)).toBeUndefined()
    expect(openInTerminalFor({ id: 'a', state: 'waiting', verbs: [{ action: 'attach', enabled: true }] }, act)).toBeUndefined()
    expect(openInTerminalFor({ id: 'a', state: 'waiting', verbs: [{ action: 'terminal', enabled: false }] }, act)).toBeUndefined()
  })
  test('a structured row: the door calls the server verb `terminal` on that row', async () => {
    const calls: unknown[] = []
    const act = async (req: { id: string; action: 'terminal' }) => { calls.push(req); return { ok: true, message: 'ok' } }
    const door = openInTerminalFor({ id: 'r1', state: 'working', verbs: [{ action: 'terminal', enabled: true }] }, act)
    expect(door?.state).toBe('working')
    await door?.open()
    expect(calls).toEqual([{ id: 'r1', action: 'terminal' }])
  })
})
