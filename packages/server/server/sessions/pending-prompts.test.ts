import { beforeEach, describe, expect, it } from 'bun:test'
import { PENDING_TTL_MS, clearPrompts, migratePrompts, pendingFor, recordPrompt, resetPrompts } from './pending-prompts'

const CONV = 'conv-1'

beforeEach(() => resetPrompts())

describe('pendingFor', () => {
  it('THE REPORTED CASE: a message is held for EVERY device, not just the tab that sent it', () => {
    // "a mensagem não aparece em todos os dispositivos… só aparece quando realmente é recebida".
    // The queue was a browser fact; it is a server one now, so any reader of this conversation sees
    // the same list.
    recordPrompt(CONV, 'roda os testes')
    expect(pendingFor(CONV, []).map(p => p.text)).toEqual(['roda os testes'])
    expect(pendingFor(CONV, []).map(p => p.text)).toEqual(['roda os testes'])
  })

  it('carries WHEN it was sent, which is what a reopened app had lost', () => {
    // "se eu fechar a aplicação e abrir de novo a mensagem vira um fantasma e não dá pra saber se
    // foi perdida ou está em fila". The age lived in the tab; now it comes with the message.
    recordPrompt(CONV, 'oi', 1_000)
    expect(pendingFor(CONV, [], 2_000)[0]!.at).toBe(1_000)
  })

  it('is retired the moment the transcript accounts for it', () => {
    recordPrompt(CONV, 'roda os testes')
    expect(pendingFor(CONV, ['roda os testes'])).toEqual([])
    // ...and stays retired: the store is rewritten to what survived, so two reads cannot disagree.
    expect(pendingFor(CONV, [])).toEqual([])
  })

  it('uses the SAME rule as the browser — containment, not equality', () => {
    // A harness mid-turn queues arrivals and commits them as one turn, so a message is stored
    // JOINED to another. `pendingEchoes` is shared with the web for exactly this.
    recordPrompt(CONV, 'e depois roda o lint por favor')
    expect(pendingFor(CONV, ['> algo antes\n> e depois roda o lint por favor\r\n'])).toEqual([])
  })

  it('EXPIRES, so a message the harness dropped does not wait forever on every device', () => {
    // Without a ceiling the ghost simply moves from one browser to all of them.
    recordPrompt(CONV, 'uma mensagem que se perdeu', 0)
    expect(pendingFor(CONV, [], PENDING_TTL_MS - 1)).toHaveLength(1)
    expect(pendingFor(CONV, [], PENDING_TTL_MS + 1)).toEqual([])
  })

  it('keeps conversations apart, and refuses what it cannot key', () => {
    recordPrompt(CONV, 'a')
    recordPrompt('conv-2', 'b')
    expect(pendingFor(CONV, []).map(p => p.text)).toEqual(['a'])
    expect(pendingFor('conv-2', []).map(p => p.text)).toEqual(['b'])
    recordPrompt('', 'nowhere')
    recordPrompt(CONV, '   ')
    expect(pendingFor(CONV, []).map(p => p.text)).toEqual(['a'])
  })

  it('an unknown conversation is empty, never a throw', () => {
    expect(pendingFor('never-seen', [])).toEqual([])
  })

  it('clearPrompts drops the queue', () => {
    recordPrompt(CONV, 'a')
    clearPrompts(CONV)
    expect(pendingFor(CONV, [])).toEqual([])
  })
})

describe('CHAT.FIRST — an echo recorded before the conversation is linked', () => {
  const ROW = 'row-abc'
  it('is held under the managed row id until a link exists', () => {
    recordPrompt(ROW, 'first message', 1000)
    expect(pendingFor(ROW, [], 2000).map(p => p.text)).toEqual(['first message'])
  })
  it('migrates to the conversation id when the link appears, losing nothing', () => {
    recordPrompt(ROW, 'one', 1000)
    recordPrompt(ROW, 'two', 2000)
    migratePrompts(ROW, CONV)
    expect(pendingFor(ROW, [], 3000)).toEqual([])
    expect(pendingFor(CONV, [], 3000).map(p => p.text)).toEqual(['one', 'two'])
  })
  it('does not duplicate on a repeated migration, nor against what the conversation already holds', () => {
    recordPrompt(CONV, 'same', 1000)
    recordPrompt(ROW, 'same', 1000)
    migratePrompts(ROW, CONV)
    migratePrompts(ROW, CONV)
    expect(pendingFor(CONV, [], 2000)).toHaveLength(1)
  })
  it('retires once the transcript carries the message, after migration', () => {
    recordPrompt(ROW, 'hello', 1000)
    migratePrompts(ROW, CONV)
    expect(pendingFor(CONV, ['hello'], 2000)).toEqual([])
  })
})
