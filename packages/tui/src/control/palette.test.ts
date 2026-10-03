import { describe, expect, test } from 'bun:test'
import { CODE_COMMANDS } from './code'
import { resolveShellKey } from './nav'
import { codeScoped, filterCommands, PALETTE_COMMANDS, whyNot } from './palette'

const ctx = (over = {}) => ({ hasCode: true, sessionOpen: false, running: false, askWithDiff: false, ...over })

describe('command palette (GL-03)', () => {
  test('ONE list: the code tab\'s / popup is the palette\'s code scope, same names, same shortcuts, same order', () => {
    expect(CODE_COMMANDS.map(c => [c.label, c.keys])).toEqual(codeScoped().map(c => [c.label, c.keys]))
    expect(new Set(PALETTE_COMMANDS.map(c => c.label)).size).toBe(PALETTE_COMMANDS.length)
  })
  test('every command carries a shortcut column (empty only where there is none) and both languages', () => {
    for (const c of PALETTE_COMMANDS) {
      expect(c.label.startsWith('/')).toBe(true)
      expect(c.description.en.length).toBeGreaterThan(3)
      expect(c.description.pt.length).toBeGreaterThan(3)
    }
  })
  test('filtering by name or description, in either language; empty shows all', () => {
    expect(filterCommands('', 'en')).toHaveLength(PALETTE_COMMANDS.length)
    expect(filterCommands('/sess', 'en')[0]!.id).toBe('sessions')
    expect(filterCommands('/sess', 'en').map(c => c.id)).toContain('new') // "start a session"
    expect(filterCommands('diff', 'en').map(c => c.id)).toContain('diff')
    expect(filterCommands('idioma', 'pt').map(c => c.id)).toEqual([])
    expect(filterCommands('tarefas', 'pt').map(c => c.id)).toContain('tasks')
    expect(filterCommands('zzz', 'en')).toEqual([])
  })
  test('inapplicable commands stay listed and say why', () => {
    const byId = (id: string) => PALETTE_COMMANDS.find(c => c.id === id)!
    expect(whyNot(byId('mode'), ctx(), 'en')).toContain('no native session is open')
    expect(whyNot(byId('mode'), ctx({ sessionOpen: true }), 'en')).toBeNull()
    expect(whyNot(byId('diff'), ctx({ sessionOpen: true }), 'en')).toContain('nothing waits on you with a diff')
    expect(whyNot(byId('cancel'), ctx({ sessionOpen: true }), 'pt')).toBe('nada está rodando')
    expect(whyNot(byId('new'), ctx({ hasCode: false }), 'en')).toBe('this build has no native harness')
    expect(whyNot(byId('providers'), ctx(), 'en')).toContain('P5')
    expect(whyNot(byId('sessions'), ctx(), 'en')).toBeNull()
  })
  test('ctrl+p is the shell\'s palette key on every tab', () => {
    expect(resolveShellKey({ input: 'p', ctrl: true }, { tab: 'services', arrows: true, mouse: false })).toEqual({ kind: 'palette' })
  })
})

describe('the native harness is experimental (gate off)', () => {
  test('native commands say the gate sentence instead of "no native harness"', async () => {
    const { PALETTE_COMMANDS, whyNot } = await import('./palette')
    const gate = 'experimental — agentop experimental enable'
    const ctx = { hasCode: false, sessionOpen: false, running: false, askWithDiff: false, gate }
    const code = PALETTE_COMMANDS.find(c => c.id === 'code')!
    const mode = PALETTE_COMMANDS.find(c => c.id === 'mode')!
    expect(whyNot(code, ctx, 'en')).toBe(gate)
    expect(whyNot(mode, ctx, 'en')).toBe(gate)
    expect(whyNot(PALETTE_COMMANDS.find(c => c.id === 'sessions')!, ctx, 'en')).toBeNull()
  })
})
