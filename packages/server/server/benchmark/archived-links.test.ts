import { describe, expect, test } from 'bun:test'
import { archivedLinks } from './archived-links'

const c = (sessionId: string, subtaskId: string | undefined, createdAt = '2026-11-02T00:00:00.000Z', kind?: string) => ({ sessionId, subtaskId, createdAt, kind })
const hb = (sessionId: string, subtaskId: string, createdAt?: string) => c(sessionId, subtaskId, createdAt, 'handback')
const conv = (m: Record<string, string>) => new Map(Object.entries(m).map(([k, v]) => [k, { conversationId: v, harness: 'claude' }]))
const base = { leaderIds: new Set<string>(), subtasks: new Set(['S1', 'S2']) }

describe('archived piece -> session links', () => {
  test('a session whose own comments name ONE subtask is filed there, with the newest comment time', () => {
    const out = archivedLinks({ ...base, comments: [hb('w1', 'S1', '2026-11-02T00:00:00.000Z'), c('w1', 'S1', '2026-11-03T00:00:00.000Z')], conversations: conv({ w1: 'conv-1' }) })
    expect(out).toEqual([{ sessionId: 'w1', conversationId: 'conv-1', harness: 'claude', subtaskId: 'S1', atMs: Date.parse('2026-11-03T00:00:00.000Z') }])
  })
  test('a coordinator (comments on several subtasks) is never filed on one of them', () => {
    expect(archivedLinks({ ...base, comments: [hb('l1', 'S1'), hb('l1', 'S2')], conversations: conv({ l1: 'conv-l' }) })).toEqual([])
  })
  test('a registered leader is never filed, even when it spoke on one subtask only', () => {
    expect(archivedLinks({ ...base, leaderIds: new Set(['l1']), comments: [hb('l1', 'S1')], conversations: conv({ l1: 'conv-l' }) })).toEqual([])
  })
  test('no conversation known, a loose comment, or a subtask the board no longer has: nothing is invented', () => {
    expect(archivedLinks({ ...base, comments: [hb('w1', 'S1'), c('w2', undefined), hb('w3', 'GONE')], conversations: conv({ w2: 'c2', w3: 'c3' }) })).toEqual([])
  })
  test('one conversation reached by managed ids that disagree is ambiguous: left out', () => {
    expect(archivedLinks({ ...base, comments: [hb('a', 'S1'), hb('b', 'S2')], conversations: conv({ a: 'same', b: 'same' }) })).toEqual([])
    expect(archivedLinks({ ...base, comments: [hb('a', 'S1'), hb('b', 'S1')], conversations: conv({ a: 'same', b: 'same' }) })).toHaveLength(2)
  })
  test('NAVEGADOR case: a leader that only commented on the piece (and on the task) is no author; the worker with a handback is', () => {
    const out = archivedLinks({
      ...base,
      comments: [c('lead', undefined), c('lead', 'S1'), c('lead', 'S1', undefined, 'decision'), c('wk', 'S1'), hb('wk', 'S1')],
      conversations: conv({ lead: 'conv-lead', wk: 'conv-wk' }),
    })
    expect(out.map(l => l.sessionId)).toEqual(['wk'])
  })
  test('commenting on ONE subtask is not authorship: without a handback or a delivery proof nothing is linked', () => {
    const k = { ...base, comments: [c('x', 'S1', undefined, 'note')], conversations: conv({ x: 'conv-x' }) }
    expect(archivedLinks(k)).toEqual([])
    expect(archivedLinks({ ...k, proofs: [{ sessionId: 'x', subtaskId: 'S1' }] }).map(l => l.sessionId)).toEqual(['x'])
    expect(archivedLinks({ ...k, proofs: [{ sessionId: 'x', subtaskId: 'S2' }] })).toEqual([])
  })
  test('a decision comment or a task-level comment disqualifies even a session with a handback', () => {
    expect(archivedLinks({ ...base, comments: [hb('l', 'S1'), c('l', 'S1', undefined, 'decision')], conversations: conv({ l: 'cl' }) })).toEqual([])
    expect(archivedLinks({ ...base, comments: [hb('l', 'S1'), c('l', undefined)], conversations: conv({ l: 'cl' }) })).toEqual([])
  })
})
