/**
 * Agentask threads, end to end against the real store (the `bun test` data dir is a fresh temp dir —
 * see `config.ts`). The fleet is never read here: every reply goes to a thread with no participant
 * or is refused before the fleet would be asked.
 */
import { describe, expect, test } from 'bun:test'
import { addComment, createTask, showTask as getTaskDetail } from './task-web'
import { openThread, sendFromThread, threadAction } from './task-threads'
import { loadTaskBoard } from './task-source'

async function freshTask(title: string) {
  const t = await createTask({ title })
  if (!t) throw new Error('no task')
  return t
}

describe('opening a thread', () => {
  test('the person opens any kind; a session only a handback or a block', async () => {
    const t = await freshTask('th-open')
    expect((await openThread(t.id, { title: 'Release', openedBy: 'me' })).ok).toBe(true)
    const refused = await openThread(t.id, { title: 'Chat', openedBy: 's', session: 'sess-1', kind: 'topic' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe('session_kind')
    const ok = await openThread(t.id, { title: 'Done H1', openedBy: 's', session: 'sess-1', kind: 'handback' })
    expect(ok.ok && ok.thread.participants.map(p => p.sessionId)).toEqual(['sess-1'])
  })
  test('a blank title is refused in words', async () => {
    const t = await freshTask('th-blank')
    const r = await openThread(t.id, { title: '   ', openedBy: 'me' })
    expect(r.ok).toBe(false)
  })
})

describe('posting into a thread', () => {
  test('a VERIFIED session joins as a participant; an unverified poster never does', async () => {
    const t = await freshTask('th-post')
    const o = await openThread(t.id, { title: 'Topic', openedBy: 'me' })
    if (!o.ok) throw new Error('open')
    await addComment(t.id, { author: 'claude:x', body: 'unverified', threadId: o.thread.id })
    await addComment(t.id, { author: 'claude:y', body: 'verified', threadId: o.thread.id, session: 'sess-y' })
    const w = await loadTaskBoard()
    const th = w.book.threads.find(x => x.id === o.thread.id)!
    expect(th.participants.map(p => p.sessionId)).toEqual(['sess-y'])
    const cs = w.book.comments.filter(c => c.threadId === o.thread.id)
    expect(cs.find(c => c.body === 'verified')).toMatchObject({ role: 'session', sessionId: 'sess-y' })
    expect(cs.find(c => c.body === 'unverified')?.role).toBeUndefined()
  })
  test('a thread of another task is refused, and a resolved thread reopens on a new comment', async () => {
    const a = await freshTask('th-a'); const b = await freshTask('th-b')
    const o = await openThread(a.id, { title: 'A', openedBy: 'me' })
    if (!o.ok) throw new Error('open')
    const wrong = await addComment(b.id, { author: 'me', body: 'x', threadId: o.thread.id })
    expect(wrong.ok).toBe(false)
    expect(await threadAction(a.id, o.thread.id, 'resolve')).toBe(true)
    await addComment(a.id, { author: 'me', body: 'again', threadId: o.thread.id, owner: true })
    const w = await loadTaskBoard()
    expect(w.book.threads.find(x => x.id === o.thread.id)?.resolvedAt).toBeUndefined()
  })
  test('newThread opens and posts in one call; a session may not open a topic', async () => {
    const t = await freshTask('th-new')
    const r = await addComment(t.id, { author: 's', body: 'H done', newThread: { title: 'H', kind: 'handback' }, session: 'sess-n' })
    expect(r.ok && r.threadId).toBeTruthy()
    const bad = await addComment(t.id, { author: 's', body: 'x', newThread: { title: 'T', kind: 'topic' }, session: 'sess-n' })
    expect(bad.ok).toBe(false)
  })
  test('the task detail carries the threads, and legacy comments stay loose', async () => {
    const t = await freshTask('th-detail')
    await addComment(t.id, { author: 'me', body: 'loose' })
    const o = await openThread(t.id, { title: 'T', openedBy: 'me' })
    if (!o.ok) throw new Error('open')
    const d = await getTaskDetail(t.id)
    expect(d?.task.threads.map(x => x.id)).toEqual([o.thread.id])
    expect(d?.task.comments.find(c => c.body === 'loose')?.threadId).toBeUndefined()
  })
})

describe('a thread is a record; sending is explicit', () => {
  test('an ordinary comment in a thread carries no deliveries — it reached nobody', async () => {
    const t = await freshTask('th-record')
    const o = await openThread(t.id, { title: 'T', openedBy: 'me' })
    if (!o.ok) throw new Error('open')
    await addComment(t.id, { author: 's', body: 'H done', threadId: o.thread.id, session: 'sess-r', kind: 'handback' })
    await addComment(t.id, { author: 'me', body: 'noted, decided', threadId: o.thread.id, owner: true, kind: 'decision' })
    const w = await loadTaskBoard()
    const cs = w.book.comments.filter(c => c.threadId === o.thread.id)
    expect(cs.map(c => c.kind)).toEqual(['handback', 'decision'])
    expect(cs.every(c => c.deliveries === undefined)).toBe(true)
  })
  test('a request carrying a session identity can never send', async () => {
    const t = await freshTask('th-fanout')
    const o = await openThread(t.id, { title: 'T', openedBy: 'me' })
    if (!o.ok) throw new Error('open')
    const r = await sendFromThread(t.id, o.thread.id, { body: 'hi', author: 's', fromSession: true }, 'en')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('session_fanout')
  })
  test('a send to a thread with nobody in it is recorded with no deliveries; an empty send is refused', async () => {
    const t = await freshTask('th-empty')
    const o = await openThread(t.id, { title: 'T', openedBy: 'me' })
    if (!o.ok) throw new Error('open')
    const r = await sendFromThread(t.id, o.thread.id, { body: 'note to self', author: 'me' }, 'en')
    expect(r.ok && r.deliveries).toEqual([])
    expect((await sendFromThread(t.id, o.thread.id, { body: '  ', author: 'me' }, 'en')).ok).toBe(false)
  })
})

describe('mute', () => {
  test('mute and unmute a participant', async () => {
    const t = await freshTask('th-mute')
    const o = await openThread(t.id, { title: 'T', openedBy: 'me' })
    if (!o.ok) throw new Error('open')
    expect(await threadAction(t.id, o.thread.id, 'mute', { sessionId: 's1' })).toBe(true)
    let w = await loadTaskBoard()
    expect(w.book.threads.find(x => x.id === o.thread.id)?.mutedSessions).toEqual(['s1'])
    await threadAction(t.id, o.thread.id, 'unmute', { sessionId: 's1' })
    w = await loadTaskBoard()
    expect(w.book.threads.find(x => x.id === o.thread.id)?.mutedSessions).toBeUndefined()
    expect(await threadAction(t.id, o.thread.id, 'mute')).toBe(false)
  })
})
