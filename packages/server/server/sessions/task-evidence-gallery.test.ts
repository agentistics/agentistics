import { describe, expect, it } from 'bun:test'
import { sanitizeCommentSessionId } from '@agentistics/core'
import { buildEvidence } from './task-evidence-gallery'

const att = (p: string) => ({ name: p.split('/').pop()!, path: p })
const comments = [
  { taskId: 't1', subtaskId: 's1', sessionId: 'abc123', author: 'claude:abc1', createdAt: '2026-10-02T10:00:00Z', attachments: [att('/d/a.png'), att('/d/b.png')] },
  { taskId: 't1', author: 'me', createdAt: '2026-10-02T11:00:00Z', attachments: [att('/d/typed.png')] }, // no sessionId: a person's comment
  { taskId: 't2', sessionId: 'zzz', author: 'w', createdAt: '2026-10-02T09:00:00Z', attachments: [att('/d/c.png')] },
]
const messages = [{ conversationId: 'conv1', atMs: Date.parse('2026-10-02T12:00:00Z'), paths: ['/d/mine.png', '/d/a.png'], images: 2 }]
const tasks = new Map([['conv1', 't1']])

describe('buildEvidence', () => {
  it('flattens session comment attachments, newest first, ignoring comments with no session', () => {
    const r = buildEvidence({ comments, messages: [], taskOfConversation: tasks, origin: 'sessions' })
    expect(r.map(e => e.path)).toEqual(['/d/a.png', '/d/b.png', '/d/c.png'])
    expect(r[0]).toMatchObject({ taskId: 't1', subtaskId: 's1', sessionId: 'abc123', author: 'claude:abc1' })
  })
  it('mine = chat uploads, minus paths a session already claimed, task via the conversation', () => {
    const r = buildEvidence({ comments, messages, taskOfConversation: tasks, origin: 'mine' })
    expect(r.map(e => e.path)).toEqual(['/d/mine.png'])
    expect(r[0]).toMatchObject({ origin: 'mine', taskId: 't1' })
  })
  it('scopes to a task', () => {
    const r = buildEvidence({ comments, messages, taskOfConversation: tasks, taskId: 't2' })
    expect(r.map(e => e.path)).toEqual(['/d/c.png'])
  })
  it('a chat image whose conversation is filed on no task has no task and is excluded from a task scope', () => {
    const r = buildEvidence({ comments: [], messages, taskOfConversation: new Map(), taskId: 't1' })
    expect(r).toEqual([])
  })
})

describe('sanitizeCommentSessionId', () => {
  it('accepts id-shaped strings and drops anything else', () => {
    expect(sanitizeCommentSessionId('agentop-a2b569c123')).toBe('agentop-a2b569c123')
    expect(sanitizeCommentSessionId(' 3f5f21a8-b0c1 ')).toBe('3f5f21a8-b0c1')
    for (const bad of ['', '../etc', 'a b', 'x'.repeat(81), 5, null, '<script>']) expect(sanitizeCommentSessionId(bad)).toBeUndefined()
  })
})
