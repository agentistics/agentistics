import { describe, expect, test } from 'bun:test'
import { commentCounts, commentTarget, commentThread, commentsByTarget } from './commentThreads'

const subs = [
  { id: 'g', title: 'Group', isGroup: true },
  { id: 'm1', title: 'Member one', parentGroupId: 'g' },
  { id: 'm2', title: 'Member two', parentGroupId: 'g' },
  { id: 'l', title: 'Loose' },
]
const c = (id: string, at: string, subtaskId?: string) => ({ id, createdAt: at, ...(subtaskId ? { subtaskId } : {}) })
const comments = [
  c('legacy', '2026-01-01'),            // written before threads existed: no target
  c('onGroup', '2026-01-02', 'g'),
  c('onM1', '2026-01-03', 'm1'),
  c('onM2', '2026-01-04', 'm2'),
  c('onLoose', '2026-01-05', 'l'),
  c('dangling', '2026-01-06', 'gone'),  // its subtask was deleted
]

describe('commentTarget', () => {
  test('a comment with no target (the migration case) is the task\'s', () => {
    expect(commentTarget(c('x', 'a'), subs)).toEqual({ kind: 'task', id: null })
  })
  test('a group and a subtask are told apart', () => {
    expect(commentTarget(c('x', 'a', 'g'), subs).kind).toBe('group')
    expect(commentTarget(c('x', 'a', 'm1'), subs)).toEqual({ kind: 'subtask', id: 'm1', title: 'Member one' })
  })
  test('a dangling target falls back to the task, never vanishes', () => {
    expect(commentTarget(c('x', 'a', 'gone'), subs)).toEqual({ kind: 'task', id: null })
  })
})

describe('commentThread — downward aggregation', () => {
  const ids = (t: string | null) => commentThread(comments, subs, t).map(e => e.comment.id)
  test('the task thread shows everything, oldest first', () => {
    expect(ids(null)).toEqual(['legacy', 'onGroup', 'onM1', 'onM2', 'onLoose', 'dangling'])
  })
  test('a group shows its own and its members\' comments, members labelled', () => {
    const t = commentThread(comments, subs, 'g')
    expect(t.map(e => e.comment.id)).toEqual(['onGroup', 'onM1', 'onM2'])
    expect(t[0]!.via).toBeNull()
    expect(t[1]!.via).toEqual({ kind: 'subtask', id: 'm1', title: 'Member one' })
  })
  test('a member shows only its own — never its group\'s or a sibling\'s', () => {
    expect(ids('m1')).toEqual(['onM1'])
  })
  test('a loose subtask shows only its own', () => {
    expect(ids('l')).toEqual(['onLoose'])
  })
  test('the task thread labels non-task comments and leaves its own unlabelled', () => {
    const t = commentThread(comments, subs, null)
    expect(t.find(e => e.comment.id === 'legacy')!.via).toBeNull()
    expect(t.find(e => e.comment.id === 'dangling')!.via).toBeNull()
    expect(t.find(e => e.comment.id === 'onLoose')!.via?.title).toBe('Loose')
  })
})

describe('commentCounts — a count is the size of the thread it opens', () => {
  test('matches commentThread for every target', () => {
    const counts = commentCounts(comments, subs)
    expect(counts.task).toBe(commentThread(comments, subs, null).length)
    for (const s of subs) {
      expect(counts.bySubtask[s.id] ?? 0).toBe(commentThread(comments, subs, s.id).length)
    }
    expect(counts.bySubtask.g).toBe(3)
  })
})

describe('commentsByTarget — the API shape', () => {
  test('own comments only, task first, empty targets omitted', () => {
    const g = commentsByTarget(comments, subs)
    expect(g.map(x => [x.target.kind, x.target.id, x.comments.map(y => y.id)])).toEqual([
      ['task', null, ['legacy', 'dangling']],
      ['group', 'g', ['onGroup']],
      ['subtask', 'm1', ['onM1']],
      ['subtask', 'm2', ['onM2']],
      ['subtask', 'l', ['onLoose']],
    ])
  })
})
