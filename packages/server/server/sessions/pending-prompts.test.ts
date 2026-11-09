import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PENDING_TTL_MS, clearPrompts, migratePrompts, pendingFor, recordPrompt, reloadPrompts, resetPrompts, strandedFor, STRANDED_KEEP_MS, MAX_STORED_PROMPTS, usePromptStoreForTests } from './pending-prompts'
import { parseAntigravityChat } from './antigravity-chat'
import { parseCodexChat } from './codex-chat'
import { parseCopilotChat } from './copilot-chat'
import { parseGeminiChatTurns } from './gemini-chat'
import { parseKimiChat } from './kimi-chat'

const CONV = 'conv-1'
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  usePromptStoreForTests(join(mkdtempSync(join(tmpdir(), 'pending-prompts-')), 'pending-prompts.json'))
  resetPrompts()
})

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

  it('retires a short Claude mid-turn message at its exact queued line', () => {
    recordPrompt(CONV, 'ok')
    // Claude's queued-command transcript joins the mid-turn message to the preceding input and
    // prefixes both lines with `> `. The exact-line rule handles the short `ok` without fuzzy
    // containment.
    expect(pendingFor(CONV, ['> previous work\n> ok\r\n'])).toEqual([])
  })

  const harnessFixtures: Array<[string, string[]]> = [
    ['codex', [JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'before\nok' }] } })]],
    ['gemini', [JSON.stringify({ type: 'user', content: 'before\nok' })]],
    ['copilot', [JSON.stringify({ type: 'user.message', data: { content: 'before\nok' } })]],
    ['kimi', [JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'before\nok' }], origin: { kind: 'user' } } })]],
    ['antigravity', [JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>before\nok</USER_REQUEST>' })]],
  ]

  for (const [harness, lines] of harnessFixtures) it(`retires a short mid-turn message for ${harness}`, () => {
      const turns = harness === 'codex' ? parseCodexChat(lines, 'codex')
        : harness === 'gemini' ? parseGeminiChatTurns(lines, 10)
          : harness === 'copilot' ? parseCopilotChat(lines, 'copilot')
            : harness === 'kimi' ? parseKimiChat(lines, 'kimi')
              : parseAntigravityChat(lines, 'antigravity')
      const conversation = `mid-turn-${harness}`
      recordPrompt(conversation, 'ok')
      expect(pendingFor(conversation, turns.filter(t => t.role === 'user').map(t => t.text))).toEqual([])
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

  it('survives a server restart and remains answerable afterwards', () => {
    recordPrompt(CONV, 'approve this change', 1_000)
    reloadPrompts()
    expect(pendingFor(CONV, [], 2_000).map(p => p.text)).toEqual(['approve this change'])
    expect(pendingFor(CONV, ['approve this change'], 2_000)).toEqual([])
    reloadPrompts()
    expect(pendingFor(CONV, [], 2_000)).toEqual([])
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


describe('local command acknowledgements', () => {
  it('retires the command on every device without retiring an earlier mid-turn prompt', () => {
    const prompt = 'Please inspect these queued changes'
    const command = '/rename A sufficiently long name'
    recordPrompt(CONV, prompt)
    recordPrompt(CONV, command)
    expect(pendingFor(CONV, []).map(p => p.text)).toEqual([prompt, command])
    expect(pendingFor(CONV, [command]).map(p => p.text)).toEqual([prompt])
    reloadPrompts()
    expect(pendingFor(CONV, [command]).map(p => p.text)).toEqual([prompt])
    expect(pendingFor(CONV, [command, prompt])).toEqual([])
  })
})

describe('MENSAGENS.KILL — what was typed into a session that died is not lost', () => {
  const HOUR = 60 * 60 * 1000
  it('a message queued behind a hung session is STRANDED after a kill, long past the live TTL', () => {
    recordPrompt(CONV, 'please run the migration', 0)
    // the session hung; the live view gave up on it after the ceiling...
    expect(pendingFor(CONV, [], PENDING_TTL_MS + 1)).toEqual([])
    // ...and it was killed hours later: the message is still there to be resent.
    expect(strandedFor(CONV, [], 3 * HOUR).map(p => p.text)).toEqual(['please run the migration'])
  })
  it('survives a server restart', () => {
    recordPrompt(CONV, 'one', 0)
    pendingFor(CONV, [], PENDING_TTL_MS + 1)
    reloadPrompts()
    expect(strandedFor(CONV, [], HOUR).map(p => p.text)).toEqual(['one'])
  })
  it('a reopened conversation that already carries the text does not offer it again', () => {
    recordPrompt(CONV, 'hello there', 0)
    expect(strandedFor(CONV, ['hello there'], HOUR)).toEqual([])
    expect(strandedFor(CONV, [], HOUR)).toEqual([])
  })
  it('a resend replaces the stranded copy instead of duplicating it', () => {
    recordPrompt(CONV, 'again', 0)
    recordPrompt(CONV, 'again', 2 * HOUR)
    expect(strandedFor(CONV, [], 3 * HOUR)).toEqual([{ text: 'again', at: 2 * HOUR }])
  })
  it('is bounded: a message nobody resent for weeks stops being offered', () => {
    recordPrompt(CONV, 'old', 0)
    expect(strandedFor(CONV, [], STRANDED_KEEP_MS + 1)).toEqual([])
  })
  it('is held under the row id for a session that never linked a conversation', () => {
    recordPrompt('row-x', 'first', 0)
    expect(strandedFor('row-x', [], HOUR).map(p => p.text)).toEqual(['first'])
  })
  it('RETENTION: a 13-day-old stranded message survives a burst of recent ones (cap is not hit by normal load)', () => {
    recordPrompt('old-conv', 'promised for 14 days', 0)
    for (let i = 0; i < 900; i++) recordPrompt(`c${i}`, `m${i}`, 13 * DAY + i)
    expect(strandedFor('old-conv', [], 13 * DAY + 1000).map(p => p.text)).toEqual(['promised for 14 days'])
  })
  it('RETENTION: expired entries are dropped before any live one when the cap is reached', () => {
    for (let i = 0; i < 400; i++) recordPrompt(`dead${i}`, `old${i}`, i)
    for (let i = 0; i < MAX_STORED_PROMPTS; i++) recordPrompt(`live${i}`, `new${i}`, 20 * DAY + i)
    expect(strandedFor('dead0', [], 20 * DAY + MAX_STORED_PROMPTS).length).toBe(0)
    expect(strandedFor('live0', [], 20 * DAY + MAX_STORED_PROMPTS).map(p => p.text)).toEqual(['new0'])
  })
  it('RETENTION: past the cap the OLDEST goes first, never the newest', () => {
    for (let i = 0; i < MAX_STORED_PROMPTS + 5; i++) recordPrompt(`c${i}`, `m${i}`, DAY + i)
    expect(strandedFor('c0', [], DAY + 10_000)).toEqual([])
    expect(strandedFor(`c${MAX_STORED_PROMPTS + 4}`, [], DAY + 10_000).length).toBe(1)
  })
})
