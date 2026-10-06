/**
 * chat-search-web.test.ts — "Buscar na conversa" over every harness the chat can read.
 *
 * Each harness gets a fixture in ITS OWN format, read by ITS REAL reader (`HARNESS_TRANSCRIPTS`) —
 * only `resolve` is stubbed, because where a transcript lives is a fact about a machine and what it
 * says is a fact about the format. The search must find the same message in all six, ignoring case
 * and accents, newest first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HARNESS_TRANSCRIPTS, type HarnessTranscript } from './harness-transcript'
import { forgetChatSearchMemo, searchSessionChat } from './chat-search-web'

const j = (o: unknown): string => JSON.stringify(o)
const Q = 'Como está a função de MIGRAÇÃO?'
const A = 'A migracao roda no boot, sem nada manual.'
const LATER = 'Outra coisa sem relação.'

/** One fixture per harness: the person asks Q, the assistant answers A, the person says LATER. */
const FIXTURES: Record<string, string[]> = {
  claude: [
    j({ type: 'user', message: { content: Q }, timestamp: '2026-10-01T10:00:00Z' }),
    j({ type: 'assistant', message: { content: [{ type: 'text', text: A }] }, timestamp: '2026-10-01T10:00:05Z' }),
    j({ type: 'user', message: { content: LATER }, timestamp: '2026-10-01T10:01:00Z' }),
  ],
  codex: [
    j({ timestamp: '2026-10-01T10:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: Q }] } }),
    j({ timestamp: '2026-10-01T10:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: A }] } }),
    j({ timestamp: '2026-10-01T10:01:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: LATER }] } }),
  ],
  copilot: [
    j({ type: 'user.message', data: { content: Q }, id: '1', timestamp: '2026-10-01T10:00:00Z' }),
    j({ type: 'assistant.message', data: { content: A, toolRequests: [] }, id: '2', timestamp: '2026-10-01T10:00:05Z' }),
    j({ type: 'user.message', data: { content: LATER }, id: '3', timestamp: '2026-10-01T10:01:00Z' }),
  ],
  kimi: [
    j({ time: 1790000000000, type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: Q }], toolCalls: [], origin: { kind: 'user' } } }),
    j({ time: 1790000005000, type: 'context.append_loop_event', event: { type: 'content.part', turnId: '0', step: 1, part: { type: 'text', text: A } } }),
    j({ time: 1790000060000, type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: LATER }], toolCalls: [], origin: { kind: 'user' } } }),
  ],
  gemini: [
    j({ sessionId: 's', projectHash: 'h', startTime: '2026-10-01T10:00:00Z', lastUpdated: '2026-10-01T10:00:00Z', kind: 'main' }),
    j({ $set: { messages: [], lastUpdated: '2026-10-01T10:00:00Z' } }),
    j({ id: 'u1', timestamp: '2026-10-01T10:00:00Z', type: 'user', content: [{ text: Q }] }),
    j({ id: 'm1', timestamp: '2026-10-01T10:00:05Z', type: 'gemini', content: A, model: 'gemini-3.5-flash' }),
    j({ id: 'u2', timestamp: '2026-10-01T10:01:00Z', type: 'user', content: [{ text: LATER }] }),
  ],
  antigravity: [
    j({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-01T10:00:00Z', content: `<USER_REQUEST>\n${Q}\n</USER_REQUEST>` }),
    j({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-01T10:00:05Z', content: A }),
    j({ step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-01T10:01:00Z', content: `<USER_REQUEST>\n${LATER}\n</USER_REQUEST>` }),
  ],
}

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'chat-search-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

function hostFor(harness: string, state = 'exited') {
  const row = { id: 'sess1', harness, cwd: '/x', conversationId: '00000000-0000-4000-8000-000000000001', state }
  return { sessions: async () => ({ sessions: [row] }) } as never
}

/** The REAL reader for `harness`, resolving to the fixture file. */
function readerOver(harness: string, path: string): () => HarnessTranscript {
  const real = HARNESS_TRANSCRIPTS[harness as keyof typeof HARNESS_TRANSCRIPTS]!
  return () => ({ ...real, resolve: async () => path })
}

describe('every readable harness is searched through its own reader', () => {
  for (const [harness, lines] of Object.entries(FIXTURES)) {
    it(harness, async () => {
      forgetChatSearchMemo()
      const path = join(dir, `${harness}.jsonl`)
      await writeFile(path, `${lines.join('\n')}\n`)
      const out = await searchSessionChat(hostFor(harness), 'pt', 'sess1', 'migracao', {}, readerOver(harness, path))
      expect(out.unavailable).toBeUndefined()
      expect(out.harness).toBe(harness)
      expect(out.total).toBe(2)
      // Newest first: the assistant's answer, then the question.
      expect(out.hits.map(h => h.role)).toEqual(['assistant', 'user'])
      expect(out.hits[0]!.text).toBe(A)
      const q = out.hits[1]!
      expect(q.excerpt.slice(q.highlights[0]!.start, q.highlights[0]!.end)).toBe('MIGRAÇÃO')
      expect(out.scanned).toBe(3)
    })
  }
})

describe('the route keeps the chat view\'s rules', () => {
  it('a query too short is refused without reading anything', async () => {
    let read = false
    const reader = () => ({ resolve: async () => { read = true; return null }, read: async () => ({ turns: [], older: false }), readRecent: async () => [] })
    const out = await searchSessionChat(hostFor('claude'), 'en', 'sess1', 'm', {}, reader)
    expect(out.tooShort).toBe(true)
    expect(read).toBe(false)
  })

  it('a session the fleet does not list answers the chat\'s own refusal, never an empty search', async () => {
    const out = await searchSessionChat(hostFor('claude'), 'en', 'other', 'migracao')
    expect(out.unavailable).toContain('no longer')
    expect(out.hits).toEqual([])
  })

  it('a harness with no reader is refused in words, naming it', async () => {
    const out = await searchSessionChat(hostFor('quokka'), 'en', 'sess1', 'migracao')
    expect(out.unavailable).toContain('quokka')
  })

  it('reads the WHOLE transcript, not the chat\'s 400-turn window', async () => {
    forgetChatSearchMemo()
    const path = join(dir, 'long.jsonl')
    const lines = [j({ type: 'user', message: { content: 'o primeiro pedido: agulha' } })]
    for (let i = 0; i < 450; i++) lines.push(j({ type: 'user', message: { content: `msg ${i}` } }))
    await writeFile(path, `${lines.join('\n')}\n`)
    const out = await searchSessionChat(hostFor('claude'), 'pt', 'sess1', 'AGULHA', {}, readerOver('claude', path))
    expect(out.total).toBe(1)
    expect(out.hits[0]!.index).toBe(0)
    expect(out.scanned).toBe(451)
  })
})
