import { describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commentThread } from '@agentistics/core'
import { commentTargetPhrase, planCommentTarget } from './task-comment'
import { createTaskStore } from './task-store'
import { buildTaskDetail, buildTaskList } from './task-report'
import type { Subtask, Task } from './task-model'

const sub = (id: string, taskId: string, over: Partial<Subtask> = {}): Subtask => ({
  id, taskId, title: `T ${id}`, done: false, status: 'todo',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
})
const task: Task = {
  id: 't-1', title: 'Task', status: 'todo',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
}
const subs = [
  sub('g', 't-1', { isGroup: true }),
  sub('m', 't-1', { parentGroupId: 'g' }),
  sub('l', 't-1'),
  sub('other', 't-2'),
]

describe('planCommentTarget — target validation', () => {
  it('no target is the task', () => {
    expect(planCommentTarget('t-1', undefined, subs)).toEqual({ ok: true, target: { kind: 'task', id: null } })
    expect(planCommentTarget('t-1', '  ', subs).ok).toBe(true)
  })
  it('a group, a member and a loose subtask are all accepted', () => {
    for (const [id, kind] of [['g', 'group'], ['m', 'subtask'], ['l', 'subtask']] as const) {
      const p = planCommentTarget('t-1', id, subs)
      expect(p.ok && p.subtaskId === id && p.target.kind === kind).toBe(true)
    }
  })
  it('an unknown or deleted subtask is refused IN WORDS', () => {
    const p = planCommentTarget('t-1', 's-deleted', subs)
    expect(p.ok).toBe(false)
    if (!p.ok) {
      expect(p.reason).toBe('no_such_subtask')
      expect(p.message).toContain('s-deleted')
      expect(p.message).toContain('not saved')
    }
  })
  it('a subtask of a different task is refused', () => {
    const p = planCommentTarget('t-1', 'other', subs)
    expect(!p.ok && p.reason).toBe('wrong_delivery')
  })
  it('the activity phrase names the target', () => {
    expect(commentTargetPhrase({ kind: 'task', id: null })).toBe('on the task')
    expect(commentTargetPhrase({ kind: 'group', id: 'g', title: 'Auth' })).toBe('on group "Auth"')
    expect(commentTargetPhrase({ kind: 'subtask', id: 'm', title: 'Form' })).toBe('on subtask "Form"')
  })
})

describe('migration — an old comment stays on the task', () => {
  it('a stored comment with no subtaskId reads back with none, and lands in the task thread', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentop-cmt-'))
    const file = join(dir, 'tasks.json')
    await writeFile(file, JSON.stringify({
      tasks: [task], attempts: [], subtasks: subs,
      comments: [
        { id: 'c-old', taskId: 't-1', author: 'me', body: 'written before threads', createdAt: '2026-01-01' },
        { id: 'c-new', taskId: 't-1', subtaskId: 'm', author: 'me', body: 'on the member', createdAt: '2026-01-02' },
      ],
    }), 'utf8')
    const book = await createTaskStore(file).read()
    const old = book.comments.find(c => c.id === 'c-old')!
    expect('subtaskId' in old).toBe(false)
    expect(book.comments.find(c => c.id === 'c-new')!.subtaskId).toBe('m')
    expect(commentThread(book.comments, book.subtasks, null).map(e => e.comment.id)).toEqual(['c-old', 'c-new'])
    expect(commentThread(book.comments, book.subtasks, 'm').map(e => e.comment.id)).toEqual(['c-new'])
  })
  it('deleting a subtask re-homes its comments onto the task instead of losing them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentop-cmt-'))
    const s = createTaskStore(join(dir, 'tasks.json'))
    await s.upsertTask(task)
    await s.upsertSubtask(sub('l', 't-1'))
    await s.addComment({ id: 'c-1', taskId: 't-1', subtaskId: 'l', author: 'me', body: 'x', createdAt: 'a' })
    await s.removeSubtask('l')
    const c = (await s.read()).comments
    expect(c).toHaveLength(1)
    expect(c[0]!.subtaskId).toBeUndefined()
  })
})

describe('reports carry the threads', () => {
  const comments = [
    { id: 'a', taskId: 't-1', author: 'x', body: 'task', createdAt: '1' },
    { id: 'b', taskId: 't-1', subtaskId: 'g', author: 'x', body: 'group', createdAt: '2' },
    { id: 'c', taskId: 't-1', subtaskId: 'm', author: 'x', body: 'member', createdAt: '3' },
  ]
  const base = { attempts: [], rows: [], metas: new Map(), costOf: () => 0, comments, subtasks: subs.slice(0, 3) }
  it('the list counts each row\'s thread — a group includes its members', () => {
    const [row] = buildTaskList({ ...base, tasks: [task] })
    expect(row!.counts.comments).toBe(3)
    expect(row!.counts.commentsBySubtask).toEqual({ g: 2, m: 1 })
  })
  it('the detail groups comments by their own target', () => {
    const d = buildTaskDetail({ ...base, task })
    expect(d.commentThreads.map(t => [t.target.kind, t.target.id, t.comments.map(c => c.id)])).toEqual([
      ['task', null, ['a']], ['group', 'g', ['b']], ['subtask', 'm', ['c']],
    ])
    expect(d.comments).toHaveLength(3)
  })
})

describe('comment attachments — persistence', () => {
  it('survive a write/read round trip as references; an attachment-only comment is kept, an empty one dropped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cmt-att-'))
    const file = join(dir, 'tasks.json')
    const store = createTaskStore(file)
    await store.addComment({
      id: 'c-1', taskId: 't-1', author: 'a', body: '', createdAt: '2026-10-02T00:00:00.000Z',
      attachments: [{ name: 'shot.png', path: '/x/attachments/1-shot.png' }],
    })
    await store.addComment({ id: 'c-2', taskId: 't-1', author: 'a', body: 'plain', createdAt: '2026-10-02T00:00:01.000Z' })
    await store.addComment({ id: 'c-3', taskId: 't-1', author: 'a', body: '', createdAt: '2026-10-02T00:00:02.000Z' })
    const book = await createTaskStore(file).read()
    expect(book.comments.map(c => c.id)).toEqual(['c-1', 'c-2'])
    expect(book.comments[0]!.attachments).toEqual([{ name: 'shot.png', path: '/x/attachments/1-shot.png' }])
    expect('attachments' in book.comments[1]!).toBe(false)
  })
})
