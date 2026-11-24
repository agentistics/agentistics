import { describe, expect, test } from 'bun:test'
import { archivedLinks } from './archived-links'

const c = (sessionId: string, subtaskId: string | undefined, createdAt = '2026-11-02T00:00:00.000Z') => ({ sessionId, subtaskId, createdAt })
const conv = (m: Record<string, string>) => new Map(Object.entries(m).map(([k, v]) => [k, { conversationId: v, harness: 'claude' }]))
const base = { leaderIds: new Set<string>(), subtasks: new Set(['S1', 'S2']) }

describe('archived piece -> session links', () => {
  test('a session whose own comments name ONE subtask is filed there, with the newest comment time', () => {
    const out = archivedLinks({ ...base, comments: [c('w1', 'S1', '2026-11-02T00:00:00.000Z'), c('w1', 'S1', '2026-11-03T00:00:00.000Z')], conversations: conv({ w1: 'conv-1' }) })
    expect(out).toEqual([{ sessionId: 'w1', conversationId: 'conv-1', harness: 'claude', subtaskId: 'S1', atMs: Date.parse('2026-11-03T00:00:00.000Z') }])
  })
  test('a coordinator (comments on several subtasks) is never filed on one of them', () => {
    expect(archivedLinks({ ...base, comments: [c('l1', 'S1'), c('l1', 'S2')], conversations: conv({ l1: 'conv-l' }) })).toEqual([])
  })
  test('a registered leader is never filed, even when it spoke on one subtask only', () => {
    expect(archivedLinks({ ...base, leaderIds: new Set(['l1']), comments: [c('l1', 'S1')], conversations: conv({ l1: 'conv-l' }) })).toEqual([])
  })
  test('no conversation known, a loose comment, or a subtask the board no longer has: nothing is invented', () => {
    expect(archivedLinks({ ...base, comments: [c('w1', 'S1'), c('w2', undefined), c('w3', 'GONE')], conversations: conv({ w2: 'c2', w3: 'c3' }) })).toEqual([])
  })
  test('one conversation reached by managed ids that disagree is ambiguous: left out', () => {
    expect(archivedLinks({ ...base, comments: [c('a', 'S1'), c('b', 'S2')], conversations: conv({ a: 'same', b: 'same' }) })).toEqual([])
    expect(archivedLinks({ ...base, comments: [c('a', 'S1'), c('b', 'S1')], conversations: conv({ a: 'same', b: 'same' }) })).toHaveLength(2)
  })
})
