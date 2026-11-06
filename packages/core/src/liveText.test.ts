import { describe, expect, test } from 'bun:test'
import { humanizeAction, looksLikeJson, plainLeaderName, shortTitle } from './liveText'

const titles: Record<string, string> = { w1: 'LIVE.LIDERES · cartões dos líderes' }
const titleOf = (id: string) => titles[id]

describe('humanizeAction', () => {
  test('the raw payload from the owner\'s print becomes a sentence', () => {
    const raw = '↳ {"message":{"to":"2ad6ecbd30","kind":"handback","from":"w1"}}'
    expect(humanizeAction(raw, 'pt', titleOf)).toBe('handback de LIVE.LIDERES · cartões dos líderes')
    expect(humanizeAction(raw, 'en', titleOf)).toBe('handback from LIVE.LIDERES · cartões dos líderes')
  })
  test('an unknown sender keeps its id rather than inventing a name', () => {
    expect(humanizeAction('{"message":{"kind":"block","from":"abc123"}}', 'pt')).toBe('bloqueio de abc123')
  })
  test('a line cut mid-object still never shows braces', () => {
    const out = humanizeAction('{"message":{"to":"x","kind":"question","from":"w1"', 'pt', titleOf)!
    expect(out).toBe('pergunta de LIVE.LIDERES · cartões dos líderes')
    expect(humanizeAction('{"a":1', 'pt')).not.toContain('{')
  })
  test('JSON with no message kind is neutral, plain text passes through trimmed to one line', () => {
    expect(humanizeAction('{"tool":"Read","input":{}}', 'pt')).toBe('atividade interna do agente')
    expect(humanizeAction('  ↳ rodando a suíte\nsegunda linha', 'pt')).toBe('rodando a suíte')
    expect(humanizeAction('', 'pt')).toBeNull()
    expect(humanizeAction(undefined, 'pt')).toBeNull()
  })
  test('looksLikeJson', () => {
    expect(looksLikeJson('↳ {"a":1}')).toBe(true)
    expect(looksLikeJson('a {b} c')).toBe(false)
  })
})

describe('shortTitle', () => {
  test('short titles are untouched', () => expect(shortTitle('LINK.VIA · via da conversa')).toBe('LINK.VIA · via da conversa'))
  test('a long subtask text is cut at its first clause', () => {
    const t = 'LIVE.LIDERES · dono 06/11 ~18:45Z (prints dfad590c, e727fabe): cartões dos líderes minimizados por padrão com resumo'
    const s = shortTitle(t)
    expect(s.length).toBeLessThanOrEqual(60)
    expect(s.startsWith('LIVE.LIDERES · dono 06/11 ~18:45Z')).toBe(true)
  })
  test('with no clause end it cuts at a word and adds an ellipsis', () => {
    const s = shortTitle('palavra '.repeat(30))
    expect(s.endsWith('…')).toBe(true)
    expect(s.length).toBeLessThanOrEqual(61)
  })
})

test('plainLeaderName strips the decoration', () => {
  expect(plainLeaderName('[ LÍDER ] - Motor')).toBe('Motor')
  expect(plainLeaderName('Motor')).toBe('Motor')
})
