/**
 * The cached `/api/tasks` read against the real store (the `bun test` data dir is a fresh temp dir).
 * The same invalidation cases as the live line: a write is visible at once, and a split load
 * carries the same totals as the whole.
 */
import { describe, expect, test } from 'bun:test'
import { createTask, editTask, listTasks, markTask, addComment } from './task-web'

const titles = async (opts = {}) => (await listTasks(undefined, opts)).tasks.map(r => r.task.title)

describe('listTasks cache', () => {
  test('a created task shows on the very next read (a book write drops the cache)', async () => {
    await listTasks()
    const t = await createTask({ title: 'cache-create' })
    expect(await titles()).toContain('cache-create')
    expect(t).not.toBeNull()
  })
  test('a status change is visible at once', async () => {
    const t = await createTask({ title: 'cache-status' })
    await listTasks()
    await markTask(t!.id, 'in_progress')
    expect((await listTasks()).tasks.find(r => r.task.id === t!.id)?.task.status).toBe('in_progress')
  })
  test('a comment moves the count at once', async () => {
    const t = await createTask({ title: 'cache-comment' })
    const before = (await listTasks()).tasks.find(r => r.task.id === t!.id)!.counts.comments
    await addComment(t!.id, { author: 'me', body: 'hi' })
    expect((await listTasks()).tasks.find(r => r.task.id === t!.id)!.counts.comments).toBe(before + 1)
  })
  test('a different filter is a different entry', async () => {
    const all = await listTasks()
    const scoped = await listTasks({ harnesses: ['no-such-harness'] })
    expect(scoped.tasks.length).toBe(all.tasks.length)
    expect(scoped.excludedByFilter).toBeGreaterThanOrEqual(0)
  })
})

describe('the split load', () => {
  test('both steps carry the same total and overview; step one is flagged partial', async () => {
    const t = await createTask({ title: 'split-done' })
    await markTask(t!.id, 'in_progress')
    const whole = await listTasks(undefined, { clip: true })
    const first = await listTasks(undefined, { recent: true, clip: true })
    expect(first.partial).toBe(true)
    expect(whole.partial).toBeUndefined()
    expect(first.total).toBe(whole.tasks.length)
    expect(first.overview).toEqual(whole.overview)
    expect(first.tasks.length).toBeLessThanOrEqual(whole.tasks.length)
    expect(first.tasks.map(r => r.task.id).every(id => whole.tasks.some(r => r.task.id === id))).toBe(true)
  })
  test('the clipped list leaves the long description whole for callers that ask for it', async () => {
    const long = 'y'.repeat(900)
    const t = await createTask({ title: 'split-long', detail: long })
    const clipped = (await listTasks(undefined, { clip: true })).tasks.find(r => r.task.id === t!.id)!
    const raw = (await listTasks()).tasks.find(r => r.task.id === t!.id)!
    expect(clipped.detailClipped).toBe(true)
    expect(clipped.task.detail!.length).toBeLessThan(long.length)
    expect(raw.task.detail).toBe(long)
    await editTask(t!.id, { title: 'split-long-2' })
    expect(await titles({ clip: true })).toContain('split-long-2')
  })
})
