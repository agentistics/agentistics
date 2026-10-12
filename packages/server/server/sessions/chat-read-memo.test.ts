import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearChatMemo, readChatMemo } from './chat-read-memo'

const dir = mkdtempSync(join(tmpdir(), 'chat-memo-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => clearChatMemo())

function counting(path: string) {
  let n = 0
  const read = async () => { n++; return { turns: [{ role: 'user', text: `read ${n}` }] as never[], older: false } }
  return { read, reads: () => n, path }
}

describe('readChatMemo (PERF.IDLE)', () => {
  it('an unchanged transcript is read once; an append is read again', async () => {
    const path = join(dir, 'a.jsonl'); writeFileSync(path, '{}\n')
    const c = counting(path)
    await readChatMemo(path, 400, 'claude', c.read)
    const again = await readChatMemo(path, 400, 'claude', c.read)
    expect(c.reads()).toBe(1)
    expect((again.turns[0] as { text: string }).text).toBe('read 1')
    appendFileSync(path, '{}\n')
    await readChatMemo(path, 400, 'claude', c.read)
    expect(c.reads()).toBe(2)
  })
  it('a different window is a different read, and gemini is never kept', async () => {
    const path = join(dir, 'b.jsonl'); writeFileSync(path, '{}\n')
    const c = counting(path)
    await readChatMemo(path, 400, 'codex', c.read)
    await readChatMemo(path, 50, 'codex', c.read)
    expect(c.reads()).toBe(2)
    const g = counting(path)
    await readChatMemo(path, 400, 'gemini', g.read)
    await readChatMemo(path, 400, 'gemini', g.read)
    expect(g.reads()).toBe(2)
  })
  it('hands back a fresh array, so a caller replacing or pushing never reaches the kept copy', async () => {
    const path = join(dir, 'c.jsonl'); writeFileSync(path, '{}\n')
    const c = counting(path)
    const first = await readChatMemo(path, 400, 'claude', c.read)
    first.turns.push({ role: 'assistant', text: 'x' } as never)
    expect((await readChatMemo(path, 400, 'claude', c.read)).turns).toHaveLength(1)
  })
})
