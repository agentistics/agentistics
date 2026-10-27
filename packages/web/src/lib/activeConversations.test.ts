import { describe, expect, it } from 'bun:test'
import { keepRunning, NO_RUNNING_IDS, runningConversationIds, stableRunningIds } from './activeConversations'

const row = (o: Partial<{ state: string; conversationId: string }>) =>
  ({ state: 'working', ...o }) as never

describe('runningConversationIds', () => {
  it('collects only the conversations that are running now', () => {
    const ids = runningConversationIds([
      row({ state: 'working', conversationId: 'a' }),
      row({ state: 'waiting', conversationId: 'b' }),
      row({ state: 'exited', conversationId: 'c' }),
    ])
    expect([...ids].sort()).toEqual(['a', 'b'])
  })

  it('ignores a running row with no conversation link — it names nothing to intersect', () => {
    expect(runningConversationIds([row({ state: 'working' })]).size).toBe(0)
  })
})

describe('keepRunning', () => {
  it('keeps only the stored sessions whose conversation is live', () => {
    const s = [{ session_id: 'a' }, { session_id: 'z' }] as never[]
    expect(keepRunning(s, new Set(['a'])).map(x => (x as unknown as { session_id: string }).session_id))
      .toEqual(['a'])
  })

  it('keeps nothing when nothing is running, rather than everything', () => {
    const s = [{ session_id: 'a' }] as never[]
    expect(keepRunning(s, new Set())).toEqual([])
  })
})

describe('stableRunningIds', () => {
  it('keeps the previous identity while the same conversations run', () => {
    const prev = new Set(['a', 'b'])
    expect(stableRunningIds(prev, new Set(['b', 'a']), true)).toBe(prev)
  })
  it('switches identity when the running conversations change', () => {
    const next = new Set(['a', 'c'])
    expect(stableRunningIds(new Set(['a', 'b']), next, true)).toBe(next)
    expect(stableRunningIds(undefined, next, true)).toBe(next)
  })
  it('is one constant when nobody reads the set, whatever the fleet does', () => {
    expect(stableRunningIds(new Set(['a']), new Set(['b']), false)).toBe(NO_RUNNING_IDS)
    expect(stableRunningIds(NO_RUNNING_IDS, new Set(['c']), false)).toBe(NO_RUNNING_IDS)
  })
})
