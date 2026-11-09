import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishChatRead } from './chat-web'
import { PENDING_TTL_MS, recordPrompt, resetPrompts, usePromptStoreForTests } from './pending-prompts'

// MENSAGENS.KILL — the payload a person sees after killing a session. finishChatRead is the one
// post-processing every harness's reader goes through (legacy readers and the engine's chat channel), so
// asserting here covers Claude and every other harness alike.
const CONV = 'conv-kill'
const HOUR = 60 * 60 * 1000

beforeEach(() => {
  usePromptStoreForTests(join(mkdtempSync(join(tmpdir(), 'chat-stranded-')), 'pending-prompts.json'))
  resetPrompts()
})

const read = (turns: { role: 'user' | 'assistant'; text: string }[] = []) => ({ turns: turns as never[] })

describe('a killed session offers back what it never read', () => {
  test('a LIVE session keeps showing the message as pending, and no stranded list', async () => {
    recordPrompt(CONV, 'queued behind a busy turn', Date.now())
    const out = await finishChatRead('row-1', CONV, read(), true, 'en')
    expect(out.pending?.map(p => p.text)).toEqual(['queued behind a busy turn'])
    expect(out.stranded).toBeUndefined()
  })

  test('after the kill the same message is STRANDED, not pending', async () => {
    recordPrompt(CONV, 'queued behind a busy turn', Date.now())
    const out = await finishChatRead('row-1', CONV, read(), false, 'en')
    expect(out.pending).toBeUndefined()
    expect(out.stranded?.map(p => p.text)).toEqual(['queued behind a busy turn'])
  })

  test('a message older than the live ceiling is still offered after the kill (hung session)', async () => {
    recordPrompt(CONV, 'sent hours ago to a hung session', Date.now() - 3 * HOUR)
    const live = await finishChatRead('row-1', CONV, read(), true, 'en')
    expect(live.pending).toBeUndefined()
    const dead = await finishChatRead('row-1', CONV, read(), false, 'en')
    expect(dead.stranded?.map(p => p.text)).toEqual(['sent hours ago to a hung session'])
    expect(Date.now() - dead.stranded![0]!.at).toBeGreaterThan(PENDING_TTL_MS)
  })

  test('reopened and already read by the harness: nothing is offered twice', async () => {
    recordPrompt(CONV, 'hello world', Date.now() - HOUR)
    const out = await finishChatRead('row-2', CONV, read([{ role: 'user', text: 'hello world' }]), false, 'en')
    expect(out.stranded).toBeUndefined()
    expect(out.pending).toBeUndefined()
  })

  test('a resend does not duplicate: the stranded copy is replaced by the new queued one', async () => {
    recordPrompt(CONV, 'again', Date.now() - 2 * HOUR)
    recordPrompt(CONV, 'again', Date.now())
    const live = await finishChatRead('row-3', CONV, read(), true, 'en')
    expect(live.pending?.map(p => p.text)).toEqual(['again'])
    const dead = await finishChatRead('row-3', CONV, read(), false, 'en')
    expect(dead.stranded?.map(p => p.text)).toEqual(['again'])
  })
})
