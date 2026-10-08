import { beforeEach, describe, expect, test } from 'bun:test'
import {
  MESSAGE_MIN_GAP_MS, messageHeader, messageStatus, resetMessageRateLimit, sendSessionMessage, type MessageDeps,
} from './session-message'

const ROWS = [
  { id: 'parent-1', title: 'Leader', conversationId: 'conv-p' },
  { id: 'child-1', title: 'Worker', conversationId: 'conv-c' },
]

function fake(over: Partial<MessageDeps> = {}) {
  const prompts: Array<{ id: string; text: string }> = []
  const comments: Array<{ taskId: string; c: Parameters<MessageDeps['comment']>[1] }> = []
  let t = 1_000_000
  const deps: MessageDeps = {
    rows: async () => ROWS,
    prompt: async (id, text) => { prompts.push({ id, text }); return { ok: true, message: 'sent' } },
    senderTask: async () => ({}),
    comment: async (taskId, c) => { comments.push({ taskId, c }); return { ok: true } },
    now: () => t,
    ...over,
  }
  return { deps, prompts, comments, advance: (ms: number) => { t += ms } }
}

beforeEach(resetMessageRateLimit)

describe('agentistics_session_message', () => {
  test('delivers into the target with the header, through the prompt path', async () => {
    const f = fake()
    const out = await sendSessionMessage('child-1', { to: 'parent-1', kind: 'handback', body: 'done, committed' }, f.deps)
    expect(out).toMatchObject({ ok: true, to: 'parent-1', kind: 'handback', mirrored: false })
    expect(f.prompts).toEqual([{ id: 'parent-1', text: `${messageHeader('child-1', 'handback')}\ndone, committed` }])
    expect(f.prompts[0]!.text.startsWith('[from session child-1 · handback]')).toBe(true)
  })
  test('the target may be named by title or conversation id; the parent may message its child', async () => {
    const f = fake()
    expect((await sendSessionMessage('parent-1', { to: 'Worker', kind: 'question', body: 'status?' }, f.deps)).ok).toBe(true)
    expect(f.prompts[0]!.id).toBe('child-1')
  })
  test('a sender filed on a subtask also leaves the body as a task comment of that kind', async () => {
    const f = fake({ senderTask: async () => ({ taskId: 't1', subtaskId: 's1' }) })
    const out = await sendSessionMessage('child-1', { to: 'parent-1', kind: 'block', body: 'stuck on X' }, f.deps)
    expect(out).toMatchObject({ ok: true, mirrored: true })
    expect(f.comments).toEqual([{ taskId: 't1', c: { author: 'session:child-1', body: 'stuck on X', subtaskId: 's1', kind: 'block', session: 'child-1' } }])
  })
  test('a question is mirrored as a plain note, not a handback/block record', async () => {
    const f = fake({ senderTask: async () => ({ taskId: 't1' }) })
    await sendSessionMessage('child-1', { to: 'parent-1', kind: 'question', body: 'which?' }, f.deps)
    expect('kind' in f.comments[0]!.c).toBe(false)
  })
  test('a failing mirror never undoes the delivery', async () => {
    const f = fake({ senderTask: async () => ({ taskId: 't1' }), comment: async () => { throw new Error('boom') } })
    const out = await sendSessionMessage('child-1', { to: 'parent-1', kind: 'handback', body: 'x' }, f.deps)
    expect(out).toMatchObject({ ok: true, mirrored: false })
  })

  test('refusals: unverified sender, missing args, bad kind, unknown, ambiguous, self', async () => {
    const f = fake()
    const code = async (s: string | null, req: Parameters<typeof sendSessionMessage>[1]) => {
      const o = await sendSessionMessage(s, req, f.deps)
      return o.ok ? 'ok' : o.code
    }
    expect(await code(null, { to: 'parent-1', kind: 'handback', body: 'x' })).toBe('unverified_sender')
    expect(await code('child-1', { to: '', kind: 'handback', body: 'x' })).toBe('missing_argument')
    expect(await code('child-1', { to: 'parent-1', kind: 'handback', body: '  ' })).toBe('missing_argument')
    expect(await code('child-1', { to: 'parent-1', kind: 'shout', body: 'x' })).toBe('bad_kind')
    expect(await code('child-1', { to: 'nobody', kind: 'handback', body: 'x' })).toBe('no_such_session')
    expect(await code('child-1', { to: 'child-1', kind: 'handback', body: 'x' })).toBe('self')
    expect(await code('child-1', { to: 'conv-c', kind: 'handback', body: 'x' })).toBe('self')
    const amb = fake({ rows: async () => [{ id: 'ab1', title: 'a' }, { id: 'ab2', title: 'b' }] })
    const o = await sendSessionMessage('zz', { to: 'ab', kind: 'handback', body: 'x' }, amb.deps)
    expect(!o.ok && o.code).toBe('ambiguous_session')
    expect(f.prompts).toHaveLength(0)
  })

  test('rate limit: one per 2 s per pair; another pair and a later time are fine', async () => {
    const f = fake()
    const send = (from: string, to: string) => sendSessionMessage(from, { to, kind: 'handback', body: 'x' }, f.deps)
    expect((await send('child-1', 'parent-1')).ok).toBe(true)
    const again = await send('child-1', 'parent-1')
    expect(!again.ok && again.code).toBe('rate_limited')
    expect(messageStatus(again)).toBe(429)
    expect((await send('parent-1', 'child-1')).ok).toBe(true)
    f.advance(MESSAGE_MIN_GAP_MS)
    expect((await send('child-1', 'parent-1')).ok).toBe(true)
  })

  test('a refused delivery is reported, mirrors nothing and does not burn the rate window', async () => {
    let ok = false
    const f = fake({ senderTask: async () => ({ taskId: 't1' }), prompt: async () => (ok ? { ok: true } : { ok: false, message: 'on a dialog' }) })
    const first = await sendSessionMessage('child-1', { to: 'parent-1', kind: 'handback', body: 'x' }, f.deps)
    expect(!first.ok && first.code).toBe('not_delivered')
    expect(!first.ok && first.message).toBe('on a dialog')
    expect(f.comments).toHaveLength(0)
    ok = true
    expect((await sendSessionMessage('child-1', { to: 'parent-1', kind: 'handback', body: 'x' }, f.deps)).ok).toBe(true)
  })
})
