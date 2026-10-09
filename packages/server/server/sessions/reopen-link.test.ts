import { beforeEach, describe, expect, it } from 'bun:test'
import type { HarnessId } from '@agentistics/core'
import type { Conversation } from './conversations'
import { REOPEN_LINK_MISS_TTL_MS, exactLinksOnDisk, resetReopenLinkMemo } from './reopen-link'

const conv = (sessionId: string): Conversation => ({
  sessionId, harness: 'claude', cwd: '/repo', title: sessionId,
  lastActivityMs: 1, startedMs: 0, resumable: true, firstPrompt: '',
})

/** A resolver over an in-memory "disk", counting every question it is asked. */
function disk(present: Iterable<string>) {
  const files = new Set(present)
  const asked: Array<{ harness: HarnessId; id: string; cwd: string }> = []
  return {
    files,
    asked,
    resolve: async (harness: HarnessId, ref: { conversationId: string; cwd: string }) => {
      asked.push({ harness, id: ref.conversationId, cwd: ref.cwd })
      return files.has(ref.conversationId) ? `/t/${ref.conversationId}` : null
    },
  }
}

beforeEach(() => resetReopenLinkMemo())

describe('exactLinksOnDisk', () => {
  it('asks each resumable harness\'s own resolver, with the row\'s directory', async () => {
    const d = disk(['a', 'b', 'c', 'd', 'e'])
    const entries = (['claude', 'codex', 'copilot', 'kimi', 'antigravity'] as HarnessId[])
      .map((harness, i) => ({ harness, cwd: `/w/${harness}`, conversationId: 'abcde'[i]! }))
    const out = await exactLinksOnDisk(entries, [], 0, d.resolve)
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(d.asked.map(q => `${q.harness}:${q.id}:${q.cwd}`).sort()).toEqual([
      'antigravity:e:/w/antigravity', 'claude:a:/w/claude', 'codex:b:/w/codex',
      'copilot:c:/w/copilot', 'kimi:d:/w/kimi',
    ])
  })

  it('asks nothing for an id the store already holds, a row with no directory, or a gemini synthetic id', async () => {
    const d = disk(['in-pool', 'no-cwd', 'proj/g'])
    const out = await exactLinksOnDisk([
      { harness: 'claude', cwd: '/w', conversationId: 'in-pool' },
      { harness: 'claude', conversationId: 'no-cwd' },
      { harness: 'gemini', cwd: '/w', conversationId: 'proj/g' },
      { harness: 'claude', cwd: '/w' },
    ], [conv('in-pool')], 0, d.resolve)
    expect(out.size).toBe(0)
    expect(d.asked).toEqual([])
  })

  it('remembers a FOUND transcript, and re-asks a miss only after the TTL', async () => {
    const d = disk(['found'])
    const entries = [
      { harness: 'antigravity' as const, cwd: '/w', conversationId: 'found' },
      { harness: 'antigravity' as const, cwd: '/w', conversationId: 'later' },
    ]
    expect([...await exactLinksOnDisk(entries, [], 1000, d.resolve)]).toEqual(['found'])
    expect(d.asked.length).toBe(2)

    // The transcript for `later` appears — a session minutes old writes it on its first turn.
    d.files.add('later')
    expect([...await exactLinksOnDisk(entries, [], 1000 + REOPEN_LINK_MISS_TTL_MS - 1, d.resolve)]).toEqual(['found'])
    expect(d.asked.length).toBe(2) // `found` from memory, `later` still inside its miss window

    const out = await exactLinksOnDisk(entries, [], 1000 + REOPEN_LINK_MISS_TTL_MS, d.resolve)
    expect([...out].sort()).toEqual(['found', 'later'])
    expect(d.asked.length).toBe(3)
  })

  it('a resolver that throws is a miss, never a throw', async () => {
    const out = await exactLinksOnDisk(
      [{ harness: 'kimi', cwd: '/w', conversationId: 'k' }], [], 0,
      async () => { throw new Error('EACCES') },
    )
    expect(out.size).toBe(0)
  })
})
