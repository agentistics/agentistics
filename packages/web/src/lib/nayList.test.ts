import { describe, expect, test } from 'bun:test'
import { naySections, naySectionOf, NAY_ENDED_SHOWN } from './nayList'

const NAY = '/home/u/.agentistics/nay-chat'

describe('naySections', () => {
  test('splits working, waiting and ended, and leaves out store-only and external rows', () => {
    const s = naySections([
      { id: 'a', conversationId: 'c1', cwd: NAY, state: 'working' },
      { id: 'b', conversationId: 'c2', cwd: NAY, state: 'waiting-approval' },
      { id: 'c', conversationId: 'c3', cwd: NAY, state: 'lost' },
      { id: 'closed:x', cwd: NAY, state: 'closed' },
      { id: 'p', cwd: NAY, state: 'unknown' },
      { id: 'w', conversationId: 'c4', cwd: '/work', state: 'working' },
    ])
    expect(s.working.map(r => r.id)).toEqual(['a'])
    expect(s.waiting.map(r => r.id)).toEqual(['b'])
    expect(s.ended.map(r => r.id)).toEqual(['c'])
  })
  test('one row per conversation, the live one winning over its retired predecessor', () => {
    const s = naySections([
      { id: 'old', conversationId: 'c', cwd: NAY, state: 'exited', startedAt: 1 },
      { id: 'new', conversationId: 'c', cwd: NAY, state: 'waiting', startedAt: 2 },
    ])
    expect(s.waiting.map(r => r.id)).toEqual(['new'])
    expect(s.ended).toEqual([])
  })
  test('ended conversations are capped, newest first', () => {
    const rows = Array.from({ length: NAY_ENDED_SHOWN + 5 }, (_, i) => ({ id: `e${i}`, conversationId: `c${i}`, cwd: NAY, state: 'exited', startedAt: i }))
    const s = naySections(rows)
    expect(s.ended).toHaveLength(NAY_ENDED_SHOWN)
    expect(s.ended[0]!.id).toBe(`e${NAY_ENDED_SHOWN + 4}`)
  })
  test('state words', () => {
    expect(naySectionOf('starting')).toBeNull()
    expect(naySectionOf('waiting')).toBe('waiting')
  })
})
