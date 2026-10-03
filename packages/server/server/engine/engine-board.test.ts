/**
 * engine-board.test.ts — `tasks.board` (engine-api 1.7): each operation calls the route's own
 * function and answers with the route's body or its refusal (reason + status), never a throw.
 */
import { describe, expect, test } from 'bun:test'
import { createEngineBoard, type BoardDeps } from './engine-board'

function deps(over: Partial<BoardDeps> = {}): BoardDeps & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = []
  const rec = <T>(name: string, v: T) => async (...a: unknown[]) => { calls.push([name, a]); return v }
  return {
    calls,
    listTasks: rec('listTasks', { tasks: [] }),
    showTask: rec('showTask', { task: { id: 't-1' } }),
    nextTasks: rec('nextTasks', { ready: [] }),
    taskActivity: rec('taskActivity', []),
    createTask: rec('createTask', { id: 't-9' }),
    addSubtask: rec('addSubtask', 's-1'),
    patchSubtask: rec('patchSubtask', { ok: true }),
    setSubtaskDone: rec('setSubtaskDone', { ok: true }),
    addComment: rec('addComment', { ok: true as const, id: 'c-1' }),
    markTask: rec('markTask', { ok: true }),
    claimTask: rec('claimTask', { ok: true }),
    releaseTask: rec('releaseTask', { ok: true }),
    storeAttachment: rec('storeAttachment', { ok: true, path: '/att/a.png', name: 'a.png' }),
    ...over,
  } as BoardDeps & { calls: Array<[string, unknown[]]> }
}

const by = { actor: 'native:s', sessionId: 's' }

describe('createEngineBoard', () => {
  test('every operation reaches its route\'s function with the route\'s arguments', async () => {
    const d = deps()
    const b = createEngineBoard(d)
    await b.list(); await b.get('t-1'); await b.next({ actor: 'native:s', limit: 2 }); await b.activity({ ref: 't-1' })
    await b.create({ title: 'T', ...by })
    await b.subtask('t-1', { title: 'G', isGroup: true }, by)
    await b.subtask('t-1', { id: 's-1', done: true }, by)
    await b.subtask('t-1', { id: 's-1', status: 'doing', blockedBy: ['s-2', 3] }, by)
    await b.comment('t-1', { body: 'hi', author: 'native:s', sessionId: 's', subtaskId: 's-1' })
    await b.status('t-1', { status: 'blocked', reason: 'owner', ...by })
    await b.claim('t-1', { by: 'native:s', sessionId: 's', leaseMs: 5 })
    await b.claim('t-1', { by: 'native:s', sessionId: 's', release: true })
    expect(d.calls).toEqual([
      ['listTasks', []], ['showTask', ['t-1']], ['nextTasks', [{ actor: 'native:s', limit: 2 }]], ['taskActivity', [{ ref: 't-1' }]],
      ['createTask', [{ title: 'T' }]],
      ['addSubtask', ['t-1', 'G', { isGroup: true }]],
      ['setSubtaskDone', ['s-1', true]],
      ['patchSubtask', ['s-1', { status: 'doing', blockedBy: ['s-2'] }]],
      ['addComment', ['t-1', { author: 'native:s', body: 'hi', subtaskId: 's-1' }]],
      ['markTask', ['t-1', 'blocked', 'native:s', { reason: 'owner' }]],
      ['claimTask', [{ ref: 't-1', by: 'native:s', sessionId: 's', leaseMs: 5 }]],
      ['releaseTask', [{ ref: 't-1', by: 'native:s' }]],
    ])
  })

  test('refusals carry the route\'s reason and status', async () => {
    const b = createEngineBoard(deps({
      showTask: async () => null,
      setSubtaskDone: async () => ({ ok: false, message: 'done_needs_session' }),
      markTask: async () => ({ ok: false, message: 'unknown_status' }),
      claimTask: async () => ({ ok: false, reason: 'held', heldBy: 'x' }),
      addComment: async () => ({ ok: false as const, reason: 'no_such_subtask', message: 'm' }),
      createTask: async () => null,
    }))
    expect(await b.get('nope')).toEqual({ ok: false, status: 404, reason: 'no_such_task' })
    expect(await b.subtask('t', { id: 's', done: true }, by)).toMatchObject({ ok: false, status: 422, reason: 'done_needs_session' })
    expect(await b.status('t', { status: 'zzz', ...by })).toMatchObject({ ok: false, status: 400, reason: 'unknown_status' })
    expect(await b.claim('t', { by: 'x', sessionId: 's' })).toMatchObject({ ok: false, status: 409, reason: 'held' })
    expect(await b.comment('t', { body: 'x', author: 'a', sessionId: 's', subtaskId: 'gone' })).toMatchObject({ ok: false, status: 422, reason: 'no_such_subtask' })
    expect(await b.create({ title: '', ...by })).toMatchObject({ ok: false, status: 400 })
  })

  test('a throwing board function is an answer, not a crash', async () => {
    const b = createEngineBoard(deps({ listTasks: async () => { throw new Error('disk') } }))
    expect(await b.list()).toEqual({ ok: false, status: 500, reason: 'internal' })
  })

  test('attach: kind, count and size checked by the host; bytes stored, never a path; ONE comment', async () => {
    const d = deps()
    const b = createEngineBoard(d)
    const png = { name: 'a.png', bytes: new Uint8Array([1]) }
    const r = await b.attach('t-1', { files: [png], author: 'native:s', sessionId: 's', subtaskId: 's-1', note: 'shot' })
    expect(r).toMatchObject({ ok: true, body: { attached: 1 } })
    expect(d.calls.map(c => c[0])).toEqual(['storeAttachment', 'addComment'])
    expect(d.calls[1]![1]).toEqual(['t-1', { author: 'native:s', body: 'shot', attachments: [{ name: 'a.png', path: '/att/a.png' }], subtaskId: 's-1' }])
    expect(await b.attach('t-1', { files: [{ name: 'a.txt', bytes: new Uint8Array([1]) }], author: 'a', sessionId: 's' })).toMatchObject({ ok: false, reason: 'unsupported_kind' })
    expect(await b.attach('t-1', { files: Array.from({ length: 11 }, () => png), author: 'a', sessionId: 's' })).toMatchObject({ ok: false, reason: 'too_many_files' })
    expect(await b.attach('t-1', { files: [{ name: 'e.png', bytes: new Uint8Array() }], author: 'a', sessionId: 's' })).toMatchObject({ ok: false, reason: 'empty_file' })
    const failing = createEngineBoard(deps({ storeAttachment: async () => ({ ok: false, message: 'disk full' }) }))
    expect(await failing.attach('t-1', { files: [png], author: 'a', sessionId: 's' })).toMatchObject({ ok: false, reason: 'disk full' })
  })
})
