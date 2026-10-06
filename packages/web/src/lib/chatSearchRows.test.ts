import { describe, expect, test } from 'bun:test'
import { searchChatTurns } from '@agentistics/core'
import { chatSearchMenu, chatSearchRow, excerptSegments } from './chatSearchRows'
import { findTurnIndex, registerChatSearchTarget, requestChatSearch } from './chatSearchBridge'

const NOW = Date.parse('2026-10-06T15:00:00Z')

describe('chatSearchRow — one result as the panel draws it', () => {
  const page = searchChatTurns([
    { role: 'user', text: 'Pode revisar a função de migração?', at: '2026-10-06T14:00:00Z' },
    { role: 'assistant', text: 'Revisei a migracao; está ok.', at: '2026-09-20T10:00:00Z' },
  ], 'migracao')

  // Newest POSITION first: hits[0] is the assistant's reply (index 1), hits[1] the question.
  test('the person is "Você", the assistant is named and coloured like its bubble', () => {
    const reply = chatSearchRow(page.hits[0]!, 'codex', 'pt', NOW)
    const question = chatSearchRow(page.hits[1]!, 'codex', 'pt', NOW)
    expect(question.mine).toBe(true)
    expect(question.who).toBe('Você')
    expect(question.color).toBeUndefined()
    expect(reply.mine).toBe(false)
    expect(reply.who).toBe('Codex CLI')
    expect(reply.color).toBe('#10a37f')
  })

  test('time today is the hour; another day carries the date', () => {
    const today = chatSearchRow(page.hits[1]!, 'claude', 'pt', NOW)
    const older = chatSearchRow(page.hits[0]!, 'claude', 'pt', NOW)
    expect(today.time?.label).toMatch(/^\d{2}:\d{2}$/)
    expect(older.time?.label).not.toMatch(/^\d{2}:\d{2}$/)
  })

  test('the excerpt is cut into plain and marked segments that rebuild it exactly', () => {
    const row = chatSearchRow(page.hits[1]!, 'claude', 'pt', NOW)
    expect(row.segments.map(s => s.text).join('')).toBe(page.hits[1]!.excerpt)
    expect(row.segments.filter(s => s.mark).map(s => s.text)).toEqual(['migração'])
  })

  test('an unknown harness falls back to its own id, never an empty name', () => {
    expect(chatSearchRow(page.hits[0]!, 'quokka', 'en', NOW).who).toBe('quokka')
    expect(chatSearchRow(page.hits[0]!, undefined, 'en', NOW).who).toBe('Assistant')
  })
})

describe('excerptSegments', () => {
  test('clamps spans that run past the end or overlap', () => {
    expect(excerptSegments('abcdef', [{ start: 4, end: 99 }, { start: 1, end: 2 }, { start: 1, end: 3 }]))
      .toEqual([
        { text: 'a', mark: false }, { text: 'b', mark: true }, { text: 'c', mark: true },
        { text: 'd', mark: false }, { text: 'ef', mark: true },
      ])
  })
})

describe('the result menu', () => {
  test('offers Copy, Forward and Go to the message, in that order', () => {
    expect(chatSearchMenu('pt').map(e => e.label)).toEqual(['Copiar', 'Encaminhar', 'Ir até a mensagem'])
    expect(chatSearchMenu('en').map(e => e.action)).toEqual(['copy', 'forward', 'goto'])
  })
})

describe('chatSearchBridge', () => {
  const turn = { role: 'assistant' as const, text: 'olá  mundo', at: '2026-10-06T10:00:00Z' }

  test('with no chat on screen the answer is no-chat, never a silent nothing', () => {
    expect(requestChatSearch('nobody', { kind: 'goto', turn })).toBe('no-chat')
  })

  test('the most recently mounted chat for the session answers, and unregistering removes it', () => {
    const seen: string[] = []
    const off1 = registerChatSearchTarget('s1', r => { seen.push(`a:${r.kind}`); return 'done' })
    const off2 = registerChatSearchTarget('s1', r => { seen.push(`b:${r.kind}`); return 'not-loaded' })
    expect(requestChatSearch('s1', { kind: 'forward', turn })).toBe('not-loaded')
    off2()
    expect(requestChatSearch('s1', { kind: 'goto', turn })).toBe('done')
    off1()
    expect(requestChatSearch('s1', { kind: 'goto', turn })).toBe('no-chat')
    expect(seen).toEqual(['b:forward', 'a:goto'])
  })

  test('findTurnIndex matches role, instant and text (whitespace-blind), newest first', () => {
    const turns = [
      { role: 'assistant' as const, text: 'olá mundo', at: '2026-10-06T10:00:00Z' },
      { role: 'user' as const, text: 'olá mundo', at: '2026-10-06T10:00:00Z' },
      { role: 'assistant' as const, text: 'outra', at: '2026-10-06T10:01:00Z' },
    ]
    expect(findTurnIndex(turns, turn)).toBe(0)
    expect(findTurnIndex(turns, { ...turn, at: '2026-10-06T11:00:00Z' })).toBe(-1)
    expect(findTurnIndex(turns, { role: 'user', text: 'nada' })).toBe(-1)
  })
})
