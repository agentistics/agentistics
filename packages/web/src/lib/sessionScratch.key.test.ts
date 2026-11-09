import { describe, expect, it, test } from 'bun:test'
import { createSessionScratch, scratchKey } from './sessionScratch'

/**
 * The bug these pin: a conversation is reachable through SEVERAL rows, and scratch keyed on the row
 * threw the cached turns (and the typed draft) away every time you arrived through a different one.
 */
describe('scratchKey — scratch belongs to the conversation, not the row', () => {
  it('gives a managed row and its closed twin the SAME key', () => {
    // Measured on a real fleet: `95df320c63` (exited) and `closed:e94094a8-…` are one conversation.
    const managed = scratchKey({ id: '95df320c63', conversationId: 'e94094a8-7138-466a-abc7-aba249c45b84' })
    const closed = scratchKey({ id: 'closed:e94094a8-7138-466a-abc7-aba249c45b84' })
    expect(managed).toBe(closed)
  })

  it('survives a reopen, which mints a new managedId for the same conversation', () => {
    const before = scratchKey({ id: 'aaaaaaaaaa', conversationId: 'c-1' })
    const after = scratchKey({ id: 'bbbbbbbbbb', conversationId: 'c-1' })
    expect(after).toBe(before)
  })

  it('falls back to the row when the harness cannot report a conversation', () => {
    expect(scratchKey({ id: 'aaaaaaaaaa' })).toBe('row:aaaaaaaaaa')
  })

  it('never lets a row id collide with a conversation id', () => {
    // A harness whose conversation ids look like our managed ids must not read another row's draft.
    expect(scratchKey({ id: 'x1' })).not.toBe(scratchKey({ id: 'other', conversationId: 'x1' }))
  })

  it('keeps two different conversations apart', () => {
    expect(scratchKey({ id: 'a', conversationId: 'c-1' })).not.toBe(scratchKey({ id: 'a', conversationId: 'c-2' }))
  })
})

describe('MENSAGENS.KILL — the draft and the echoes outlive the session', () => {
  const map = new Map<string, string>()
  const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }
  const live = { id: 'agentop-aaa', conversationId: 'conv-1' }
  const killed = { id: 'agentop-aaa', conversationId: 'conv-1' }
  const closedTwin = { id: 'closed:conv-1' }
  const reopened = { id: 'agentop-bbb', conversationId: 'conv-1' }

  test('a half-typed draft and a queued echo survive the kill, the closed twin and a reopen', () => {
    const scratch = createSessionScratch(store)
    scratch.writeDraft(scratchKey(live), 'half a thought')
    scratch.writeEchoes(scratchKey(live), ['sent behind a busy turn'])
    for (const row of [killed, closedTwin, reopened]) {
      expect(scratch.readDraft(scratchKey(row))).toBe('half a thought')
      expect(scratch.readEchoes(scratchKey(row))).toEqual(['sent behind a busy turn'])
    }
  })

  test('survives a reload of the tab (new scratch over the same storage)', () => {
    const again = createSessionScratch(store)
    expect(again.readDraft(scratchKey(reopened))).toBe('half a thought')
  })
})
