import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'claude-sessions-'))
const P = join(root, 'projects')
const enc = '-tmp-proj'
const dir = join(root, 'projects', enc)
const ID = '11111111-2222-4333-8444-555555555555'
const ID2 = '66666666-2222-4333-8444-555555555555'

const line = (o: object) => JSON.stringify(o) + '\n'
const user = (text: string, ts: string) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
const toolResult = (ts: string) => line({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } })
const assistant = (text: string, ts: string, tool?: string) => line({ type: 'assistant', timestamp: ts, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }, ...(tool ? [{ type: 'tool_use', name: tool, id: 'x', input: {} }] : [])] } })

let mod: typeof import('./claude-sessions')
beforeAll(async () => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${ID}.jsonl`), user('first question', '2026-10-01T10:00:00Z') + toolResult('2026-10-01T10:00:01Z') + assistant('answer one', '2026-10-01T10:00:02Z', 'Read') + 'garbage\n')
  writeFileSync(join(dir, `${ID2}.jsonl`), toolResult('2026-10-01T09:00:00Z'))
  mod = await import('./claude-sessions')
})
beforeEach(() => {
  writeFileSync(join(dir, `${ID}.jsonl`), user('first question', '2026-10-01T10:00:00Z') + toolResult('2026-10-01T10:00:01Z') + assistant('answer one', '2026-10-01T10:00:02Z', 'Read') + 'garbage\n')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('claude-sessions over the incremental fold (PERF.1 step 3)', () => {
  test('list: the same summary the full parse gave; a session with no title is left out', async () => {
    expect(await mod.listClaudeSessions(enc, P)).toEqual([{ id: ID, title: 'first question', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:02Z', messageCount: 1, model: 'claude-opus-5-5' }])
  })

  test('messages: tool results skipped, tools named; an append shows on the next read', async () => {
    expect((await mod.getClaudeSessionMessages(enc, ID, P)).map(m => [m.role, m.content, m.tools])).toEqual([['user', 'first question', undefined], ['assistant', 'answer one', ['Read']]])
    appendFileSync(join(dir, `${ID}.jsonl`), user('second', '2026-10-01T10:01:00Z'))
    expect((await mod.getClaudeSessionMessages(enc, ID, P)).map(m => m.content)).toEqual(['first question', 'answer one', 'second'])
    expect((await mod.listClaudeSessions(enc, P))[0]).toMatchObject({ messageCount: 2, updatedAt: '2026-10-01T10:01:00Z' })
  })

  test('a page is the END first, then older by index', async () => {
    appendFileSync(join(dir, `${ID}.jsonl`), user('second', '2026-10-01T10:01:00Z'))
    const last = await mod.getClaudeSessionPage(enc, ID, 2, undefined, P)
    expect(last).toMatchObject({ start: 1, total: 3 })
    expect(last.messages.map(m => m.content)).toEqual(['answer one', 'second'])
    const older = await mod.getClaudeSessionPage(enc, ID, 2, last.start, P)
    expect(older).toMatchObject({ start: 0, total: 3 })
    expect(older.messages.map(m => m.content)).toEqual(['first question'])
    expect((await mod.getClaudeSessionPage(enc, 'not-a-uuid', 2, undefined, P)).total).toBe(0)
  })

  test('a returned array is a copy: a caller cannot change the cached conversation', async () => {
    appendFileSync(join(dir, `${ID}.jsonl`), user('second', '2026-10-01T10:01:00Z'))
    const a = await mod.getClaudeSessionMessages(enc, ID, P)
    a.length = 0
    expect((await mod.getClaudeSessionMessages(enc, ID, P)).length).toBe(3)
  })
})
