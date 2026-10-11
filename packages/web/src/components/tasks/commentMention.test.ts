import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyCommentMention, caretQuery, commentCandidates, commentIdFromHref, commentSnippet, filterComments, sessionCandidates, triggerAt,
  sessionCandidateForMention, sessionIdFromMention,
} from './commentMention'
import { commentNavigation } from './commentNavigation'
import { applySessionMention, filterMentionCandidates } from '../../lib/sessionMention'

const sessions = [
  { id: '3f5f21a8b0c1', harness: 'claude', cwd: '/w/a', label: 'Fix the login', createdAt: 't', attemptId: null, subtaskId: null, model: null, tokens: null },
  { id: 'aabbccdd1122', harness: 'codex', cwd: '/w/b', createdAt: 't', attemptId: null, subtaskId: null, model: null, tokens: null },
  { id: 'hist:zzz', harness: 'claude', cwd: '', historical: true, createdAt: 't', attemptId: null, subtaskId: null, model: null, tokens: null },
] as never[]
const comments = [
  { id: 'c-1', author: 'you', body: 'First **point** about the API', createdAt: 't' },
  { id: 'c-2', author: 'claude', body: '# Handback\n\nDone with `x`', createdAt: 't' },
] as never[]

describe('the triggers', () => {
  test('# opens the sessions picker and ^ the comments picker, only at a word boundary', () => {
    expect(triggerAt('see #fix')).toEqual({ kind: 'session', query: 'fix' })
    expect(triggerAt('see ^hand')).toEqual({ kind: 'comment', query: 'hand' })
    expect(triggerAt('x^2')).toBeNull()
    expect(triggerAt('issue#12')).toBeNull()
    expect(triggerAt('# Heading')).toBeNull()
    expect(caretQuery('^')).toBe('')
  })
  test('the later trigger wins when both are in the text', () => {
    expect(triggerAt('#a ^b')?.kind).toBe('comment')
    expect(triggerAt('^a #b')?.kind).toBe('session')
  })
})

describe('# lists the task\'s sessions and writes the session chip', () => {
  const rows = sessionCandidates(sessions)
  test('historical conversations (nothing to point at) are left out; a label or a fallback names the rest', () => {
    expect(rows.map(r => r.id)).toEqual(['3f5f21a8b0c1', 'aabbccdd1122'])
    expect(rows[1]!.title).toContain('codex')
  })
  test('filter and insert reuse the session composer\'s own rules', () => {
    expect(filterMentionCandidates(rows, 'login').map(r => r.id)).toEqual(['3f5f21a8b0c1'])
    const out = applySessionMention('look at #log', 12, rows[0]!, false)!
    expect(out.text).toBe('look at #«Fix the login · 3f5f21a8» ')
  })
})

describe('^ lists the task\'s comments and writes a link to the one picked', () => {
  const rows = commentCandidates(comments)
  test('newest first, with a one-line snippet free of markdown', () => {
    expect(rows.map(r => r.id)).toEqual(['c-2', 'c-1'])
    expect(rows[0]!.snippet).toBe('Handback Done with x')
    expect(commentSnippet('x'.repeat(100)).length).toBe(60)
  })
  test('filter by author or text', () => {
    expect(filterComments(rows, 'api').map(r => r.id)).toEqual(['c-1'])
    expect(filterComments(rows, 'claude').map(r => r.id)).toEqual(['c-2'])
    expect(filterComments(rows, '').length).toBe(2)
  })
  test('the insert is a markdown link to #comment-ID, replacing the ^query', () => {
    const out = applyCommentMention('as said in ^hand', 16, rows[0]!)
    expect(out.text).toBe('as said in [↪ claude: Handback Done with x](#comment-c-2) ')
    expect(commentIdFromHref('#comment-c-2')).toBe('c-2')
    expect(commentIdFromHref('https://x/#comment-c-2')).toBeNull()
  })
})

describe('wired where comments are written', () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8')
  test('the thread composer and the loose/overview composer both get the task\'s sessions and comments', () => {
    expect(src('ThreadsPanel.tsx')).toContain('mentions={{ sessions: sessionCandidates(detail.sessions)')
    expect(src('DeliveryDetail.tsx')).toContain('mentions={{ sessions: sessionCandidates(detail.sessions)')
    expect(src('ThreadsPanel.tsx')).toContain('First message (optional) — # session, ^ comment')
    expect(src('ThreadsPanel.tsx')).toContain('await addComment(id, \'you\', newBody.trim(), null, [], { threadId: r.thread.id })')
  })
  test('a comment link has somewhere to land and is followed in place', () => {
    expect(src('ThreadsPanel.tsx')).toContain('id={commentAnchor(c.id)}')
    expect(src('ThreadsPanel.tsx')).toContain('onClickCapture={followCommentLink}')
    expect(src('DeliveryDetail.tsx')).toContain('id={commentAnchor(c.id)}')
  })
  test('session chips in both comment surfaces receive an open-session handler and cross-view links use the decision', () => {
    expect(src('DeliveryDetail.tsx')).toContain('sessionCandidateForMention(raw, sessions)')
    expect(src('DeliveryDetail.tsx')).toContain('onOpenSession={sid => navigate(sessionPath(sid))}')
    expect(src('ThreadsPanel.tsx')).toContain('commentNavigation(detail.comments, cid, currentView)')
    expect(src('ThreadsPanel.tsx')).toContain("title: 'Comentário não encontrado'")
  })
})

describe('navigation decisions', () => {
  test('recognizes session chips and resolves their candidate', () => {
    expect(sessionIdFromMention('#«Fix the login · 3f5f21a8»')).toBe('3f5f21a8')
    expect(sessionCandidateForMention('#«Fix the login · 3f5f21a8»', sessions)?.id).toBe('3f5f21a8b0c1')
  })
  test('switches between loose comments and topic threads, and reports deletion', () => {
    expect(commentNavigation(comments, 'c-1', 'loose')).toEqual({ kind: 'same', id: 'c-1' })
    expect(commentNavigation([{ id: 'c-1', author: 'you', body: 'First', createdAt: 't', threadId: 't-1' }] as never[], 'c-1', 'loose')).toEqual({ kind: 'switch', id: 'c-1', view: { kind: 'thread', id: 't-1' } })
    expect(commentNavigation(comments, 'gone', 'loose')).toEqual({ kind: 'missing' })
  })
})
